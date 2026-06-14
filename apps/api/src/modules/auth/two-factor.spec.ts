import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import {
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

// Mock otplib so valid/invalid TOTP outcomes are fully controlled (no
// time-window flakiness). auth.service.ts assigns `authenticator.options`
// at module load, so the mock must expose a writable `options`.
vi.mock('otplib', () => ({
  authenticator: {
    options: {},
    verify: vi.fn(),
    generateSecret: vi.fn().mockReturnValue('MOCK2FASECRET234567'),
    keyuri: vi.fn().mockReturnValue('otpauth://totp/DockControl:alice%40example.com?secret=MOCK'),
  },
}));

import { authenticator } from 'otplib';
import { AuthService } from './auth.service';
import { EncryptionService } from '../../common/crypto/encryption.service';

const mockVerify = vi.mocked(authenticator.verify);
const mockGenerateSecret = vi.mocked(authenticator.generateSecret);
const mockKeyuri = vi.mocked(authenticator.keyuri);

/**
 * 2FA-focused AuthService tests. Complements auth-flow.spec.ts which already
 * covers: TOTP_REQUIRED structured error, valid/invalid TOTP at login,
 * 5th-failure lock write and locked-account rejection. Here we cover what's
 * NOT there: backup codes (consumption, normalization, single-use), lockout
 * expiry, lockout via the TOTP-grinding path, and the setup/enable/disable
 * lifecycle.
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
      // Consumption is now an atomic compare-and-set (updateMany scoped on
      // usedAt:null); default to count===1 (the row was still unused).
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
    },
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
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

const PASSWORD = 'Sup3r-Secure-Pass!';
let passwordHash: string;
// Canonical (un-dashed) backup code + its bcrypt hash, prepared once.
const BACKUP_CODE = 'ab12cd34ef56ab12cd34';
const BACKUP_DISPLAY = 'ab12c-d34ef-56ab1-2cd34';
let backupHash: string;

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  backupHash = await bcrypt.hash(BACKUP_CODE, 4);
});

const ENCRYPTED_SECRET = () => encryption.encrypt('USER2FASECRET');

function twoFaUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    name: 'Alice',
    email: 'alice@example.com',
    password: passwordHash,
    role: 'USER',
    status: 'ACTIVE',
    twoFactorEnabled: true,
    twoFactorSecret: ENCRYPTED_SECRET(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

let prisma: PrismaMock;
let svc: AuthService;

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateSecret.mockReturnValue('MOCK2FASECRET234567');
  mockKeyuri.mockReturnValue('otpauth://totp/DockControl:alice%40example.com?secret=MOCK');
  prisma = makePrisma();
  svc = makeService(prisma);
});

// ── login: backup codes ─────────────────────────────────────────────

describe('login — backup codes', () => {
  it('valid backup code → tokens issued and the matched code is consumed (usedAt set)', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    prisma.twoFactorBackupCode.findMany.mockResolvedValue([
      { id: 'bc-other', codeHash: await bcrypt.hash('ffffffffffffffffffff', 4) },
      { id: 'bc-hit', codeHash: backupHash },
    ]);

    const res = await svc.login({
      email: 'alice@example.com',
      password: PASSWORD,
      backupCode: BACKUP_DISPLAY,
    } as any);

    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    // Only unused codes are candidates…
    expect(prisma.twoFactorBackupCode.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', usedAt: null },
    });
    // …and exactly the matched one is burned via an atomic compare-and-set
    // (updateMany scoped on usedAt:null so a concurrent second use loses).
    expect(prisma.twoFactorBackupCode.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.twoFactorBackupCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'bc-hit', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    // Backup path must NOT hit the TOTP verifier.
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('backup code input is normalized: dashes/spaces stripped, case-insensitive', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    prisma.twoFactorBackupCode.findMany.mockResolvedValue([{ id: 'bc1', codeHash: backupHash }]);

    const res = await svc.login({
      email: 'alice@example.com',
      password: PASSWORD,
      backupCode: ' AB12C-D34EF 56AB1-2CD34 ',
    } as any);
    expect(res.accessToken).toBeTruthy();
  });

  it('a consumed backup code no longer works (usedAt filter excludes it)', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    // Second use: the row no longer matches `usedAt: null` → no candidates.
    prisma.twoFactorBackupCode.findMany.mockResolvedValue([]);

    await expect(
      svc.login({
        email: 'alice@example.com',
        password: PASSWORD,
        backupCode: BACKUP_DISPLAY,
      } as any),
    ).rejects.toThrow('Invalid two-factor code');
    expect(prisma.twoFactorBackupCode.update).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('invalid backup code → 401 + failed-attempt counter bumped', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    prisma.twoFactorBackupCode.findMany.mockResolvedValue([{ id: 'bc1', codeHash: backupHash }]);

    await expect(
      svc.login({
        email: 'alice@example.com',
        password: PASSWORD,
        backupCode: '00000-00000-00000-00000',
      } as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { failedLoginAttempts: { increment: 1 } },
      }),
    );
  });

  it('empty backup code after normalization → rejected without bcrypt comparisons', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());

    await expect(
      svc.login({ email: 'alice@example.com', password: PASSWORD, backupCode: ' - - ' } as any),
    ).rejects.toThrow('Invalid two-factor code');
    expect(prisma.twoFactorBackupCode.findMany).not.toHaveBeenCalled();
  });
});

// ── login: lockout interactions ─────────────────────────────────────

describe('login — lockout expiry and TOTP-grinding', () => {
  it('expired lockout (lockedUntil in the past) → login succeeds again and counters reset', async () => {
    prisma.user.findUnique.mockResolvedValue(
      twoFaUser({
        twoFactorEnabled: false,
        twoFactorSecret: null,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() - 1000),
      }),
    );

    const res = await svc.login({ email: 'alice@example.com', password: PASSWORD } as any);
    expect(res.accessToken).toBeTruthy();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ failedLoginAttempts: 0, lockedUntil: null }),
      }),
    );
  });

  it('lockout during 2FA prompt: correct password is rejected while lockedUntil is in the future', async () => {
    prisma.user.findUnique.mockResolvedValue(
      twoFaUser({ lockedUntil: new Date(Date.now() + 5 * 60_000) }),
    );

    await expect(
      svc.login({ email: 'alice@example.com', password: PASSWORD, totpCode: '123456' } as any),
    ).rejects.toThrow(/temporarily locked/);
    // Never even reaches TOTP verification.
    expect(mockVerify).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
    // And the frozen account's counter is left alone.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('no password oracle: WRONG password on a locked account gets the SAME "temporarily locked" answer', async () => {
    prisma.user.findUnique.mockResolvedValue(
      twoFaUser({ lockedUntil: new Date(Date.now() + 5 * 60_000) }),
    );

    await expect(
      svc.login({ email: 'alice@example.com', password: 'totally-wrong-pass' } as any),
    ).rejects.toThrow(/temporarily locked/);
    // A failure during the lock must NOT bump failedLoginAttempts either.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('first FAILED attempt after lock expiry restarts the counter at 1 — no instant re-lock', async () => {
    prisma.user.findUnique.mockResolvedValue(
      twoFaUser({
        twoFactorEnabled: false,
        twoFactorSecret: null,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() - 1000), // expired lock
      }),
    );
    prisma.user.update.mockResolvedValueOnce({ failedLoginAttempts: 1 });

    await expect(
      svc.login({ email: 'alice@example.com', password: 'wrong-pass' } as any),
    ).rejects.toThrow('Invalid credentials');

    // Fresh counter (=1, not increment to 6) + expired lock cleared, and
    // therefore NO second write re-arming lockedUntil.
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { failedLoginAttempts: 1, lockedUntil: null },
      }),
    );
  });

  it('grinding TOTP codes locks the account at the 5th failure (same counter as passwords)', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    mockVerify.mockReturnValue(false);
    // bumpFailedAttempt: the increment write reports the threshold reached.
    prisma.user.update.mockResolvedValueOnce({ failedLoginAttempts: 5 });

    await expect(
      svc.login({ email: 'alice@example.com', password: PASSWORD, totpCode: '999999' } as any),
    ).rejects.toThrow('Invalid two-factor code');

    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    const lockWrite = prisma.user.update.mock.calls[1][0];
    expect(lockWrite.data.lockedUntil).toBeInstanceOf(Date);
    expect(lockWrite.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it('TOTP path decrypts the stored secret and hands it to the verifier', async () => {
    const enc = ENCRYPTED_SECRET();
    prisma.user.findUnique.mockResolvedValue(twoFaUser({ twoFactorSecret: enc }));
    mockVerify.mockReturnValue(true);

    await svc.login({ email: 'alice@example.com', password: PASSWORD, totpCode: '123456' } as any);
    expect(mockVerify).toHaveBeenCalledWith({ token: '123456', secret: 'USER2FASECRET' });
  });
});

// ── setup / enable ──────────────────────────────────────────────────

describe('startTwoFactorSetup', () => {
  it('generates a secret, stores it ENCRYPTED, and returns secret + otpauth uri', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser({ twoFactorEnabled: false }));

    const res = await svc.startTwoFactorSetup('u1');
    expect(res.secret).toBe('MOCK2FASECRET234567');
    expect(res.otpauth).toContain('otpauth://totp/');
    expect(mockKeyuri).toHaveBeenCalledWith('alice@example.com', 'DockControl', 'MOCK2FASECRET234567');

    const write = prisma.user.update.mock.calls[0][0];
    expect(write.where).toEqual({ id: 'u1' });
    // Not stored in plaintext…
    expect(write.data.twoFactorSecret).not.toBe('MOCK2FASECRET234567');
    expect(write.data.twoFactorSecret).toMatch(/^v1\./);
    // …but decrypts back to the generated secret.
    expect(encryption.decrypt(write.data.twoFactorSecret)).toBe('MOCK2FASECRET234567');
  });

  it('refuses re-enrollment while 2FA is already enabled', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser({ twoFactorEnabled: true }));
    await expect(svc.startTwoFactorSetup('u1')).rejects.toThrow(ConflictException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('unknown user → 401', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(svc.startTwoFactorSetup('ghost')).rejects.toThrow(UnauthorizedException);
  });
});

describe('enableTwoFactor', () => {
  it('requires setup first (no pending secret) → 400', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser({ twoFactorSecret: null }));
    await expect(svc.enableTwoFactor('u1', '123456')).rejects.toThrow(
      'Start two-factor setup first.',
    );
  });

  it('invalid first code → 400, 2FA stays off', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser({ twoFactorEnabled: false }));
    mockVerify.mockReturnValue(false);
    await expect(svc.enableTwoFactor('u1', '000000')).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.twoFactorBackupCode.createMany).not.toHaveBeenCalled();
  });

  it('valid code → flips twoFactorEnabled, wipes old codes, returns 10 dashed backup codes whose bcrypt hashes match the canonical form', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser({ twoFactorEnabled: false }));
    mockVerify.mockReturnValue(true);

    const { backupCodes } = await svc.enableTwoFactor('u1', '123456');

    // Verified against the DECRYPTED pending secret.
    expect(mockVerify).toHaveBeenCalledWith({ token: '123456', secret: 'USER2FASECRET' });

    expect(backupCodes).toHaveLength(10);
    for (const code of backupCodes) {
      // Display form: 20 hex chars grouped in 5s with dashes (80 bits).
      expect(code).toMatch(/^[0-9a-f]{5}(-[0-9a-f]{5}){3}$/);
    }
    // Uniqueness across the batch.
    expect(new Set(backupCodes).size).toBe(10);

    // All three writes in one transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { twoFactorEnabled: true },
    });
    expect(prisma.twoFactorBackupCode.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });

    // Stored hashes are bcrypt of the UN-dashed canonical string.
    const rows = prisma.twoFactorBackupCode.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(10);
    const canonical = backupCodes[0].replace(/-/g, '');
    await expect(bcrypt.compare(canonical, rows[0].codeHash)).resolves.toBe(true);
    // And NOT of the dashed display form.
    await expect(bcrypt.compare(backupCodes[0], rows[0].codeHash)).resolves.toBe(false);
  });
});

// ── disable ─────────────────────────────────────────────────────────

describe('disableTwoFactor', () => {
  it('wrong password → 401, nothing written', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    await expect(svc.disableTwoFactor('u1', 'wrong-password', '123456')).rejects.toThrow(
      'Wrong password.',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('invalid TOTP code → 401, 2FA stays on', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    mockVerify.mockReturnValue(false);
    await expect(svc.disableTwoFactor('u1', PASSWORD, '000000')).rejects.toThrow(
      'Invalid two-factor code.',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('valid TOTP → disables 2FA, nulls the secret, purges backup codes atomically', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    mockVerify.mockReturnValue(true);

    const res = await svc.disableTwoFactor('u1', PASSWORD, '123456');
    expect(res.message).toMatch(/disabled/i);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
    expect(prisma.twoFactorBackupCode.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('backup-code-shaped input routes to the backup path (TOTP verifier never called)', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    prisma.twoFactorBackupCode.findMany.mockResolvedValue([{ id: 'bc1', codeHash: backupHash }]);

    const res = await svc.disableTwoFactor('u1', PASSWORD, BACKUP_DISPLAY);
    expect(res.message).toMatch(/disabled/i);
    expect(mockVerify).not.toHaveBeenCalled();
    // The backup code used to disable is consumed too (atomic CAS).
    expect(prisma.twoFactorBackupCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'bc1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });
});

// ── 2FA gates on other credential flows ─────────────────────────────

describe('changePassword — 2FA gate', () => {
  const NEW_PASSWORD = 'N3w-Str0ng-Passw0rd!';

  it('2FA user without a code → 401 (current password alone is not enough)', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    await expect(
      svc.changePassword('u1', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    ).rejects.toThrow('Two-factor code required to change password');
    // No password write, no session revocation.
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('2FA user with an invalid code → 401', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    mockVerify.mockReturnValue(false);
    await expect(
      svc.changePassword('u1', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        totpCode: '000000',
      }),
    ).rejects.toThrow('Invalid two-factor code');
  });

  it('2FA user with a valid code → password changed + every session revoked', async () => {
    prisma.user.findUnique.mockResolvedValue(twoFaUser());
    mockVerify.mockReturnValue(true);

    const res = await svc.changePassword('u1', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode: '123456',
    });
    expect(res.message).toMatch(/Password changed/);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', status: { not: 'REVOKED' } },
      data: { status: 'REVOKED' },
    });
  });
});

describe('resetPassword — 2FA gate', () => {
  const NEW_PASSWORD = 'N3w-Str0ng-Passw0rd!';

  function resetRow(userOverrides: Record<string, unknown> = {}) {
    return {
      id: 'prt-1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      user: twoFaUser(userOverrides),
    };
  }

  it('email reset cannot bypass 2FA: no code → 400', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(resetRow());
    await expect(svc.resetPassword('raw-token', NEW_PASSWORD)).rejects.toThrow(
      'Two-factor code required to reset password.',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('invalid TOTP on reset → 401', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(resetRow());
    mockVerify.mockReturnValue(false);
    await expect(
      svc.resetPassword('raw-token', NEW_PASSWORD, { totpCode: '000000' }),
    ).rejects.toThrow('Invalid two-factor code.');
  });

  it('valid backup code unlocks the reset (and is consumed)', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(resetRow());
    prisma.twoFactorBackupCode.findMany.mockResolvedValue([{ id: 'bc1', codeHash: backupHash }]);

    const res = await svc.resetPassword('raw-token', NEW_PASSWORD, {
      backupCode: BACKUP_DISPLAY,
    });
    expect(res.message).toMatch(/Password reset/);
    expect(prisma.twoFactorBackupCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'bc1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
