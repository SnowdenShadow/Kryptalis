import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Validates an access-token-bearing request. Two important properties:
 *
 * - **Re-reads user from the DB on every request.** Means a BANNED or
 *   SUSPENDED user loses access immediately, not at JWT expiry. Same for
 *   role demotion — a downgraded ADMIN starts being rejected by RolesGuard
 *   on the very next request.
 * - **Returns the live role/email, not the JWT payload.** RolesGuard reads
 *   `request.user.role`, so token-vs-DB drift can't bypass role checks.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET')!,
    });
  }

  async validate(payload: { sub: string; email: string; role: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, name: true, status: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.status === 'BANNED') {
      throw new ForbiddenException('Your account has been banned.');
    }
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('Your account is suspended.');
    }
    return { id: user.id, email: user.email, role: user.role, name: user.name };
  }
}
