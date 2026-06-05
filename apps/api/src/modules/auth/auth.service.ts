import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    // SAFETY: if no user exists yet, allow signup unconditionally and grant SUPERADMIN.
    // This avoids locking yourself out after toggling registration_enabled=false.
    const userCount = await this.prisma.user.count();
    if (userCount > 0) {
      const setting = await this.prisma.systemSetting.findUnique({
        where: { key: 'registration_enabled' },
      });
      // default true if unset
      const enabled = setting ? !!(setting.value as any) : true;
      if (!enabled) {
        throw new ForbiddenException('Registration is disabled');
      }
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        password: hashedPassword,
        role: userCount === 0 ? 'SUPERADMIN' : 'USER',
      },
    });

    // Auto-create platform server if none exists (V1: single local server)
    const existingServer = await this.prisma.server.findFirst();
    if (!existingServer) {
      const server = await this.prisma.server.create({
        data: {
          name: 'Local Server',
          host: '127.0.0.1',
          port: 22,
          username: 'root',
          status: 'ONLINE',
        },
      });
      const agentToken = randomBytes(32).toString('hex');
      await this.prisma.agentToken.create({
        data: { serverId: server.id, token: agentToken },
      });
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status === 'BANNED') {
      throw new ForbiddenException('Your account has been banned');
    }
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('Your account is suspended');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.generateTokens(user.id, user.email, user.role);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      ...tokens,
    };
  }

  async refreshTokens(refreshToken: string) {
    const session = await this.prisma.session.findUnique({
      where: { refreshToken },
      include: { user: true },
    });
    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (session.user.status !== 'ACTIVE') {
      await this.prisma.session.deleteMany({ where: { userId: session.user.id } });
      throw new ForbiddenException('Account is not active');
    }

    await this.prisma.session.delete({ where: { id: session.id } });

    const tokens = await this.generateTokens(
      session.user.id,
      session.user.email,
      session.user.role,
    );
    await this.saveRefreshToken(session.user.id, tokens.refreshToken);

    return tokens;
  }

  async logout(refreshToken: string) {
    await this.prisma.session.deleteMany({ where: { refreshToken } });
  }

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
    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    return user;
  }

  async changePassword(userId: string, dto: { currentPassword: string; newPassword: string }) {
    if (!dto.newPassword || dto.newPassword.length < 8) {
      throw new ConflictException('New password must be at least 8 characters');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const ok = await bcrypt.compare(dto.currentPassword, user.password);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');
    const hashed = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    // invalidate all other sessions on password change — keep the caller's? we kill all
    // for safety; the caller will need to log in again.
    await this.prisma.session.deleteMany({ where: { userId } });
    return { message: 'Password changed. Please log in again.' };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true, lastLoginAt: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  private async generateTokens(userId: string, email: string, role: string) {
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

  private async saveRefreshToken(userId: string, refreshToken: string) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await this.prisma.session.create({
      data: { userId, refreshToken, expiresAt },
    });
  }
}
