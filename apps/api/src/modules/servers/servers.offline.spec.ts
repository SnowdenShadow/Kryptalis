import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ServersService } from './servers.service';

/**
 * Offline-sweep logic tests — every dependency is a plain object of
 * vi.fn()s, same approach as notifications.prefs.spec.ts (no DB, no
 * TestingModule).
 */
function makeService() {
  const prisma = {
    server: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const encryption = { hash: vi.fn() };
  const systemConfig = { getNumber: vi.fn().mockReturnValue(undefined) };
  const notifications = {
    sendServerOffline: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ServersService(
    prisma as any,
    encryption as any,
    systemConfig as any,
    notifications as any,
  );
  return { service, prisma, notifications };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sweepOfflineServers', () => {
  it('flips a stale ONLINE server to OFFLINE and notifies', async () => {
    const { service, prisma, notifications } = makeService();
    const lastSeenAt = new Date(Date.now() - 5 * 60 * 1000);
    prisma.server.findMany.mockResolvedValue([
      { id: 's1', name: 'vps-1', host: '10.0.0.5', lastSeenAt },
    ]);

    const res = await service.sweepOfflineServers();

    expect(res).toEqual({ flipped: 1 });
    expect(prisma.server.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'ONLINE' },
      data: { status: 'OFFLINE' },
    });
    expect(notifications.sendServerOffline).toHaveBeenCalledWith({
      serverId: 's1',
      name: 'vps-1',
      host: '10.0.0.5',
      lastSeenAt,
    });
  });

  it('queries only ONLINE non-local servers past the staleness cutoff', async () => {
    const { service, prisma } = makeService();
    const before = Date.now();
    await service.sweepOfflineServers();
    const after = Date.now();

    const where = prisma.server.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('ONLINE');
    // Local server is excluded — it never heartbeats via the agent.
    expect(where.host).toEqual({ notIn: ['127.0.0.1', 'localhost', '::1'] });
    // Threshold = 90 s (3× the slowest built-in heartbeat cadence of 30 s).
    const cutoff = (where.lastSeenAt.lt as Date).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - 90_000);
    expect(cutoff).toBeLessThanOrEqual(after - 90_000);
  });

  it('a server already OFFLINE is never scanned → no re-notify', async () => {
    const { service, prisma, notifications } = makeService();
    // findMany filters on status ONLINE — an OFFLINE row is simply absent.
    prisma.server.findMany.mockResolvedValue([]);

    const res = await service.sweepOfflineServers();

    expect(res).toEqual({ flipped: 0 });
    expect(prisma.server.updateMany).not.toHaveBeenCalled();
    expect(notifications.sendServerOffline).not.toHaveBeenCalled();
  });

  it('a heartbeat racing the sweep (guarded flip count=0) suppresses the notification', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.server.findMany.mockResolvedValue([
      { id: 's1', name: 'vps-1', host: '10.0.0.5', lastSeenAt: new Date(0) },
    ]);
    // count 0 ⇒ another writer (heartbeat/poll) changed the row between the
    // findMany snapshot and the guarded update — server is no longer ONLINE
    // under our guard, so we must not notify.
    prisma.server.updateMany.mockResolvedValue({ count: 0 });

    const res = await service.sweepOfflineServers();

    expect(res).toEqual({ flipped: 0 });
    expect(notifications.sendServerOffline).not.toHaveBeenCalled();
  });

  it('one notification per stale server in the same sweep', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.server.findMany.mockResolvedValue([
      { id: 's1', name: 'vps-1', host: '10.0.0.5', lastSeenAt: new Date(0) },
      { id: 's2', name: 'vps-2', host: '10.0.0.6', lastSeenAt: new Date(0) },
    ]);

    const res = await service.sweepOfflineServers();

    expect(res).toEqual({ flipped: 2 });
    expect(notifications.sendServerOffline).toHaveBeenCalledTimes(2);
  });
});
