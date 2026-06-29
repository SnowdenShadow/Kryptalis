import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import {
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { AuthService } from './auth.service';
import { EncryptionService } from '../../common/crypto/encryption.service';

/**
 * Service-level auth-flow tests. AuthService is instantiated directly with:
 *   - a plain-object PrismaService mock (vi.fn fixtures, no DB)
 *   - a REAL JwtService with test secrets
 *   - a REAL EncryptionService keyed with a test key
 *   - stubs for ConfigService / SystemConfigService / NotificationsService
 */

const ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
const ENCRYPTION_KEY = 'k'.repeat(32);

const configStub = {
  get: (key: string, def?: unknown) => {
    const map: Record<string, unknown> = {
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      JWT_REFRESH_EXPIRATION: '7d',
      ENCRYPTION_KEY,
    };
    return map[key] ?? def;
  },
} as any;

function makeEncryption(): EncryptionService {
  const svc = new EncryptionService(configStub);
  svc.onModuleInit();
  return svc;
}

function makePrisma() {
  let sessionSeq = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({ failedLoginAttempts: 1 }),
      count: vi.fn(),
    },
    session: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: `sess-${++sessionSeq}`,
        ...data,
      })),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    passwordResetToken: {
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    twoFactorBackupCode: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    // Array form only (resetPassword): the mocked model fns already return
    // promises, so awaiting them is enough.
    $transaction: vi.fn(async (ops: any) =>
      Array.isArray(ops) ? Promise.all(ops) : ops(prisma),
    ),
  };
  return prisma;
}

type PrismaMock = ReturnType<typeof makePrisma>;

const notificationsStub = {
  sendEmailVerification: vi.fn().mockResolvedValue(undefined),
  sendPasswordReset: vi.fn().mockResolvedValue(undefined),
} as any;

const systemConfigStub = {
  get: vi.fn().mockReturnValue(undefined),
  getBool: vi.fn().mockReturnValue(false),
} as any;

const jwt = new JwtService({ secret: ACCESS_SECRET, signOptions: { expiresIn: '15m' } });
const encryption = makeEncryption();

function makeService(prisma: PrismaMock): AuthService {
  return new AuthService(
    prisma as any,
    jwt,
    configStub,
    encryption,
    notificationsStub,
    systemConfigStub,
  );
}

// Pre-hashed fixture password (low cost — test-only).
const PASSWORD = 'Sup3r-Secure-Pass!';
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    name: 'Alice',
    email: 'alice@example.com',
    password: passwordHash,
    role: 'USER',
    status: 'ACTIVE',
    twoFactorEnabled: false,
    twoFactorSecret: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

async function signRefreshToken(payload: Record<string, unknown>) {
  return jwt.signAsync(payload, { secret: REFRESH_SECRET, expiresIn: '7d' });
}

