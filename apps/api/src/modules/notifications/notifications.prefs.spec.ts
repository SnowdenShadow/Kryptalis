import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NotificationsService } from './notifications.service';

/**
 * Pure service-level tests for the notificationPrefs gating — every
 * dependency is a plain object of vi.fn()s, same approach as
 * projects.service.spec.ts (no DB, no TestingModule).
 */
function makePrisma() {
  return {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    notification: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makeService() {
  const prisma = makePrisma();
  const config = { get: vi.fn() };
  const systemConfig = {
    get: vi.fn().mockReturnValue(undefined),
    getNumber: vi.fn().mockReturnValue(undefined),
    onChange: vi.fn().mockReturnValue(() => {}),
  };
  const service = new NotificationsService(
    config as any,
    prisma as any,
    systemConfig as any,
  );
  // Pretend SMTP is configured so the email path runs; capture sends.
  const sendMail = vi.fn().mockResolvedValue(undefined);
  (service as any).smtpReady = true;
  (service as any).smtpFrom = 'no-reply@test';
  (service as any).transporter = { sendMail };
  return { service, prisma, sendMail };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('allows()', () => {
  const call = (prefs: unknown, event: string, channel = 'email') => {
    const { service } = makeService();
    return (service as any).allows(prefs, event, channel);
  };

  it('absent prefs → allowed (opt-out model)', () => {
    expect(call(null, 'deployOk')).toBe(true);
    expect(call(undefined, 'backupFail')).toBe(true);
    expect(call({}, 'deployFail')).toBe(true);
  });

  it('absent channel entry within an event → allowed', () => {
    expect(call({ deployOk: {} }, 'deployOk')).toBe(true);
    expect(call({ deployOk: { discord: false } }, 'deployOk')).toBe(true);
  });

  it('explicit false → blocked', () => {
    expect(call({ deployOk: { email: false } }, 'deployOk')).toBe(false);
    expect(call({ backupFail: { email: false } }, 'backupFail')).toBe(false);
  });

  it('explicit true → allowed', () => {
    expect(call({ deployFail: { email: true } }, 'deployFail')).toBe(true);
  });

  it('unknown event → allowed', () => {
    expect(call({ deployOk: { email: false } }, 'somethingElse')).toBe(true);
  });

  it('non-object prefs garbage → allowed', () => {
    expect(call('junk', 'deployOk')).toBe(true);
    expect(call(42, 'deployOk')).toBe(true);
    expect(call({ deployOk: 'junk' }, 'deployOk')).toBe(true);
  });
});

describe('sendDeploymentResult pref filtering', () => {
  it('sends email when no prefs are set', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      email: 'u@test',
      name: 'U',
      notificationPrefs: null,
    });
    prisma.user.findMany.mockResolvedValue([]); // notifyAdmins fan-out

    await service.sendDeploymentResult('u1', 'app', 'success');

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('u@test');
  });

  it('skips email when deployOk.email === false but still writes the feed', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      email: 'u@test',
      name: 'U',
      notificationPrefs: { deployOk: { email: false } },
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'admin1' }]);

    await service.sendDeploymentResult('u1', 'app', 'success');

    expect(sendMail).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).toHaveBeenCalled();
  });

  it('deployFail toggle does not block a success email (and vice versa)', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      email: 'u@test',
      name: 'U',
      notificationPrefs: { deployFail: { email: false } },
    });
    prisma.user.findMany.mockResolvedValue([]);

    await service.sendDeploymentResult('u1', 'app', 'success');
    expect(sendMail).toHaveBeenCalledTimes(1);

    sendMail.mockClear();
    await service.sendDeploymentResult('u1', 'app', 'failed', 'boom');
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('sendBackupResult', () => {
  const baseInput = {
    backupId: 'b1',
    name: 'nightly-db',
    serverId: 's1',
    status: 'COMPLETED' as const,
  };

  it('emails admins who have not opted out of backupOk', async () => {
    const { service, prisma, sendMail } = makeService();
    // First findMany: getActiveAdminIds (select id); second: recipients.
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }])
      .mockResolvedValueOnce([
        { email: 'a1@test', notificationPrefs: null },
        { email: 'a2@test', notificationPrefs: { backupOk: { email: false } } },
      ]);

    await service.sendBackupResult(baseInput);

    expect(prisma.notification.createMany).toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('a1@test');
    expect(sendMail.mock.calls[0][0].subject).toContain('Backup completed');
  });

  it('sends no email when every admin opted out, feed still written', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([
        { email: 'a1@test', notificationPrefs: { backupFail: { email: false } } },
      ]);

    await service.sendBackupResult({
      ...baseInput,
      status: 'FAILED',
      error: 'disk full',
    });

    expect(sendMail).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).toHaveBeenCalled();
  });

  it('FAILED uses backupFail toggle, not backupOk', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([
        // Opted out of backupOk only → FAILED email must still go out.
        { email: 'a1@test', notificationPrefs: { backupOk: { email: false } } },
      ]);

    await service.sendBackupResult({
      ...baseInput,
      status: 'FAILED',
      error: 'boom',
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].subject).toContain('Backup failed');
  });

  it('never throws — DB failure is swallowed and logged', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.sendBackupResult(baseInput)).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('sendServerOffline', () => {
  const input = {
    serverId: 's1',
    name: 'vps-1',
    host: '10.0.0.5',
    lastSeenAt: new Date('2026-06-10T10:00:00Z'),
  };

  it('emails admins who have not opted out of serverOff', async () => {
    const { service, prisma, sendMail } = makeService();
    // First findMany: getActiveAdminIds (select id); second: recipients.
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }])
      .mockResolvedValueOnce([
        { email: 'a1@test', notificationPrefs: null },
        { email: 'a2@test', notificationPrefs: { serverOff: { email: false } } },
      ]);

    await service.sendServerOffline(input);

    expect(prisma.notification.createMany).toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('a1@test');
    expect(sendMail.mock.calls[0][0].subject).toContain('Server offline');
  });

  it('sends no email when every admin opted out, feed still written', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([
        { email: 'a1@test', notificationPrefs: { serverOff: { email: false } } },
      ]);

    await service.sendServerOffline(input);

    expect(sendMail).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).toHaveBeenCalled();
  });

  it('unrelated toggles (sslExpire) do not block serverOff emails', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([
        { email: 'a1@test', notificationPrefs: { sslExpire: { email: false } } },
      ]);

    await service.sendServerOffline(input);

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('handles lastSeenAt null without throwing', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([{ email: 'a1@test', notificationPrefs: null }]);

    await expect(
      service.sendServerOffline({ ...input, lastSeenAt: null }),
    ).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('never throws — DB failure is swallowed and logged', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.sendServerOffline(input)).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('sendSslExpiry', () => {
  const input = {
    domain: 'shop.example.com',
    expiresAt: new Date('2026-06-20T00:00:00Z'),
    daysLeft: 10,
  };

  it('emails admins who have not opted out of sslExpire', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }])
      .mockResolvedValueOnce([
        { email: 'a1@test', notificationPrefs: null },
        { email: 'a2@test', notificationPrefs: { sslExpire: { email: false } } },
      ]);

    await service.sendSslExpiry(input);

    expect(prisma.notification.createMany).toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('a1@test');
    expect(sendMail.mock.calls[0][0].subject).toContain('SSL certificate expiring');
    expect(sendMail.mock.calls[0][0].subject).toContain('shop.example.com');
  });

  it('daysLeft <= 0 uses the "expired" wording', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([{ email: 'a1@test', notificationPrefs: null }]);

    await service.sendSslExpiry({ ...input, daysLeft: 0 });

    expect(sendMail.mock.calls[0][0].subject).toContain('SSL certificate expired');
  });

  it('sends no email when every admin opted out, feed still written', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([
        { email: 'a1@test', notificationPrefs: { sslExpire: { email: false } } },
      ]);

    await service.sendSslExpiry(input);

    expect(sendMail).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).toHaveBeenCalled();
  });

  it('unrelated toggles (serverOff) do not block sslExpire emails', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockResolvedValueOnce([
        { email: 'a1@test', notificationPrefs: { serverOff: { email: false } } },
      ]);

    await service.sendSslExpiry(input);

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('never throws — DB failure is swallowed and logged', async () => {
    const { service, prisma, sendMail } = makeService();
    prisma.user.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.sendSslExpiry(input)).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
