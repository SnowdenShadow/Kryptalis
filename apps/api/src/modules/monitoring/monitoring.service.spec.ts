import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
}));

import { assertProjectAccess } from '../../common/rbac/project-access';
import { MonitoringService } from './monitoring.service';

const mockAssert = vi.mocked(assertProjectAccess);

/**
 * Pure service-level tests: plain vi.fn() prisma + notifications, no DB.
 * The private metric math (metricValue/compareThreshold/downsample) is
 * exercised through the public getMetrics / evaluateAlerts surfaces, plus a
 * couple of direct calls via `(service as any)` where that's clearer.
 */
function makePrisma() {
  return {
    user: { findUnique: vi.fn() },
    server: { findMany: vi.fn().mockResolvedValue([]) },
    projectMember: { findMany: vi.fn().mockResolvedValue([]) },
    serverMetric: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    application: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    containerMetric: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    alertRule: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'r1' }),
      update: vi.fn().mockResolvedValue({ id: 'r1' }),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeService() {
  const prisma = makePrisma();
  const notifications = {
    sendAlert: vi.fn().mockResolvedValue(undefined),
    validateWebhookUrl: vi.fn().mockReturnValue(null), // null = safe
  };
  // Leader guard OFF so onModuleInit never arms a timer in tests.
  const schedulerLeader = { shouldRun: vi.fn().mockReturnValue(false) };
  const service = new MonitoringService(prisma as any, notifications as any, schedulerLeader as any);
  return { service, prisma, notifications, schedulerLeader };
}

function metricRow(over: Partial<any> = {}) {
  return {
    id: 'm1',
    serverId: 's1',
    cpuPercent: 10,
    memoryUsed: 0n,
    memoryTotal: 100n,
    diskUsed: 0n,
    diskTotal: 100n,
    networkIn: 0n,
    networkOut: 0n,
    timestamp: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssert.mockResolvedValue('VIEWER' as any);
});

describe('metricValue (via getMetrics/evaluate paths)', () => {
  const call = (service: any, metric: string, row: any, op?: string) =>
    service.metricValue(metric, row, op);

  it('cpu returns the raw percent regardless of operator', () => {
    const { service } = makeService();
    expect(call(service, 'cpu', metricRow({ cpuPercent: 73.5 }))).toBe(73.5);
    expect(call(service, 'cpu', metricRow({ cpuPercent: 73.5 }), 'LT')).toBe(73.5);
  });

  it('memory: GT/GTE use USED %', () => {
    const { service } = makeService();
    const row = metricRow({ memoryUsed: 90n, memoryTotal: 100n });
    expect(call(service, 'memory', row, 'GTE')).toBe(90);
  });

  it('memory: LT/LTE flip to FREE % (free fell below floor)', () => {
    const { service } = makeService();
    const row = metricRow({ memoryUsed: 90n, memoryTotal: 100n });
    // 90% used → 10% free.
    expect(call(service, 'memory', row, 'LT')).toBe(10);
  });

  it('disk: same free-flip semantics as memory', () => {
    const { service } = makeService();
    const row = metricRow({ diskUsed: 75n, diskTotal: 100n });
    expect(call(service, 'disk', row, 'GTE')).toBe(75);
    expect(call(service, 'disk', row, 'LTE')).toBe(25);
  });

  it('returns null when total is 0 (avoids divide-by-zero) or metric is unknown', () => {
    const { service } = makeService();
    expect(call(service, 'memory', metricRow({ memoryTotal: 0n }))).toBeNull();
    expect(call(service, 'disk', metricRow({ diskTotal: 0n }))).toBeNull();
    expect(call(service, 'bogus', metricRow())).toBeNull();
  });
});

describe('compareThreshold', () => {
  const cases: Array<[string, number, number, boolean]> = [
    ['GT', 91, 90, true],
    ['GT', 90, 90, false],
    ['GTE', 90, 90, true],
    ['LT', 9, 10, true],
    ['LTE', 10, 10, true],
    ['EQ', 50, 50, true],
    ['EQ', 51, 50, false],
    ['WEIRD', 91, 90, true], // default → >=
  ];
  it.each(cases)('%s %d vs %d → %s', (op, value, threshold, expected) => {
    const { service } = makeService();
    expect((service as any).compareThreshold(value, op, threshold)).toBe(expected);
  });
});

