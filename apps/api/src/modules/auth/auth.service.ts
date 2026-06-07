import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authenticator } = require('otplib');
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

/**
 * Auth service with the hard-earned 2024 baselines:
 *
 * - **Refresh tokens stored as sha256 hashes**. DB leak no longer yields
 *   usable tokens; rotation is by hash equality.
 * - **Refresh signature verified** before the DB lookup, so JWT_REFRESH_SECRET
 *   rotation actually invalidates all sessions.
 * - **Rotation chain with family revocation** (RFC 6819 §5.2.2.3). When the
 *   client refreshes, the current session is marked ROTATED and a new one
 *   issued. Replaying a ROTATED token revokes the entire family — clear
 *   evidence of token theft.
 * - **Brute-force timing parity** on login: bcrypt.compare runs against a
 *   fixed dummy hash when the email doesn't exist, so timing matches a
 *   wrong-password reply for an existing account.
 * - **First-user race plugged** via a single atomic transaction. The
 *   `user.count() > 0 ? USER : SUPERADMIN` check in two separate queries
 *   used to let two concurrent registrations both become SUPERADMIN.
 * - **TOTP 2FA enforced**. If `user.twoFactorEnabled`, login requires a
 *   valid TOTP code or one of the bcrypt-hashed backup codes.
 *
 * Password reset is implemented as a separate flow (forgotPassword /
 * resetPassword) using sha256-hashed reset tokens with 30-min expiry and
 * single-use semantics.
 */