describe('AuthService — login', () => {
  let prisma: PrismaMock;
  let svc: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    svc = makeService(prisma);
  });

  it('valid credentials → token pair + session persisted with sha256 hash + counters reset', async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser());
    const res = await svc.login({ email: 'Alice@Example.com ', password: PASSWORD } as any, {
      ip: '1.2.3.4',
      userAgent: 'vitest',
    });

    expect(res.user).toEqual({ id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'USER' });
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();

    // Session row created ACTIVE with the request context…
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
    const created = prisma.session.create.mock.calls[0][0].data;
    expect(created.userId).toBe('u1');
    expect(created.status).toBe('ACTIVE');
    expect(created.ipAddress).toBe('1.2.3.4');
    expect(created.userAgent).toBe('vitest');
    // …then updated with sha256(refreshToken) — never the raw token.
    const upd = prisma.session.update.mock.calls[0][0];
    expect(upd.data.refreshTokenHash).toBe(encryption.hash(res.refreshToken));
    expect(upd.data.refreshTokenHash).not.toBe(res.refreshToken);

    // Failed-attempt counters reset on success.
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ failedLoginAttempts: 0, lockedUntil: null }),
      }),
    );
  });

  it('access token payload carries sub/email/role/sid pointing at the created session', async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser());
    const res = await svc.login({ email: 'alice@example.com', password: PASSWORD } as any);
    const payload = await jwt.verifyAsync(res.accessToken, { secret: ACCESS_SECRET });
    expect(payload.sub).toBe('u1');
    expect(payload.email).toBe('alice@example.com');
    expect(payload.role).toBe('USER');
    const sessionId = (await prisma.session.create.mock.results[0].value).id;
    expect(payload.sid).toBe(sessionId);
  });

  it('wrong password → 401 Invalid credentials + failed-attempt counter bumped', async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser());
    await expect(
      svc.login({ email: 'alice@example.com', password: 'nope-wrong-pass' } as any),
    ).rejects.toThrow(UnauthorizedException);
    // bumpFailedAttempt → increment write.
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { failedLoginAttempts: { increment: 1 } },
      }),
    );
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('unknown email → 401 without any counter write', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      svc.login({ email: 'ghost@example.com', password: 'whatever-pass' } as any),
    ).rejects.toThrow('Invalid credentials');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('5th failed attempt sets lockedUntil ~15 min in the future', async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser());
    prisma.user.update.mockResolvedValueOnce({ failedLoginAttempts: 5 });
    await expect(
      svc.login({ email: 'alice@example.com', password: 'still-wrong-pass' } as any),
    ).rejects.toThrow(UnauthorizedException);

    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    const lockWrite = prisma.user.update.mock.calls[1][0];
    expect(lockWrite.data.lockedUntil).toBeInstanceOf(Date);
    const deltaMin = (lockWrite.data.lockedUntil.getTime() - Date.now()) / 60_000;
    expect(deltaMin).toBeGreaterThan(14);
    expect(deltaMin).toBeLessThanOrEqual(15);
  });

  it('locked account (lockedUntil in the future) → 401 even with the correct password', async () => {
    prisma.user.findUnique.mockResolvedValue(
      activeUser({ lockedUntil: new Date(Date.now() + 10 * 60_000) }),
    );
    await expect(
      svc.login({ email: 'alice@example.com', password: PASSWORD } as any),
    ).rejects.toThrow(/temporarily locked/);
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('PENDING_APPROVAL account → ForbiddenException (403)', async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser({ status: 'PENDING_APPROVAL' }));
    await expect(
      svc.login({ email: 'alice@example.com', password: PASSWORD } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('2FA enabled without a code → 401 with structured code TOTP_REQUIRED', async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser({ twoFactorEnabled: true }));
    const err = await svc
      .login({ email: 'alice@example.com', password: PASSWORD } as any)
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err.getResponse() as any).code).toBe('TOTP_REQUIRED');
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('2FA enabled with a valid TOTP code → token pair issued', async () => {
    const secret = authenticator.generateSecret();
    prisma.user.findUnique.mockResolvedValue(
      activeUser({ twoFactorEnabled: true, twoFactorSecret: encryption.encrypt(secret) }),
    );
    const res = await svc.login({
      email: 'alice@example.com',
      password: PASSWORD,
      totpCode: authenticator.generate(secret),
    } as any);
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
  });

  it('2FA enabled with an invalid TOTP code → 401 + failed-attempt bump', async () => {
    const secret = authenticator.generateSecret();
    prisma.user.findUnique.mockResolvedValue(
      activeUser({ twoFactorEnabled: true, twoFactorSecret: encryption.encrypt(secret) }),
    );
    await expect(
      svc.login({
        email: 'alice@example.com',
        password: PASSWORD,
        totpCode: '000000',
      } as any),
    ).rejects.toThrow('Invalid two-factor code');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failedLoginAttempts: { increment: 1 } } }),
    );
  });
});

