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
import { NotificationsService } from '../notifications/notifications.service';
// otplib v13 reshuffled the API and dropped the `authenticator` singleton —
// pinned to v12 in package.json where `authenticator.verify({token, secret})`
// is the canonical entrypoint. Set window once at module load instead of
// mutating per-request.
import { authenticator } from 'otplib';
authenticator.options = { window: 1 };
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
    // Injected from the @Global NotificationsModule — no module-level
    // import required here, which keeps Auth/Notifications mutually
    // dep-free if NotificationsService ever needs to read from
    // AuthService (e.g. to honour per-user mail preferences).
    private notifications: NotificationsService,
  ) {}

  // ── setup status ──────────────────────────────────────────────────
  //
  // The dashboard's landing page hits this BEFORE choosing /login vs
  // /register. On a fresh install (no users yet) we want to send the
  // operator straight to /register with a "you're about to become the
  // SUPERADMIN" notice. After the first signup the wizard goes away.
  //
  // We additionally check the BOOTSTRAP_DONE setting so that a fully
  // re-seeded DB after an emergency reset doesn't re-open the bootstrap
  // — same flag the register() method already consults.

  async getSetupStatus(): Promise<{ needsSetup: boolean }> {
    const userCount = await this.prisma.user.count();
    if (userCount > 0) return { needsSetup: false };
    // Belt + suspenders: even at 0 users, if BOOTSTRAP_DONE was set we
    // refuse to declare needsSetup=true. Operator must use `prisma
    // studio` or a SQL console to reopen — protects against a
    // misconfigured DB drop accidentally letting someone register as
    // SUPERADMIN.
    try {
      const flag = await this.prisma.systemSetting.findUnique({
        where: { key: 'BOOTSTRAP_DONE' },
      });
      if (flag) return { needsSetup: false };
    } catch {}
    return { needsSetup: true };
  }

  // ── register ──────────────────────────────────────────────────────

  async register(dto: RegisterDto, ctx: { ip?: string; userAgent?: string } = {}) {
    // Normalize email at the boundary so case-variants can't register as
    // separate accounts. Postgres's @unique is case-sensitive by default.
    const email = (dto.email || '').trim().toLowerCase();
    if (!email) throw new BadRequestException('Email is required');

    // Atomic first-user race fix. Default Prisma/Postgres isolation is
    // READ COMMITTED — count() takes no lock, so two concurrent register()
    // could both observe userCount===0 and both insert with role=SUPERADMIN.
    // Serializable causes one of the two to abort with a serialization
    // error; the loser is rolled back and a second attempt sees the right
    // count.
    const txResult = await this.prisma.$transaction(async (tx) => {
      // First-user bootstrap is a SINGLE-SHOT event. Once we've ever
      // promoted a SUPERADMIN, that fact is recorded in SystemSetting
      // and the userCount===0 fallback can NEVER be reentered — even if
      // every user gets deleted, restoring from a partial DB dump can't
      // re-trigger an unauthenticated SUPERADMIN escalation.
      const bootstrappedSetting = await tx.systemSetting.findUnique({
        where: { key: 'bootstrapped' },
      });
      const isBootstrapped = !!(bootstrappedSetting?.value as any);

      // If bootstrapped, registration_enabled rules. If NOT yet bootstrapped
      // and userCount===0 (first install), we let the registrant through
      // to become SUPERADMIN regardless of the setting.
      const userCount = await tx.user.count();
      const isBootstrapPath = !isBootstrapped && userCount === 0;

      if (!isBootstrapPath) {
        const setting = await tx.systemSetting.findUnique({
          where: { key: 'registration_enabled' },
        });
        const enabled = setting ? !!(setting.value as any) : true;
        if (!enabled) {
          throw new ForbiddenException('Registration is disabled');
        }
      }

      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) {
        throw new ConflictException('Email already registered');
      }

      const strength = this.isStrongEnough(dto.password);
      if (!strength.ok) {
        throw new BadRequestException(strength.reason);
      }

      const hashedPassword = await bcrypt.hash(dto.password, 12);
      const user = await tx.user.create({
        data: {
          name: dto.name,
          email,
          password: hashedPassword,
          role: isBootstrapPath ? 'SUPERADMIN' : 'USER',
          // Bootstrap path stays auto-ACTIVE — it's the install flow with no
          // SMTP wired yet, so an email round-trip is structurally impossible.
          // Every other registration starts PENDING_VERIFICATION until the
          // user proves inbox control via /auth/verify-email.
          status: isBootstrapPath ? 'ACTIVE' : 'PENDING_VERIFICATION',
        },
      });

      if (isBootstrapPath) {
        // Lock the bootstrap door behind us. Any future userCount===0 path
        // will see bootstrapped=true and require registration_enabled.
        await tx.systemSetting.upsert({
          where: { key: 'bootstrapped' },
          create: { key: 'bootstrapped', value: true as any, updatedBy: user.id },
          update: { value: true as any, updatedBy: user.id },
        });
      }

      // Bootstrap the in-process local server row + its hashed agent token
      // — but ONLY on first ever install (the same trigger as the SUPERADMIN
      // bootstrap). Subsequent registrations don't touch tenant
      // provisioning. The raw agent token is unused (LOCAL mode shells out
      // directly); admins regenerate it on demand via the Servers UI.
      if (isBootstrapPath) {
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

      // Bootstrap path = install flow: no email round-trip possible, so we
      // hand back tokens immediately just like the legacy behavior. Every
      // other registrant gets PENDING_VERIFICATION + a verification token
      // mailed/console-logged; they must round-trip /auth/verify-email
      // before login() will work.
      if (isBootstrapPath) {
        // Pass the tx client so Session.userId can see the just-created
        // User row inside the same transaction (FK would otherwise fail).
        const tokens = await this.issueTokenPair(user.id, user.email, user.role, ctx, tx);
        return {
          bootstrap: true as const,
          response: {
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
            ...tokens,
          },
        };
      }

      const rawToken = randomBytes(32).toString('base64url');
      const tokenHash = this.encryption.hash(rawToken);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await tx.emailVerificationToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
      });

      // Return the verification payload so SMTP send happens AFTER the
      // transaction commits. Network I/O inside a Serializable tx holds
      // the snapshot open across the SMTP round-trip and inflates
      // conflict-retry chances; also avoids the rollback-but-email-sent
      // race when the tx aborts after the send.
      return {
        bootstrap: false as const,
        response: {
          message: 'Check your email to verify your account',
          user: { id: user.id, name: user.name, email: user.email },
        },
        pendingVerification: {
          email: user.email,
          name: user.name,
          rawToken,
        },
      };
    }, { isolationLevel: 'Serializable' });

    // ── post-commit side effects ────────────────────────────────────
    // Bootstrap path returns tokens directly. Non-bootstrap path needs
    // to (a) log the dev-only verification token + (b) send the email.
    // Both happen AFTER the Serializable tx commits so SMTP latency
    // never holds the snapshot open and a rollback never leaves a
    // sent-but-unrecorded verification mail behind.
    if (!txResult.bootstrap && txResult.pendingVerification) {
      const { email, name, rawToken } = txResult.pendingVerification;
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(
          '[dev] email verification token for ' + email + ': ' + rawToken +
          ' (this log is GATED to NODE_ENV !== production)',
        );
      }
      try {
        await this.notifications.sendEmailVerification(email, rawToken, name);
      } catch {}
    }

    return txResult.response;
  }

  // ── email verification ────────────────────────────────────────────

  async verifyEmail(rawToken: string, ctx: { ip?: string; userAgent?: string } = {}) {
    if (!rawToken) throw new BadRequestException('Verification link is invalid or expired.');
    const tokenHash = this.encryption.hash(rawToken);
    const row = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new BadRequestException('Verification link is invalid or expired.');
    }
    // Atomically flip the user to ACTIVE and consume the token. If the
    // user is already ACTIVE we still mark the token used so it can't be
    // replayed — but we don't downgrade status (e.g. BANNED stays BANNED).
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      ...(row.user.status === 'PENDING_VERIFICATION'
        ? [this.prisma.user.update({
            where: { id: row.userId },
            data: { status: 'ACTIVE' as any },
          })]
        : []),
    ]);

    if (row.user.status === 'BANNED' || row.user.status === 'SUSPENDED') {
      throw new ForbiddenException('Account is not active');
    }

    const tokens = await this.issueTokenPair(row.user.id, row.user.email, row.user.role, ctx);
    return {
      user: { id: row.user.id, name: row.user.name, email: row.user.email, role: row.user.role },
      ...tokens,
    };
  }

  /**
   * Resend a verification email. Always returns generic success so an
   * unauthenticated caller can't enumerate which addresses are registered
   * — the per-IP throttler (3/hour) is the real anti-abuse layer.
   */
  async resendVerification(emailRaw: string) {
    const email = (emailRaw || '').trim().toLowerCase();
    const GENERIC = { message: 'If that email needs verification, a new link has been sent.' };
    if (!email) return GENERIC;
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'PENDING_VERIFICATION') return GENERIC;

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.encryption.hash(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        '[dev] email verification token for ' + user.email + ': ' + rawToken +
        ' (this log is GATED to NODE_ENV !== production)',
      );
    }
    try {
      await this.notifications.sendEmailVerification(user.email, rawToken, user.name);
    } catch {}
    return GENERIC;
  }

  // ── login ─────────────────────────────────────────────────────────

  async login(dto: LoginDto, ctx: { ip?: string; userAgent?: string } = {}) {
    const email = (dto.email || '').trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Run bcrypt EITHER WAY so timing doesn't distinguish missing-email
    // from wrong-password. The dummy hash is a valid bcrypt blob.
    const passwordOk = await bcrypt.compare(
      dto.password,
      user?.password ?? TIMING_DUMMY_HASH,
    );

    if (!user || !passwordOk) {
      // Increment the failed counter (no-op if user doesn't exist) so
      // credential-stuffing rotating IPs still hits the per-account lock.
      if (user) await this.bumpFailedAttempt(user.id);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status === 'BANNED') {
      throw new ForbiddenException('Your account has been banned');
    }
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('Your account is suspended');
    }
    if (user.status === 'PENDING_VERIFICATION') {
      throw new ForbiddenException('Email not verified');
    }

    // Account-level lockout. After 5 failed password OR TOTP attempts the
    // account is frozen for 15 min — independent of per-IP throttler so
    // credential stuffing across rotated IPs is mitigated.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(
        `Account temporarily locked due to repeated failed attempts. Try again in ${minutes} minute(s).`,
      );
    }

    // Enforce 2FA when enabled — the totpCode (or backup code) is required.
    if (user.twoFactorEnabled) {
      const code = (dto as any).totpCode || (dto as any).backupCode;
      if (!code) {
        throw new UnauthorizedException('Two-factor code required');
      }
      const ok = await this.verifyTwoFactor(user.id, user.twoFactorSecret, code, {
        forBackup: !!(dto as any).backupCode,
      });
      if (!ok) {
        await this.bumpFailedAttempt(user.id);
        throw new UnauthorizedException('Invalid two-factor code');
      }
    }

    // Reset counter on successful login.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
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

    // 3. Atomic rotation via compare-and-set. We MUST claim the parent
    //    session (set ACTIVE→ROTATED) before issuing the successor. If
    //    two concurrent refreshes arrive with the same token, only one
    //    sees the CAS succeed (count===1) — the other loses the race and
    //    we revoke the whole family, because losing the race means
    //    SOMETHING else successfully rotated, which is exactly the
    //    "token used twice" signal RFC 6819 §5.2.2.3 expects.
    const expiresAt = this.refreshTokenExpiry();
    // Create the successor row FIRST (with a placeholder hash) so we can
    // embed its id in the access-token payload. The placeholder hash is a
    // sha256 of random bytes — guaranteed not to collide with any real
    // refresh token, so it cannot be exchanged. We overwrite it with the
    // real refresh-token hash once the CAS wins.
    const placeholderHash = this.encryption.hash(randomBytes(32).toString('hex'));
    const successor = await this.prisma.session.create({
      data: {
        userId: session.user.id,
        refreshTokenHash: placeholderHash,
        familyId: session.familyId,
        status: 'PENDING' as any, // not loggable-with yet
        expiresAt,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    const tokens = await this.signTokenPair(
      session.user.id,
      session.user.email,
      session.user.role,
      successor.id,
    );
    const newHash = this.encryption.hash(tokens.refreshToken);

    const cas = await this.prisma.session.updateMany({
      where: { id: session.id, status: 'ACTIVE' },
      data: { status: 'ROTATED', replacedById: successor.id },
    });

    if (cas.count === 0) {
      // Lost the race → someone else already rotated this token. That's a
      // replay. Burn the family and the half-built successor.
      await this.prisma.session.delete({ where: { id: successor.id } }).catch(() => {});
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException('Session revoked. Please log in again.');
    }

    // Flip the successor to ACTIVE and write the real refresh-token hash
    // only after the CAS won — keeps the window where two ACTIVE rows
    // share a family arbitrarily small.
    await this.prisma.session.update({
      where: { id: successor.id },
      data: { status: 'ACTIVE', refreshTokenHash: newHash },
    });

    return tokens;
  }

  // ── sessions (list / revoke) ──────────────────────────────────────

  async listSessions(userId: string, currentSessionId?: string | null) {
    const rows = await this.prisma.session.findMany({
      where: {
        userId,
        status: { in: ['ACTIVE' as any, 'PENDING' as any] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });
    return rows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      isCurrent: currentSessionId ? s.id === currentSessionId : false,
    }));
  }

  async revokeSession(userId: string, sessionId: string, currentSessionId?: string | null) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new UnauthorizedException('Session not found');
    }
    const isCurrent = currentSessionId && session.id === currentSessionId;
    if (isCurrent) {
      // Revoking the current session is treated as "log out everywhere
      // else" — we keep the current session alive so the caller's
      // dashboard tab doesn't get bumped to /login mid-action.
      await this.prisma.session.updateMany({
        where: {
          userId,
          id: { not: currentSessionId! },
          status: { not: 'REVOKED' as any },
        },
        data: { status: 'REVOKED' as any },
      });
      return { revoked: true, keptCurrent: true };
    }
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { status: 'REVOKED' as any },
    });
    return { revoked: true, keptCurrent: false };
  }

  async revokeOtherSessions(userId: string, currentSessionId?: string | null) {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        ...(currentSessionId ? { id: { not: currentSessionId } } : {}),
        status: { not: 'REVOKED' as any },
      },
      data: { status: 'REVOKED' as any },
    });
    return { revoked: result.count };
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

  async changePassword(
    userId: string,
    dto: { currentPassword: string; newPassword: string; totpCode?: string; backupCode?: string },
  ) {
    const strength = this.isStrongEnough(dto.newPassword);
    if (!strength.ok) {
      throw new BadRequestException(strength.reason);
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const ok = await bcrypt.compare(dto.currentPassword, user.password);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    // Symmetric with disableTwoFactor(): a sensitive credential change must
    // re-verify the second factor when one is set. A phished current
    // password alone shouldn't unlock the keys to the kingdom.
    if (user.twoFactorEnabled) {
      const code = dto.totpCode || dto.backupCode;
      if (!code) {
        throw new UnauthorizedException('Two-factor code required to change password');
      }
      const validTotp = await this.verifyTwoFactor(userId, user.twoFactorSecret, code, {
        forBackup: !!dto.backupCode,
      });
      if (!validTotp) {
        throw new UnauthorizedException('Invalid two-factor code');
      }
    }

    const hashed = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    // Wipe every session — every refresh token in the wild is now stale.
    await this.prisma.session.updateMany({
      where: { userId, status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
    return { message: 'Password changed. Please log in again.' };
  }

  /**
   * Increment failed-login counter; lock the account at threshold. Used by
   * BOTH the password and TOTP branches of login so brute-force is
   * mitigated regardless of which factor the attacker is grinding.
   */
  private async bumpFailedAttempt(userId: string) {
    const THRESHOLD = 5;
    const LOCK_MINUTES = 15;
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    if (u.failedLoginAttempts >= THRESHOLD) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
      });
    }
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

  // ── onboarding ────────────────────────────────────────────────────

  /** Per-user onboarding completion flag, stored in SystemSetting under
   *  `onboarding_completed_<userId>`. We namespace per-user so multiple
   *  SUPERADMINs each see the wizard once, and so wiping the flag for a
   *  single user (rerun the tour) doesn't disturb others. */
  private onboardingKey(userId: string) {
    return `onboarding_completed_${userId}`;
  }

  async getOnboarding(userId: string): Promise<{ completed: boolean }> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: this.onboardingKey(userId) },
    });
    return { completed: !!(row?.value as any) };
  }

  async completeOnboarding(userId: string): Promise<{ completed: true }> {
    await this.prisma.systemSetting.upsert({
      where: { key: this.onboardingKey(userId) },
      create: { key: this.onboardingKey(userId), value: true as any, updatedBy: userId },
      update: { value: true as any, updatedBy: userId },
    });
    return { completed: true };
  }

  // ── password reset ────────────────────────────────────────────────

  async forgotPassword(emailRaw: string) {
    const email = (emailRaw || '').trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Same return — the rate limiter is the real defense against enumeration.
      return { message: 'If that email is registered, a reset link has been sent.' };
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.encryption.hash(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    // Hand off to NotificationsService. It owns:
    //   - SMTP transport + no-op fallback when unconfigured
    //   - dev-mode token logging (gated on NODE_ENV !== production)
    // so we keep the auth flow clean. Errors are swallowed inside the
    // service — we don't want a misconfigured mail relay to leak the
    // existence of a registered email back to the client.
    await this.notifications.sendPasswordReset(user.email, token, user.name);

    return { message: 'If that email is registered, a reset link has been sent.' };
  }

  async resetPassword(
    token: string,
    newPassword: string,
    twoFactor?: { totpCode?: string; backupCode?: string },
  ) {
    const strength = this.isStrongEnough(newPassword);
    if (!strength.ok) {
      throw new BadRequestException(strength.reason);
    }
    const tokenHash = this.encryption.hash(token);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new BadRequestException('Reset link is invalid or expired.');
    }

    // If the account has 2FA enabled, do NOT let an email-based reset
    // bypass it. The attacker who controls the inbox still has to prove
    // possession of the authenticator or a backup code. This closes the
    // 'inbox-takeover → full account' path.
    if (row.user.twoFactorEnabled) {
      const code = twoFactor?.totpCode || twoFactor?.backupCode;
      if (!code) {
        throw new BadRequestException('Two-factor code required to reset password.');
      }
      const ok = await this.verifyTwoFactor(row.user.id, row.user.twoFactorSecret, code, {
        forBackup: !!twoFactor?.backupCode,
      });
      if (!ok) {
        throw new UnauthorizedException('Invalid two-factor code.');
      }
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
    // 80 bits of entropy per code (matches GitHub / Google Authenticator
    // baseline). The previous 40-bit hex code was within reach of online
    // grinding once the account-lockout was bypassed.
    // 80 bits per code. The user sees the dashed form for legibility, but
    // verifyBackupCode() strips dashes/spaces before comparing, so we
    // bcrypt-hash the canonical un-dashed string to keep both inputs
    // equivalent regardless of how the user types them.
    const display: string[] = [];
    const canonical: string[] = [];
    for (let i = 0; i < 10; i++) {
      const raw = randomBytes(10).toString('hex'); // 20 hex chars → 80 bits
      canonical.push(raw);
      display.push(raw.match(/.{1,5}/g)!.join('-'));
    }
    const hashes = await Promise.all(canonical.map((c) => bcrypt.hash(c, 10)));
    const backupCodes = display;
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
      // Accept TOTP OR a backup code — distinguished by length/charset.
      // Backup codes are 80-bit hex grouped with dashes ("ab12c-de34f-...").
      const stripped = code.replace(/-/g, '');
      const looksLikeBackup = /^[0-9a-f]{10,}$/i.test(stripped);
      const valid = await this.verifyTwoFactor(userId, user.twoFactorSecret, code, {
        forBackup: looksLikeBackup,
      });
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
    opts: { forBackup?: boolean } = {},
  ): Promise<boolean> {
    // Caller has told us whether they expect a TOTP or a backup code, so
    // we don't burn 10 × bcrypt.compare on a 6-digit numeric attempt that
    // was always meant for the TOTP path (a trivial CPU-DoS amplifier
    // otherwise).
    if (opts.forBackup) {
      return this.verifyBackupCode(userId, code);
    }
    if (encryptedSecret) {
      try {
        const secret = this.encryption.decrypt(encryptedSecret);
        if (authenticator.verify({ token: code, secret })) return true;
      } catch {}
    }
    return false;
  }

  /**
   * Backup-code path. bcrypt.compares are run in parallel so wall-time
   * doesn't depend on which slot matched (timing leak) and the user
   * doesn't pay the full N × cost-10 sequentially. We mark exactly one
   * matched code as used (the first hit).
   */
  private async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    // Normalize so users can type with or without dashes/spaces.
    const norm = (code || '').replace(/[-\s]/g, '').toLowerCase();
    if (!norm) return false;
    const candidates = await this.prisma.twoFactorBackupCode.findMany({
      where: { userId, usedAt: null },
    });
    const results = await Promise.all(
      candidates.map((c) => bcrypt.compare(norm, c.codeHash).then((ok) => ({ id: c.id, ok }))),
    );
    const matched = results.find((r) => r.ok);
    if (!matched) return false;
    await this.prisma.twoFactorBackupCode.update({
      where: { id: matched.id },
      data: { usedAt: new Date() },
    });
    return true;
  }

  // ── token issuance + helpers ──────────────────────────────────────

  private async signTokenPair(userId: string, email: string, role: string, sessionId?: string) {
    // Embed sessionId in the access-token payload so authenticated requests
    // can be tied back to the row in `sessions` (needed by the session
    // list/revoke endpoints to flag isCurrent). The refresh token gets it
    // too, but only as a debugging convenience — refresh-flow lookups are
    // still by sha256(refreshToken).
    const payload: Record<string, unknown> = { sub: userId, email, role };
    if (sessionId) payload.sid = sessionId;
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
    // Optional transaction client. When set (caller is inside a
    // $transaction), session writes go through the tx so the FK to
    // a freshly-created User row resolves AND the writes roll back
    // with the rest if the outer tx aborts. When omitted, falls back
    // to this.prisma — login/verifyEmail/etc. run outside any tx.
    db?: any,
  ) {
    const client = db ?? this.prisma;
    const expiresAt = this.refreshTokenExpiry();
    const familyId = createHash('sha256')
      .update(randomBytes(16))
      .digest('hex');
    const placeholderHash = this.encryption.hash(randomBytes(32).toString('hex'));
    const session = await client.session.create({
      data: {
        userId,
        refreshTokenHash: placeholderHash,
        familyId,
        status: 'ACTIVE',
        expiresAt,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });
    const tokens = await this.signTokenPair(userId, email, role, session.id);
    const refreshTokenHash = this.encryption.hash(tokens.refreshToken);
    await client.session.update({
      where: { id: session.id },
      data: { refreshTokenHash },
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

  /**
   * Password strength gate for WRITES (register, changePassword,
   * resetPassword). Login still accepts whatever the user has on file —
   * grandfathered weak passwords keep working until the user changes
   * them. Policy: ≥12 chars AND at least 3 of {lower, upper, digit, symbol}.
   */
  private isStrongEnough(pw: string): { ok: boolean; reason?: string } {
    if (!pw || typeof pw !== 'string') {
      return { ok: false, reason: 'Password is required.' };
    }
    if (pw.length < 12) {
      return { ok: false, reason: 'Password must be at least 12 characters long.' };
    }
    if (pw.length > 128) {
      return { ok: false, reason: 'Password must be at most 128 characters long.' };
    }
    const classes = [
      /[a-z]/.test(pw),
      /[A-Z]/.test(pw),
      /[0-9]/.test(pw),
      /[^A-Za-z0-9]/.test(pw),
    ].filter(Boolean).length;
    if (classes < 3) {
      return {
        ok: false,
        reason:
          'Password must contain at least 3 of: lowercase letter, uppercase letter, digit, symbol.',
      };
    }
    return { ok: true };
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
