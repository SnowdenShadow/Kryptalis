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
    // Watchdog now reads the REAL source of truth (Domain.sslExpiresAt /
    // sslStatus, reconciled by Caddy) — the ssl_certificates table was never
    // populated, so the old sweep was inert.
    sSLCertificate: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    domain: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
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
    scheduleReload: vi.fn(),
    certExists: vi.fn().mockResolvedValue(false),
    getAcmeLogsForDomain: vi.fn().mockResolvedValue([]),
  };
  const domains = {
    getDnsHealth: vi.fn().mockResolvedValue({ checks: { a: { status: 'OK', message: 'A → 1.2.3.4' } } }),
  };
  const service = new SslService(prisma as any, notifications as any, proxy as any, domains as any);
  return { service, prisma, notifications, proxy, domains };
}

function domainRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    domain: 'shop.example.com',
    sslExpiresAt: new Date(Date.now() + 10 * DAY),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sweepExpiringCertificates', () => {
  it('queries Domain rows expiring within the 14-day window (real source of truth)', async () => {
    const { service, prisma } = makeService();
    const before = Date.now();
    await service.sweepExpiringCertificates();
    const after = Date.now();

    // Reads Domain.sslExpiresAt/sslStatus, NOT the never-populated
    // ssl_certificates table.
    expect(prisma.sSLCertificate.findMany).not.toHaveBeenCalled();
    const where = prisma.domain.findMany.mock.calls[0][0].where;
    const horizon = (where.sslExpiresAt.lte as Date).getTime();
    expect(horizon).toBeGreaterThanOrEqual(before + 14 * DAY);
    expect(horizon).toBeLessThanOrEqual(after + 14 * DAY);
    // Only domains that actually had SSL (ACTIVE/EXPIRED) are nagged about.
    expect(where.sslStatus.in).toEqual(['ACTIVE', 'EXPIRED']);
  });

  it('notifies for an un-notified expiring domain', async () => {
    const { service, prisma, notifications } = makeService();
    const expiresAt = new Date(Date.now() + 10 * DAY);
    prisma.domain.findMany.mockResolvedValue([domainRow({ sslExpiresAt: expiresAt })]);

    const res = await service.sweepExpiringCertificates();

    expect(res).toEqual({ notified: 1 });
    expect(notifications.sendSslExpiry).toHaveBeenCalledWith({
      domain: 'shop.example.com',
      expiresAt,
      daysLeft: 10,
    });
  });

  it('dedupe: a domain already notified for the same expiry is skipped on the next sweep', async () => {
    const { service, prisma, notifications } = makeService();
    const expiresAt = new Date(Date.now() + 10 * DAY);
    prisma.domain.findMany.mockResolvedValue([domainRow({ sslExpiresAt: expiresAt })]);

    // First sweep notifies; the in-memory ledger then suppresses the second.
    await service.sweepExpiringCertificates();
    const res = await service.sweepExpiringCertificates();

    expect(res).toEqual({ notified: 0 });
    expect(notifications.sendSslExpiry).toHaveBeenCalledTimes(1);
  });

  it('re-arms after renewal: a later expiry re-triggers the warning', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.domain.findMany.mockResolvedValue([
      domainRow({ sslExpiresAt: new Date(Date.now() + 10 * DAY) }),
    ]);
    await service.sweepExpiringCertificates();

    // Renewal pushes expiry forward → new value > stamped value → re-arm.
    prisma.domain.findMany.mockResolvedValue([
      domainRow({ sslExpiresAt: new Date(Date.now() + 60 * DAY) }),
    ]);
    const res = await service.sweepExpiringCertificates();

    expect(res).toEqual({ notified: 1 });
    expect(notifications.sendSslExpiry).toHaveBeenCalledTimes(2);
  });

  it('an already-expired domain reports daysLeft <= 0', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.domain.findMany.mockResolvedValue([
      domainRow({ sslExpiresAt: new Date(Date.now() - 2 * DAY) }),
    ]);

    await service.sweepExpiringCertificates();

    expect(notifications.sendSslExpiry).toHaveBeenCalledTimes(1);
    expect(
      notifications.sendSslExpiry.mock.calls[0][0].daysLeft,
    ).toBeLessThanOrEqual(0);
  });
});

describe('issue', () => {
  it('marks the domain PENDING and schedules a debounced Caddy reload (no agent task, no inline regenerate)', async () => {
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
    expect(proxy.scheduleReload).toHaveBeenCalledTimes(1);
    // Costly path (Caddyfile rewrite + docker exec reload) must go through
    // the debounce — never called inline from issue().
    expect(proxy.regenerate).not.toHaveBeenCalled();
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
    expect(proxy.scheduleReload).not.toHaveBeenCalled();
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
    expect(proxy.scheduleReload).not.toHaveBeenCalled();
    expect(proxy.regenerate).not.toHaveBeenCalled();
  });
});

describe('diagnose', () => {
  it('aggregates DNS + ports + cert checks for a public domain', async () => {
    const { service, prisma, proxy, domains } = makeService();
    prisma.domain.findUnique.mockResolvedValue({ id: 'd1', domain: 'shop.example.com', projectId: null, sslStatus: 'PENDING' });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    domains.getDnsHealth.mockResolvedValue({ checks: { a: { status: 'FAIL', message: 'No A record' } } });
    proxy.certExists.mockResolvedValue(false);
    // No PUBLIC_API_URL → ports check downgrades to a WARN (still produces a check).
    const res = await service.diagnose('admin', 'd1');
    expect(res.domain).toBe('shop.example.com');
    const keys = res.checks.map((c) => c.key);
    expect(keys).toContain('dns');
    expect(keys).toContain('cert');
    expect(res.checks.find((c) => c.key === 'dns')!.status).toBe('FAIL');
    expect(res.checks.find((c) => c.key === 'cert')!.status).toBe('FAIL');
  });

  it('short-circuits a local hostname with a clear FAIL', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue({ id: 'd2', domain: 'app.local', projectId: null, sslStatus: 'PENDING' });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    const res = await service.diagnose('admin', 'd2');
    expect(res.checks).toHaveLength(1);
    expect(res.checks[0].key).toBe('local');
    expect(res.checks[0].status).toBe('FAIL');
  });

  it('getLogs returns the proxy-filtered Caddy lines', async () => {
    const { service, prisma, proxy } = makeService();
    prisma.domain.findUnique.mockResolvedValue({ id: 'd1', domain: 'shop.example.com', projectId: null });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    proxy.getAcmeLogsForDomain.mockResolvedValue(['acme: obtaining certificate for shop.example.com']);
    const res = await service.getLogs('admin', 'd1', 100);
    expect(proxy.getAcmeLogsForDomain).toHaveBeenCalledWith('shop.example.com', 100);
    expect(res.lines[0]).toMatch(/obtaining certificate/);
  });
});
