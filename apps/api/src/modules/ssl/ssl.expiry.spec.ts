import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SslService } from './ssl.service';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Expiry-sweep logic tests — plain vi.fn() dependency objects, same
 * approach as notifications.prefs.spec.ts (no DB, no TestingModule).
 */
function makeService() {
  const prisma = {
    sSLCertificate: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    domain: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ role: 'SUPERADMIN' }),
    },
  };
  const notifications = {
    sendSslExpiry: vi.fn().mockResolvedValue(undefined),
  };
  const proxy = {
    regenerate: vi.fn().mockResolvedValue({ domains: 1, caddyfile: '' }),
  };
  const service = new SslService(prisma as any, notifications as any, proxy as any);
  return { service, prisma, notifications, proxy };
}

function cert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    expiresAt: new Date(Date.now() + 10 * DAY),
    expiryNotifiedAt: null,
    domain: { domain: 'shop.example.com' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sweepExpiringCertificates', () => {
  it('queries certs expiring within the 14-day window', async () => {
    const { service, prisma } = makeService();
    const before = Date.now();
    await service.sweepExpiringCertificates();
    const after = Date.now();

    const where = prisma.sSLCertificate.findMany.mock.calls[0][0].where;
    const horizon = (where.expiresAt.lte as Date).getTime();
    expect(horizon).toBeGreaterThanOrEqual(before + 14 * DAY);
    expect(horizon).toBeLessThanOrEqual(after + 14 * DAY);
  });

  it('notifies and stamps expiryNotifiedAt for an un-notified expiring cert', async () => {
    const { service, prisma, notifications } = makeService();
    const expiresAt = new Date(Date.now() + 10 * DAY);
    prisma.sSLCertificate.findMany.mockResolvedValue([cert({ expiresAt })]);

    const res = await service.sweepExpiringCertificates();

    expect(res).toEqual({ notified: 1 });
    expect(prisma.sSLCertificate.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { expiryNotifiedAt: expect.any(Date) },
    });
    expect(notifications.sendSslExpiry).toHaveBeenCalledWith({
      domain: 'shop.example.com',
      expiresAt,
      daysLeft: 10,
    });
  });

  it('dedupe: a cert already notified within the current window is skipped', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.sSLCertificate.findMany.mockResolvedValue([
      cert({
        expiresAt: new Date(Date.now() + 10 * DAY),
        // Notified yesterday — inside the current 14-day window.
        expiryNotifiedAt: new Date(Date.now() - 1 * DAY),
      }),
    ]);

    const res = await service.sweepExpiringCertificates();

    expect(res).toEqual({ notified: 0 });
    expect(notifications.sendSslExpiry).not.toHaveBeenCalled();
    expect(prisma.sSLCertificate.update).not.toHaveBeenCalled();
  });

  it('re-arms after renewal: stamp from a previous window does not block', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.sSLCertificate.findMany.mockResolvedValue([
      cert({
        // Renewed cert now expiring in 10 days again, but the old stamp is
        // from 80 days ago — before the new window start (expiresAt − 14d).
        expiresAt: new Date(Date.now() + 10 * DAY),
        expiryNotifiedAt: new Date(Date.now() - 80 * DAY),
      }),
    ]);

    const res = await service.sweepExpiringCertificates();

    expect(res).toEqual({ notified: 1 });
    expect(notifications.sendSslExpiry).toHaveBeenCalledTimes(1);
  });

  it('an already-expired cert reports daysLeft <= 0', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.sSLCertificate.findMany.mockResolvedValue([
      cert({ expiresAt: new Date(Date.now() - 2 * DAY) }),
    ]);

    await service.sweepExpiringCertificates();

    expect(notifications.sendSslExpiry).toHaveBeenCalledTimes(1);
    expect(
      notifications.sendSslExpiry.mock.calls[0][0].daysLeft,
    ).toBeLessThanOrEqual(0);
  });

  it('stamps before dispatching so a notify crash cannot re-loop daily', async () => {
    const { service, prisma, notifications } = makeService();
    const order: string[] = [];
    prisma.sSLCertificate.findMany.mockResolvedValue([cert()]);
    prisma.sSLCertificate.update.mockImplementation(async () => {
      order.push('stamp');
      return {};
    });
    notifications.sendSslExpiry.mockImplementation(async () => {
      order.push('notify');
    });

    await service.sweepExpiringCertificates();

    expect(order).toEqual(['stamp', 'notify']);
  });
});

describe('issue', () => {
  it('marks the domain PENDING and triggers a Caddy regenerate (no agent task)', async () => {
    const { service, prisma, proxy } = makeService();
    prisma.domain.findUnique.mockResolvedValue({
      id: 'd1',
      domain: 'shop.example.com',
      projectId: null,
      applicationId: 'app1',
    });

    const res = await service.issue('admin-user', 'd1');

    expect(prisma.domain.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { sslStatus: 'PENDING' },
    });
    expect(proxy.regenerate).toHaveBeenCalledTimes(1);
    expect(res.message).toContain('reverse proxy');
  });

  it('rejects local-only hostnames (no ACME possible)', async () => {
    const { service, prisma, proxy } = makeService();
    prisma.domain.findUnique.mockResolvedValue({
      id: 'd2',
      domain: 'myapp.local',
      projectId: null,
      applicationId: null,
    });

    await expect(service.issue('admin-user', 'd2')).rejects.toThrow(/local hostname/);
    expect(proxy.regenerate).not.toHaveBeenCalled();
    expect(prisma.domain.update).not.toHaveBeenCalled();
  });

  it('404s on unknown domain', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(null);
    await expect(service.issue('admin-user', 'nope')).rejects.toThrow('Domain not found');
  });

  it('forbids non-admins on orphan domains', async () => {
    const { service, prisma, proxy } = makeService();
    prisma.domain.findUnique.mockResolvedValue({
      id: 'd3',
      domain: 'orphan.example.com',
      projectId: null,
    });
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });

    await expect(service.issue('regular-user', 'd3')).rejects.toThrow(/platform ADMIN/);
    expect(proxy.regenerate).not.toHaveBeenCalled();
  });
});