describe('AuthService — refresh rotation', () => {
  let prisma: PrismaMock;
  let svc: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    svc = makeService(prisma);
  });

  function sessionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sess-old',
      userId: 'u1',
      familyId: 'fam-1',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 86_400_000),
      user: { id: 'u1', email: 'alice@example.com', role: 'USER', status: 'ACTIVE' },
      ...overrides,
    };
  }

  it('valid token → rotation: old session ROTATED, successor ACTIVE with new hash, fresh pair returned', async () => {
    const token = await signRefreshToken({ sub: 'u1', email: 'alice@example.com', role: 'USER' });
    prisma.session.findUnique.mockResolvedValue(sessionRow());

    const tokens = await svc.refreshTokens(token, { ip: '5.6.7.8' });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.refreshToken).not.toBe(token);

    // CAS: ACTIVE→ROTATED on the parent, linked to the successor.
    const successorId = (await prisma.session.create.mock.results[0].value).id;
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-old', status: 'ACTIVE' },
      data: { status: 'ROTATED', replacedById: successorId },
    });
    // Successor flipped ACTIVE with sha256 of the NEW refresh token.
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: successorId },
      data: { status: 'ACTIVE', refreshTokenHash: encryption.hash(tokens.refreshToken) },
    });
    // Successor stays in the same family.
    expect(prisma.session.create.mock.calls[0][0].data.familyId).toBe('fam-1');
  });

  it('garbage signature → 401 before any DB lookup', async () => {
    await expect(svc.refreshTokens('not-a-jwt')).rejects.toThrow('Invalid refresh token');
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it('well-signed but unknown token (no session row) → 401', async () => {
    const token = await signRefreshToken({ sub: 'u1', email: 'a@b.c', role: 'USER' });
    prisma.session.findUnique.mockResolvedValue(null);
    await expect(svc.refreshTokens(token)).rejects.toThrow('Invalid refresh token');
  });

  it('replay of a ROTATED token → 401 + whole family revoked', async () => {
    const token = await signRefreshToken({ sub: 'u1', email: 'a@b.c', role: 'USER' });
    prisma.session.findUnique.mockResolvedValue(sessionRow({ status: 'ROTATED' }));
    await expect(svc.refreshTokens(token)).rejects.toThrow('Session revoked');
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-1', status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('signature owner ≠ stored owner → treated as theft: family revoked + 401', async () => {
    const token = await signRefreshToken({ sub: 'attacker', email: 'a@b.c', role: 'USER' });
    prisma.session.findUnique.mockResolvedValue(sessionRow());
    await expect(svc.refreshTokens(token)).rejects.toThrow('Invalid refresh token');
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-1', status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
  });

  it('lost CAS race (concurrent refresh) → successor deleted, family revoked, 401', async () => {
    const token = await signRefreshToken({ sub: 'u1', email: 'a@b.c', role: 'USER' });
    prisma.session.findUnique.mockResolvedValue(sessionRow());
    prisma.session.updateMany.mockResolvedValueOnce({ count: 0 }); // CAS loses
    await expect(svc.refreshTokens(token)).rejects.toThrow('Session revoked');

    const successorId = (await prisma.session.create.mock.results[0].value).id;
    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: successorId } });
    expect(prisma.session.updateMany).toHaveBeenLastCalledWith({
      where: { familyId: 'fam-1', status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
  });
});

describe('AuthService — logout', () => {
  let prisma: PrismaMock;
  let svc: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    svc = makeService(prisma);
  });

  it('revokes the whole session family by token hash', async () => {
    prisma.session.findUnique.mockResolvedValue({ id: 's1', familyId: 'fam-9' });
    await svc.logout('some-refresh-token');
    expect(prisma.session.findUnique).toHaveBeenCalledWith({
      where: { refreshTokenHash: encryption.hash('some-refresh-token') },
    });
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-9', status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
  });

  it('unknown token → silent no-op (no revocation write)', async () => {
    prisma.session.findUnique.mockResolvedValue(null);
    await svc.logout('unknown-token');
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });
});