describe('evaluateAlerts', () => {
  const run = (service: any) => (service as any).evaluateAlerts();

  it('does nothing when there are no enabled rules', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.alertRule.findMany.mockResolvedValue([]);
    await run(service);
    expect(prisma.serverMetric.findFirst).not.toHaveBeenCalled();
    expect(notifications.sendAlert).not.toHaveBeenCalled();
  });

  it('fetches each server\'s latest sample once even with multiple rules on it', async () => {
    const { service, prisma } = makeService();
    prisma.alertRule.findMany.mockResolvedValue([
      { id: 'r1', serverId: 's1', metric: 'cpu', operator: 'GT', threshold: 5 },
      { id: 'r2', serverId: 's1', metric: 'memory', operator: 'GT', threshold: 200 },
    ]);
    prisma.serverMetric.findFirst.mockResolvedValue(metricRow({ cpuPercent: 50 }));

    await run(service);
    // One findFirst per server, not per rule.
    expect(prisma.serverMetric.findFirst).toHaveBeenCalledTimes(1);
  });

  it('fires sendAlert only for rules whose threshold is crossed', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.alertRule.findMany.mockResolvedValue([
      { id: 'hot', serverId: 's1', metric: 'cpu', operator: 'GT', threshold: 40 },
      { id: 'cold', serverId: 's1', metric: 'cpu', operator: 'GT', threshold: 99 },
    ]);
    prisma.serverMetric.findFirst.mockResolvedValue(metricRow({ cpuPercent: 50 }));

    await run(service);
    expect(notifications.sendAlert).toHaveBeenCalledTimes(1);
    expect(notifications.sendAlert.mock.calls[0][0].id).toBe('hot');
    expect(notifications.sendAlert.mock.calls[0][1]).toBe(50);
  });

  it('skips a server with no metric sample yet', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.alertRule.findMany.mockResolvedValue([
      { id: 'r1', serverId: 's1', metric: 'cpu', operator: 'GT', threshold: 1 },
    ]);
    prisma.serverMetric.findFirst.mockResolvedValue(null);
    await run(service);
    expect(notifications.sendAlert).not.toHaveBeenCalled();
  });

  it('a rejected sendAlert does not crash the eval loop', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.alertRule.findMany.mockResolvedValue([
      { id: 'r1', serverId: 's1', metric: 'cpu', operator: 'GT', threshold: 1 },
    ]);
    prisma.serverMetric.findFirst.mockResolvedValue(metricRow({ cpuPercent: 99 }));
    notifications.sendAlert.mockRejectedValue(new Error('smtp down'));
    await expect(run(service)).resolves.toBeUndefined();
  });
});

describe('accessibleServerIds / getMetrics RBAC', () => {
  it('platform admin sees the whole fleet', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.server.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

    const ids = await (service as any).accessibleServerIds('u1');
    expect(ids.sort()).toEqual(['s1', 's2']);
  });

  it('a regular user sees the union of servers hosting their projects\' apps + DBs', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.projectMember.findMany.mockResolvedValue([
      { project: { applications: [{ serverId: 'sA' }], databases: [{ serverId: 'sB' }] } },
      { project: { applications: [{ serverId: 'sA' }], databases: [] } },
    ]);

    const ids = await (service as any).accessibleServerIds('u1');
    expect(ids.sort()).toEqual(['sA', 'sB']);
  });

  it('getMetrics forbids a server the caller cannot see', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.projectMember.findMany.mockResolvedValue([]);

    await expect(service.getMetrics('u1', 'sX')).rejects.toThrow(ForbiddenException);
    expect(prisma.serverMetric.findMany).not.toHaveBeenCalled();
  });

  it('getMetrics returns raw rows as-is for a 24h window', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.server.findMany.mockResolvedValue([{ id: 's1' }]);
    const rows = [metricRow(), metricRow({ id: 'm2' })];
    prisma.serverMetric.findMany.mockResolvedValue(rows);

    const res = await service.getMetrics('u1', 's1', '24h');
    expect(res).toBe(rows); // untouched, no downsample
  });
});

