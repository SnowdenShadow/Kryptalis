import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

/**
 * JwtStrategy re-reads the user from the DB on EVERY request (not from the JWT
 * payload). That gives two security-critical properties this suite pins:
 *  - a BANNED/SUSPENDED/non-ACTIVE user loses access immediately (not at token
 *    expiry);
 *  - the LIVE role/email is returned (so RolesGuard can't be bypassed by a
 *    stale token whose `role` was higher than the DB now says).
 */
function makeStrategy(dbUser: any, session: any = { status: 'ACTIVE' }) {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue(dbUser) },
    // Default: the backing session is ACTIVE so status-only tests are unaffected.
    session: { findUnique: vi.fn().mockResolvedValue(session) },
  };
  const config = { get: vi.fn().mockReturnValue('a'.repeat(32)) };
  const strategy = new JwtStrategy(config as any, prisma as any);
  return { strategy, prisma };
}

const ACTIVE_USER = {
  id: 'u1', email: 'x@y.z', role: 'ADMIN', name: 'Jo', status: 'ACTIVE',
};

const PAYLOAD = { sub: 'u1', email: 'stale@old.example', role: 'ADMIN', sid: 'sess1' };

describe('JwtStrategy.validate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when the user no longer exists', async () => {
    const { strategy } = makeStrategy(null);
    await expect(strategy.validate(PAYLOAD)).rejects.toThrow(UnauthorizedException);
  });

  it('returns the LIVE role/email from the DB, not the JWT payload (no stale-token escalation)', async () => {
    // Token says ADMIN, but the DB now says USER → the demotion must win.
    const { strategy } = makeStrategy({
      id: 'u1', email: 'live@new.example', role: 'USER', name: 'Jo', status: 'ACTIVE',
    });
    const result = await strategy.validate(PAYLOAD);
    expect(result.role).toBe('USER');
    expect(result.email).toBe('live@new.example');
    expect(result.id).toBe('u1');
    // sid is surfaced for the sessions list/revoke endpoints.
    expect(result.sessionId).toBe('sess1');
  });

  it('BANNED user is rejected immediately (ForbiddenException), even with a valid token', async () => {
    const { strategy } = makeStrategy({
      id: 'u1', email: 'x@y.z', role: 'USER', name: 'Jo', status: 'BANNED',
    });
    await expect(strategy.validate(PAYLOAD)).rejects.toThrow(/banned/i);
  });

  it('SUSPENDED user is rejected immediately', async () => {
    const { strategy } = makeStrategy({
      id: 'u1', email: 'x@y.z', role: 'USER', name: 'Jo', status: 'SUSPENDED',
    });
    await expect(strategy.validate(PAYLOAD)).rejects.toThrow(/suspend/i);
  });

  it('default-DENIES any other non-ACTIVE status (PENDING_VERIFICATION, etc.)', async () => {
    for (const status of ['PENDING_VERIFICATION', 'PENDING_APPROVAL', 'DELETED']) {
      const { strategy } = makeStrategy({
        id: 'u1', email: 'x@y.z', role: 'USER', name: 'Jo', status,
      });
      await expect(strategy.validate(PAYLOAD), status).rejects.toThrow(ForbiddenException);
    }
  });

  it('an ACTIVE user passes', async () => {
    const { strategy } = makeStrategy({
      id: 'u1', email: 'x@y.z', role: 'ADMIN', name: 'Jo', status: 'ACTIVE',
    });
    await expect(strategy.validate(PAYLOAD)).resolves.toMatchObject({ id: 'u1', role: 'ADMIN' });
  });

  // ── H-2: access tokens are revocable via session state ──────────────────
  it('rejects when the backing session is REVOKED (logout / revoke / password change)', async () => {
    const { strategy } = makeStrategy(ACTIVE_USER, { status: 'REVOKED' });
    await expect(strategy.validate(PAYLOAD)).rejects.toThrow(/revoked/i);
  });

  it('rejects when the backing session no longer exists (admin reset deleteMany)', async () => {
    const { strategy } = makeStrategy(ACTIVE_USER, null);
    await expect(strategy.validate(PAYLOAD)).rejects.toThrow(UnauthorizedException);
  });

  it('accepts a ROTATED session — the just-refreshed token stays valid until expiry', async () => {
    const { strategy } = makeStrategy(ACTIVE_USER, { status: 'ROTATED' });
    await expect(strategy.validate(PAYLOAD)).resolves.toMatchObject({ id: 'u1' });
  });

  it('accepts a PENDING successor session', async () => {
    const { strategy } = makeStrategy(ACTIVE_USER, { status: 'PENDING' });
    await expect(strategy.validate(PAYLOAD)).resolves.toMatchObject({ id: 'u1' });
  });

  it('grandfathers a legacy token with no sid (never queries sessions)', async () => {
    const { strategy, prisma } = makeStrategy(ACTIVE_USER);
    const { sid, ...noSid } = PAYLOAD;
    await expect(strategy.validate(noSid as any)).resolves.toMatchObject({ id: 'u1' });
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });
});