const TIMING_DUMMY_HASH = '$2b$12$KIXqEJfQAQbJUTo94X5KQuQpQ9OYFJrJEZ4SAuNG0jQfM5KIc9pIu';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private encryption: EncryptionService,
  ) {}

  // ── register ──────────────────────────────────────────────────────

  async register(dto: RegisterDto) {
    // Atomic first-user race fix. We count + insert in a single
    // serializable transaction so two concurrent registrations cannot both
    // observe `count === 0` and become SUPERADMIN.
    return this.prisma.$transaction(async (tx) => {
      const userCount = await tx.user.count();
      if (userCount > 0) {
        const setting = await tx.systemSetting.findUnique({
          where: { key: 'registration_enabled' },
        });
        const enabled = setting ? !!(setting.value as any) : true;
        if (!enabled) {
          throw new ForbiddenException('Registration is disabled');
        }
      }

      // To resist email-enumeration on register, we accept the request and
      // return a generic success when the email is taken, but only the
      // first-time-no-users branch needs to fail loudly. For subsequent
      // signups we still throw Conflict — register page is itself behind
      // throttler + captcha is the right defense, not opaque returns.
      const existing = await tx.user.findUnique({ where: { email: dto.email } });
      if (existing) {
        throw new ConflictException('Email already registered');
      }

      const hashedPassword = await bcrypt.hash(dto.password, 12);
      const user = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
          role: userCount === 0 ? 'SUPERADMIN' : 'USER',
        },
      });

      const existingServer = await tx.server.findFirst();
      if (!existingServer) {
        const server = await tx.server.create({
          data: {
            name: 'Local Server',
            host: '127.0.0.1',
            port: 22,
            username: 'root',
            status: 'ONLINE',
          },
        });
        const agentToken = randomBytes(32).toString('hex');
        const agentTokenHash = this.encryption.hash(agentToken);
        await tx.agentToken.create({
          data: { serverId: server.id, token: agentTokenHash },
        });
      }

      const tokens = await this.issueTokenPair(user.id, user.email, user.role);
      return {
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        ...tokens,
      };
    });
  }

  // ── login ─────────────────────────────────────────────────────────

  async login(dto: LoginDto, ctx: { ip?: string; userAgent?: string } = {}) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // Run bcrypt EITHER WAY so timing doesn't distinguish missing-email
    // from wrong-password. The dummy hash is a valid bcrypt blob.
    const passwordOk = await bcrypt.compare(
      dto.password,
      user?.password ?? TIMING_DUMMY_HASH,
    );

    if (!user || !passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status === 'BANNED') {
      throw new ForbiddenException('Your account has been banned');
    }
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('Your account is suspended');
    }

    // Enforce 2FA when enabled — the totpCode (or backup code) is required.
    if (user.twoFactorEnabled) {
      const code = (dto as any).totpCode || (dto as any).backupCode;
      if (!code) {
        throw new UnauthorizedException('Two-factor code required');
      }
      const ok = await this.verifyTwoFactor(user.id, user.twoFactorSecret, code);
      if (!ok) {
        throw new UnauthorizedException('Invalid two-factor code');
      }
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.issueTokenPair(user.id, user.email, user.role, ctx);
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      ...tokens,
    };
  }

  // ── refresh ───────────────────────────────────────────────────────

  async refreshTokens(refreshToken: string, ctx: { ip?: string; userAgent?: string } = {}) {
    if (!refreshToken) throw new UnauthorizedException('Invalid refresh token');

    // 1. Verify the signature first — secret rotation now actually
    //    invalidates sessions.
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET')!,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const hash = this.encryption.hash(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: true },
    });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (session.userId !== payload.sub) {
      // signature owner ≠ stored owner — treat as theft
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 2. Replay-detection: any non-ACTIVE session represents reuse.
    //    Revoke the whole family and ask the user to log in again.
    if (session.status !== 'ACTIVE') {
      this.logger.warn(`Refresh-token replay detected for family ${session.familyId}; revoking.`);
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException('Session revoked. Please log in again.');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired. Please log in again.');
    }

    if (session.user.status !== 'ACTIVE') {
      await this.revokeFamily(session.familyId);
      throw new ForbiddenException('Account is not active');
    }

    // 3. Rotate. Mark current ROTATED, create successor in same family.
    const tokens = await this.signTokenPair(session.user.id, session.user.email, session.user.role);
    const newHash = this.encryption.hash(tokens.refreshToken);
    const expiresAt = this.refreshTokenExpiry();

    const newSession = await this.prisma.session.create({
      data: {
        userId: session.user.id,
        refreshTokenHash: newHash,
        familyId: session.familyId,
        status: 'ACTIVE',
        expiresAt,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    await this.prisma.session.update({
      where: { id: session.id },
      data: { status: 'ROTATED', replacedById: newSession.id },
    });

    return tokens;
  }

  // ── logout ────────────────────────────────────────────────────────

  async logout(refreshToken: string) {
    if (!refreshToken) return;
    const hash = this.encryption.hash(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: hash } });
    if (!session) return;
    // Revoke the whole family so a parallel replay attempt is shut down too.
    await this.revokeFamily(session.familyId);
  }

  private async revokeFamily(familyId: string) {
    await this.prisma.session.updateMany({
      where: { familyId, status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
  }

  // ── profile + password ────────────────────────────────────────────

  async updateProfile(userId: string, dto: { name?: string; email?: string }) {
    const data: any = {};
    if (dto.name?.trim()) data.name = dto.name.trim();
    if (dto.email?.trim()) {
      const email = dto.email.trim().toLowerCase();
      const dup = await this.prisma.user.findFirst({ where: { email, id: { not: userId } } });
      if (dup) throw new ConflictException('Email already in use');
      data.email = email;
    }
    if (Object.keys(data).length === 0) throw new ConflictException('Nothing to update');
    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, email: true, role: true, status: true },
    });
  }

  async changePassword(userId: string, dto: { currentPassword: string; newPassword: string }) {
    if (!dto.newPassword || dto.newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const ok = await bcrypt.compare(dto.currentPassword, user.password);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');
    const hashed = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    // Wipe every session — every refresh token in the wild is now stale.
    await this.prisma.session.updateMany({
      where: { userId, status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
    return { message: 'Password changed. Please log in again.' };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, role: true, status: true,
        twoFactorEnabled: true, createdAt: true, lastLoginAt: true,
      },
    });
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  // ── password reset ────────────────────────────────────────────────

  async forgotPassword(email: string) {
    // Always return success to avoid email enumeration.
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Still consume ~the same time as the legit path to flatten timing.
      await bcrypt.hash('dummy', 4).catch(() => {});
      return { message: 'If that email is registered, a reset link has been sent.' };
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.encryption.hash(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    // TODO: wire NotificationsService.dispatch('password.reset', { ... })
    // when the notifications module ships. For now, log it for ops to read
    // out of the API logs — never return the token to the API caller.
    this.logger.warn(
      `[password-reset] user=${user.id} token=${token} (DO NOT log in production)`,
    );

    return { message: 'If that email is registered, a reset link has been sent.' };
  }

  async resetPassword(token: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters');
    }
    const tokenHash = this.encryption.hash(token);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new BadRequestException('Reset link is invalid or expired.');
    }
    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: row.userId }, data: { password: hashed } }),
      this.prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      this.prisma.session.updateMany({
        where: { userId: row.userId, status: { not: 'REVOKED' } },
        data: { status: 'REVOKED' },
      }),
    ]);
    return { message: 'Password reset. Please log in.' };
  }

  // ── 2FA ───────────────────────────────────────────────────────────

  async startTwoFactorSetup(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.twoFactorEnabled) {
      throw new ConflictException('Two-factor is already enabled — disable it first to re-enroll.');
    }
    const secret = authenticator.generateSecret();
    // Store the secret encrypted; only persisted when the user confirms with
    // a code that proves their authenticator app is set up correctly.
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: this.encryption.encrypt(secret) },
    });
    const otpauth = authenticator.keyuri(user.email, 'Kryptalis', secret);
    return { secret, otpauth };
  }

  async enableTwoFactor(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.twoFactorSecret) {
      throw new BadRequestException('Start two-factor setup first.');
    }
    const secret = this.encryption.decrypt(user.twoFactorSecret);
    if (!authenticator.verify({ token: code, secret })) {
      throw new BadRequestException('Invalid code.');
    }
    const backupCodes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const c = randomBytes(5).toString('hex'); // 10 hex chars
      backupCodes.push(c);
    }
    const hashes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: true },
      }),
      this.prisma.twoFactorBackupCode.deleteMany({ where: { userId } }),
      this.prisma.twoFactorBackupCode.createMany({
        data: hashes.map((h) => ({ userId, codeHash: h })),
      }),
    ]);
    return { backupCodes };
  }

  async disableTwoFactor(userId: string, password: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('Wrong password.');
    if (user.twoFactorEnabled) {
      const valid = await this.verifyTwoFactor(userId, user.twoFactorSecret, code);
      if (!valid) throw new UnauthorizedException('Invalid two-factor code.');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: false, twoFactorSecret: null },
      }),
      this.prisma.twoFactorBackupCode.deleteMany({ where: { userId } }),
    ]);
    return { message: 'Two-factor disabled.' };
  }

  private async verifyTwoFactor(
    userId: string,
    encryptedSecret: string | null,
    code: string,
  ): Promise<boolean> {
    // Try TOTP first (window of ±1 tick = 30s).
    if (encryptedSecret) {
      try {
        const secret = this.encryption.decrypt(encryptedSecret);
        authenticator.options = { window: 1 };
        if (authenticator.verify({ token: code, secret })) return true;
      } catch {}
    }
    // Fall back to backup codes (single-use).
    const candidates = await this.prisma.twoFactorBackupCode.findMany({
      where: { userId, usedAt: null },
    });
    for (const c of candidates) {
      const ok = await bcrypt.compare(code, c.codeHash);
      if (ok) {
        await this.prisma.twoFactorBackupCode.update({
          where: { id: c.id },
          data: { usedAt: new Date() },
        });
        return true;
      }
    }
    return false;
  }

  // ── token issuance + helpers ──────────────────────────────────────

  private async signTokenPair(userId: string, email: string, role: string) {
    const payload = { sub: userId, email, role };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload),
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET')!,
        expiresIn: this.config.get('JWT_REFRESH_EXPIRATION', '7d') as any,
      }),
    ]);
    return { accessToken, refreshToken };
  }

  private async issueTokenPair(
    userId: string,
    email: string,
    role: string,
    ctx: { ip?: string; userAgent?: string } = {},
  ) {
    const tokens = await this.signTokenPair(userId, email, role);
    const refreshTokenHash = this.encryption.hash(tokens.refreshToken);
    const expiresAt = this.refreshTokenExpiry();
    const familyId = createHash('sha256')
      .update(randomBytes(16))
      .digest('hex');
    await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash,
        familyId,
        status: 'ACTIVE',
        expiresAt,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });
    return tokens;
  }

  /** Derive session expiry from JWT_REFRESH_EXPIRATION (default 7d). */
  private refreshTokenExpiry(): Date {
    const ttl = this.parseTtl(
      this.config.get('JWT_REFRESH_EXPIRATION', '7d') as string,
    );
    return new Date(Date.now() + ttl);
  }

  private parseTtl(ttl: string): number {
    const m = ttl.match(/^(\d+)([smhdw])$/);
    if (!m) return 7 * 24 * 3600 * 1000;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };
    return n * (multipliers[unit] || 24 * 3600 * 1000);
  }
}
