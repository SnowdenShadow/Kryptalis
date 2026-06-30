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

  async validate(payload: { sub: string; email: string; role: string; sid?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, name: true, status: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    // Default-DENY status check. Any non-ACTIVE state (BANNED, SUSPENDED,
    // or future values like DELETED / PENDING_VERIFICATION / LOCKED)
    // refuses the request. Specific messages are kept for BANNED/SUSPENDED
    // since those are user-facing legitimate states.
    if (user.status !== 'ACTIVE') {
      if (user.status === 'BANNED') {
        throw new ForbiddenException('Your account has been banned.');
      }
      if (user.status === 'SUSPENDED') {
        throw new ForbiddenException('Your account is suspended.');
      }
      throw new ForbiddenException('Account is not active.');
    }
    // H-2: make access tokens revocable. The 15-min access JWT used to remain
    // valid after "log out everywhere", a single-session revoke, a password
    // change, or an admin password reset — those flows only touched the
    // `sessions` table, which the strategy never consulted. Now, when the token
    // carries a `sid`, the backing session must still exist and not be REVOKED.
    //   - REVOKED  → logout / revokeSession / revokeOtherSessions / changePassword
    //                / resetPassword all set this; reject immediately.
    //   - missing  → admin resetUserPassword deleteMany's the rows; reject.
    //   - ACTIVE / PENDING / ROTATED → accept. ROTATED is the benign case where
    //                the user just refreshed: the prior access token stays valid
    //                until its own short expiry, which is the intended behavior.
    // Tokens minted before this change have no `sid` and are grandfathered in
    // (they expire within JWT_EXPIRATION anyway).
    if (payload.sid) {
      const session = await this.prisma.session.findUnique({
        where: { id: payload.sid },
        select: { status: true },
      });
      if (!session || session.status === 'REVOKED') {
        throw new UnauthorizedException('Session has been revoked. Please log in again.');
      }
    }
    // sessionId (sid) is surfaced on req.user so the sessions list/revoke
    // endpoints can compute isCurrent and protect the caller's own row.
    return { id: user.id, email: user.email, role: user.role, name: user.name, sessionId: payload.sid };
  }
}