describe('downsample (via getMetrics on a wide window)', () => {
  it('buckets a 7d window into hourly averages', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.server.findMany.mockResolvedValue([{ id: 's1' }]);
    // Two samples in the SAME hour → collapse to one averaged bucket.
    const base = new Date('2026-06-01T10:00:00Z').getTime();
    prisma.serverMetric.findMany.mockResolvedValue([
      metricRow({ id: 'a', cpuPercent: 20, memoryUsed: 40n, memoryTotal: 100n, timestamp: new Date(base) }),
      metricRow({ id: 'b', cpuPercent: 40, memoryUsed: 60n, memoryTotal: 100n, timestamp: new Date(base + 60_000) }),
    ]);

    const res: any[] = await service.getMetrics('u1', 's1', '7d');
    expect(res).toHaveLength(1);
    expect(res[0].cpuPercent).toBe(30); // (20+40)/2
    expect(res[0].memoryUsed).toBe(50n); // (40+60)/2 as bigint
    expect(res[0].id).toBe('a'); // first-in-bucket id preserved
  });

  it('keeps distinct hours as separate buckets, sorted ascending', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.server.findMany.mockResolvedValue([{ id: 's1' }]);
    const h1 = new Date('2026-06-01T10:00:00Z');
    const h2 = new Date('2026-06-01T12:00:00Z');
    prisma.serverMetric.findMany.mockResolvedValue([
      metricRow({ id: 'late', timestamp: h2 }),
      metricRow({ id: 'early', timestamp: h1 }),
    ]);

    const res: any[] = await service.getMetrics('u1', 's1', '7d');
    expect(res).toHaveLength(2);
    expect(res[0].timestamp.getTime()).toBeLessThan(res[1].timestamp.getTime());
  });
});

describe('alert rule CRUD', () => {
  it('createAlertRule rejects an unsafe webhookUrl (SSRF screen) before persisting', async () => {
    const { service, prisma, notifications } = makeService();
    notifications.validateWebhookUrl.mockReturnValue('resolves to a private IP');

    await expect(
      service.createAlertRule({ webhookUrl: 'http://169.254.169.254' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.alertRule.create).not.toHaveBeenCalled();
  });

  it('createAlertRule persists when the webhook is safe (or absent)', async () => {
    const { service, prisma } = makeService();
    await service.createAlertRule({ metric: 'cpu', threshold: 90 } as any);
    expect(prisma.alertRule.create).toHaveBeenCalled();
  });

  it('updateAlertRule 404s on a missing rule', async () => {
    const { service, prisma } = makeService();
    prisma.alertRule.findUnique.mockResolvedValue(null);
    await expect(service.updateAlertRule('rX', {} as any)).rejects.toThrow(NotFoundException);
  });

  it('updateAlertRule re-screens the webhookUrl on update', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.alertRule.findUnique.mockResolvedValue({ id: 'r1' });
    notifications.validateWebhookUrl.mockReturnValue('bad');
    await expect(service.updateAlertRule('r1', { webhookUrl: 'http://x' } as any)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.alertRule.update).not.toHaveBeenCalled();
  });

  it('getAlertRules scopes to accessible servers; forbids an explicit out-of-scope serverId', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.projectMember.findMany.mockResolvedValue([
      { project: { applications: [{ serverId: 'sA' }], databases: [] } },
    ]);

    await service.getAlertRules('u1');
    expect(prisma.alertRule.findMany.mock.calls[0][0].where.serverId).toEqual({ in: ['sA'] });

    await expect(service.getAlertRules('u1', 'sZ')).rejects.toThrow(ForbiddenException);
  });

  it('deleteAlertRule 404s on missing, else deletes', async () => {
    const { service, prisma } = makeService();
    prisma.alertRule.findUnique.mockResolvedValue(null);
    await expect(service.deleteAlertRule('rX')).rejects.toThrow(NotFoundException);

    prisma.alertRule.findUnique.mockResolvedValue({ id: 'r1' });
    const res = await service.deleteAlertRule('r1');
    expect(res).toEqual({ message: 'Alert rule deleted' });
    expect(prisma.alertRule.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });
});

function cmRow(over: Partial<any> = {}) {
  return {
    id: 'cm1', serverId: 's1', applicationId: 'a1', containerName: 'dockcontrol-shop',
    cpuPercent: 10, memoryUsed: 100n, memoryLimit: 500n,
    networkIn: 0n, networkOut: 0n, blockRead: 0n, blockWrite: 0n,
    timestamp: new Date('2026-06-01T10:00:00Z'), ...over,
  };
}

describe('getAppMetrics (container history)', () => {
  it('404s on a missing application before any RBAC', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue(null);
    await expect(service.getAppMetrics('u1', 'aX')).rejects.toThrow(NotFoundException);
    expect(mockAssert).not.toHaveBeenCalled();
  });

  it('enforces VIEWER on the app\'s project', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p1' });
    await service.getAppMetrics('u1', 'a1', '24h');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'VIEWER');
  });

  it('returns raw rows for a 24h window (no downsample)', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p1' });
    const rows = [cmRow(), cmRow({ id: 'cm2' })];
    prisma.containerMetric.findMany.mockResolvedValue(rows);
    const res = await service.getAppMetrics('u1', 'a1', '24h');
    expect(res).toBe(rows);
  });

  it('downsamples a 7d window per containerName (keeps multi-container split)', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p1' });
    const base = new Date('2026-06-01T10:00:00Z').getTime();
    prisma.containerMetric.findMany.mockResolvedValue([
      cmRow({ id: 'a', containerName: 'dockcontrol-web', cpuPercent: 20, memoryUsed: 40n, timestamp: new Date(base) }),
      cmRow({ id: 'b', containerName: 'dockcontrol-web', cpuPercent: 40, memoryUsed: 60n, timestamp: new Date(base + 60_000) }),
      cmRow({ id: 'c', containerName: 'dockcontrol-web-fpm', cpuPercent: 5, memoryUsed: 10n, timestamp: new Date(base) }),
    ]);
    const res: any[] = await service.getAppMetrics('u1', 'a1', '7d');
    // Two containers → two buckets (same hour). web is averaged (20+40)/2=30.
    expect(res).toHaveLength(2);
    const web = res.find((r) => r.containerName === 'dockcontrol-web');
    expect(web.cpuPercent).toBe(30);
    expect(web.memoryUsed).toBe(50n);
    expect(res.find((r) => r.containerName === 'dockcontrol-web-fpm')).toBeDefined();
  });
});