describe('AuthService — resetPassword', () => {
  const NEW_PASSWORD = 'N3w-Str0ng-Passw0rd!';
  let prisma: PrismaMock;
  let svc: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    svc = makeService(prisma);
  });

  function resetRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'prt-1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      user: { id: 'u1', status: 'ACTIVE', twoFactorEnabled: false, twoFactorSecret: null },
      ...overrides,
    };
  }

  it('expired token → 400 Reset link is invalid or expired', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(
      resetRow({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(svc.resetPassword('raw-token', NEW_PASSWORD)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('already-used token → 400 (single-use semantics)', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(
      resetRow({ usedAt: new Date() }),
    );
    await expect(svc.resetPassword('raw-token', NEW_PASSWORD)).rejects.toThrow(
      'Reset link is invalid or expired.',
    );
  });

  it('valid token → password rehashed, token consumed, ALL sessions revoked atomically', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(resetRow());
    const res = await svc.resetPassword('raw-token', NEW_PASSWORD);
    expect(res.message).toMatch(/Password reset/);

    // Lookup was by sha256 hash, not the raw token.
    expect(prisma.passwordResetToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: encryption.hash('raw-token') } }),
    );

    // New password stored as a bcrypt hash of NEW_PASSWORD.
    const pwWrite = prisma.user.update.mock.calls[0][0];
    expect(pwWrite.where).toEqual({ id: 'u1' });
    expect(pwWrite.data.password).not.toBe(NEW_PASSWORD);
    await expect(bcrypt.compare(NEW_PASSWORD, pwWrite.data.password)).resolves.toBe(true);

    // Token marked used.
    expect(prisma.passwordResetToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prt-1' },
        data: { usedAt: expect.any(Date) },
      }),
    );
    // Every live session revoked.
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
    // All three writes went through one $transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('BANNED account → 403 and password is NOT changed', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(
      resetRow({ user: { id: 'u1', status: 'BANNED', twoFactorEnabled: false, twoFactorSecret: null } }),
    );
    await expect(svc.resetPassword('raw-token', NEW_PASSWORD)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.passwordResetToken.update).not.toHaveBeenCalled();
  });

  it('SUSPENDED account → 403 and password is NOT changed', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(
      resetRow({ user: { id: 'u1', status: 'SUSPENDED', twoFactorEnabled: false, twoFactorSecret: null } }),
    );
    await expect(svc.resetPassword('raw-token', NEW_PASSWORD)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('2FA reset with a wrong code → 401 AND the failed-attempt counter is bumped (lockout participates)', async () => {
    const secret = authenticator.generateSecret();
    prisma.passwordResetToken.findUnique.mockResolvedValue(
      resetRow({
        user: { id: 'u1', status: 'ACTIVE', twoFactorEnabled: true, twoFactorSecret: encryption.encrypt(secret) },
      }),
    );
    // Live re-fetch for lockout state.
    prisma.user.findUnique.mockResolvedValue(activeUser({ twoFactorEnabled: true }));
    await expect(
      svc.resetPassword('raw-token', NEW_PASSWORD, { totpCode: '000000' }),
    ).rejects.toThrow('Invalid two-factor code');
    // bumpFailedAttempt fired the increment write — previously this path had NO
    // lockout, allowing unbounded TOTP/backup-code grinding.
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failedLoginAttempts: { increment: 1 } } }),
    );
    // Password was NOT changed.
    expect(prisma.passwordResetToken.update).not.toHaveBeenCalled();
  });

  it('2FA reset while account is locked → 401 temporarily locked, code never checked', async () => {
    const secret = authenticator.generateSecret();
    prisma.passwordResetToken.findUnique.mockResolvedValue(
      resetRow({
        user: { id: 'u1', status: 'ACTIVE', twoFactorEnabled: true, twoFactorSecret: encryption.encrypt(secret) },
      }),
    );
    prisma.user.findUnique.mockResolvedValue(
      activeUser({ twoFactorEnabled: true, lockedUntil: new Date(Date.now() + 10 * 60_000) }),
    );
    await expect(
      svc.resetPassword('raw-token', NEW_PASSWORD, { totpCode: authenticator.generate(secret) }),
    ).rejects.toThrow(/temporarily locked/);
  });
});

describe('AuthService — forgotPassword', () => {
  let prisma: PrismaMock;
  let svc: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    svc = makeService(prisma);
  });

  it('non-ACTIVE account → generic message, NO reset token minted', async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser({ status: 'BANNED' }));
    const res = await svc.forgotPassword('alice@example.com');
    expect(res.message).toMatch(/If that email is registered/);
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('ACTIVE account → token minted + reset email dispatched', async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser());
    await svc.forgotPassword('alice@example.com');
    expect(prisma.passwordResetToken.create).toHaveBeenCalled();
    expect(notificationsStub.sendPasswordReset).toHaveBeenCalled();
  });
});