describe('getContainerOverview', () => {
  it('returns [] when the caller can see no servers', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.projectMember.findMany.mockResolvedValue([]);
    expect(await service.getContainerOverview('u1')).toEqual([]);
    expect(prisma.containerMetric.findMany).not.toHaveBeenCalled();
  });

  it('keeps only the newest row per (server, container)', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.server.findMany.mockResolvedValue([{ id: 's1' }]);
    // Rows arrive desc by timestamp — first per key wins.
    prisma.containerMetric.findMany.mockResolvedValue([
      cmRow({ id: 'new', containerName: 'dockcontrol-shop', cpuPercent: 50 }),
      cmRow({ id: 'old', containerName: 'dockcontrol-shop', cpuPercent: 10 }),
      cmRow({ id: 'other', containerName: 'dockcontrol-api' }),
    ]);
    const res = await service.getContainerOverview('u1');
    expect(res).toHaveLength(2);
    expect(res.find((r: any) => r.containerName === 'dockcontrol-shop')?.id).toBe('new');
  });
});

describe('pruneContainerMetrics', () => {
  it('deletes rows older than the retention window (7d) and never throws', async () => {
    const { service, prisma } = makeService();
    prisma.containerMetric.deleteMany.mockResolvedValue({ count: 3 });
    await expect(service.pruneContainerMetrics()).resolves.toBeUndefined();
    const arg = prisma.containerMetric.deleteMany.mock.calls[0][0];
    const ageMs = Date.now() - arg.where.timestamp.lt.getTime();
    expect(ageMs).toBeGreaterThan(6.5 * 864e5);
    expect(ageMs).toBeLessThan(7.5 * 864e5);
  });

  it('swallows a delete failure', async () => {
    const { service, prisma } = makeService();
    prisma.containerMetric.deleteMany.mockRejectedValue(new Error('db down'));
    await expect(service.pruneContainerMetrics()).resolves.toBeUndefined();
  });
});

describe('collectLocalContainerStats', () => {
  it('no local server → no-op (no createMany)', async () => {
    const { service, prisma } = makeService();
    prisma.server.findMany.mockResolvedValue([{ id: 's1', host: '10.0.0.9' }]); // remote only
    await service.collectLocalContainerStats();
    expect(prisma.containerMetric.createMany).not.toHaveBeenCalled();
  });
});
