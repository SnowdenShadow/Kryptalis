import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';

/**
 * ServersService unit tests — plain vi.fn() dependencies, no DB, no real
 * shell. Pattern: projects.service.spec.ts.
 *
 * Deliberately NOT covered here: the offline-detection tick
 * (sweepOfflineServers / OnModuleInit intervals) — owned and tested by the
 * concurrent offline-tick change. We instantiate the service directly and
 * never call onModuleInit(), so no timers ever start.
 *
 * - child_process.exec mocked (promisify.custom) → df/ps/docker outputs are
 *   deterministic.
 * - os mocked → linux-shaped stats regardless of the CI host platform.
 * - fs.readFileSync mocked for /proc/net/dev.
 */

const { execAsyncMock } = vi.hoisted(() => ({ execAsyncMock: vi.fn() }));

vi.mock('child_process', async () => {
  const util = await import('util');
  const exec: any = vi.fn();
  exec[util.promisify.custom] = (...args: unknown[]) => execAsyncMock(...args);
  return { exec };
});

vi.mock('os', () => {
  const cpu = {
    model: 'Mock CPU @ 3.0GHz',
    speed: 3000,
    times: { user: 600, nice: 0, sys: 200, idle: 200, irq: 0 }, // 80% busy
  };
  const mocked = {
    hostname: vi.fn().mockReturnValue('mock-host'),
    platform: vi.fn().mockReturnValue('linux'),
    release: vi.fn().mockReturnValue('6.1.0-mock'),
    arch: vi.fn().mockReturnValue('x64'),
    cpus: vi.fn().mockReturnValue([cpu, cpu]),
    totalmem: vi.fn().mockReturnValue(8_000_000_000),
    freemem: vi.fn().mockReturnValue(2_000_000_000),
    uptime: vi.fn().mockReturnValue(90_061), // 1d 1h 1m
    loadavg: vi.fn().mockReturnValue([0.5, 0.7, 0.9]),
    networkInterfaces: vi.fn().mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    }),
  };
  return { ...mocked, default: mocked };
});

vi.mock('fs', () => {
  const procNetDev = [
    'Inter-|   Receive',
    ' face |bytes',
    '    lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0',
    '  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0',
    '',
  ].join('\n');
  const mocked = {
    readFileSync: vi.fn().mockReturnValue(procNetDev),
    existsSync: vi.fn().mockReturnValue(false),
  };
  return { ...mocked, default: mocked };
});

import { ServersService } from './servers.service';
import { SchedulerLeaderService } from '../../common/scheduler/scheduler-leader.service';
import { EncryptionService } from '../../common/crypto/encryption.service';

const configStub = {
  get: (key: string, def?: unknown) =>
    key === 'ENCRYPTION_KEY' ? 'k'.repeat(32) : def,
} as any;

function makeEncryption(): EncryptionService {
  const svc = new EncryptionService(configStub);
  svc.onModuleInit();
  return svc;
}
const encryption = makeEncryption();

function makePrisma() {
  return {
    server: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
    },
    agentToken: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    serverMetric: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    projectMember: { findMany: vi.fn().mockResolvedValue([]) },
    project: { count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn(async (ops: any) =>
      Array.isArray(ops) ? Promise.all(ops) : ops(),
    ),
  };
}

function makeService() {
  const prisma = makePrisma();
  const systemConfig = { getNumber: vi.fn().mockReturnValue(30) };
  const notifications = { sendServerOffline: vi.fn().mockResolvedValue(undefined) };
  // NOTE: onModuleInit() is intentionally NOT called — no timers.
  const service = new ServersService(
    prisma as any,
    encryption as any,
    systemConfig as any,
    notifications as any,
    new SchedulerLeaderService(),
  );
  return { service, prisma, systemConfig, notifications };
}

/** Default exec routing for the linux stats paths. */
function mockExecLinux() {
  execAsyncMock.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith('df ')) return { stdout: '50000 100000\n', stderr: '' };
    if (cmd.startsWith('ps aux')) {
      return { stdout: 'node,512,12.5\n/usr/bin/postgres,256,3.1\n', stderr: '' };
    }
    if (cmd.startsWith('docker ps')) {
      return {
        stdout: 'dockcontrol-wp\tUp 2 hours\twordpress:latest\t0.0.0.0:8080->80/tcp\n',
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecLinux();
});

// ── read paths ──────────────────────────────────────────────────────

describe('findAll / findOne / findLocalPublic', () => {
  it('findAll lists servers newest first', async () => {
    const { service, prisma } = makeService();
    prisma.server.findMany.mockResolvedValue([{ id: 's1' }]);
    expect(await service.findAll()).toEqual([{ id: 's1' }]);
    expect(prisma.server.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findOne 404s on an unknown id', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue(null);
    await expect(service.findOne('ghost')).rejects.toThrow(NotFoundException);
  });

  it('findLocalPublic returns ONLY sanitized fields (no host, no tokens)', async () => {
    const { service, prisma } = makeService();
    prisma.server.findFirst.mockResolvedValue({ id: 's1', name: 'Local', status: 'ONLINE' });
    await service.findLocalPublic();
    const select = prisma.server.findFirst.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(['arch', 'id', 'name', 'os', 'status']);
  });
});

describe('findAccessible — RBAC-scoped server list', () => {
  it('no project memberships → [] without querying servers', async () => {
    const { service, prisma } = makeService();
    prisma.projectMember.findMany.mockResolvedValue([]);
    expect(await service.findAccessible('u1')).toEqual([]);
    expect(prisma.server.findMany).not.toHaveBeenCalled();
  });

  it('dedupes server ids across memberships and never selects agentTokens', async () => {
    const { service, prisma } = makeService();
    prisma.projectMember.findMany.mockResolvedValue([
      { project: { serverId: 's1' } },
      { project: { serverId: 's1' } },
      { project: { serverId: 's2' } },
      { project: { serverId: null } },
    ]);
    prisma.server.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

    await service.findAccessible('u1');

    const query = prisma.server.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ id: { in: ['s1', 's2'] } });
    expect(query.select.agentTokens).toBeUndefined();
    expect(query.select).toEqual({
      id: true, name: true, host: true, status: true, os: true, arch: true,
    });
  });
});

// ── CRUD ────────────────────────────────────────────────────────────

describe('update / removeChecked', () => {
  it('update 404s before writing when the server is missing', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue(null);
    await expect(service.update('ghost', { name: 'x' } as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.server.update).not.toHaveBeenCalled();
  });

  it('update persists the dto', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1', projects: [] });
    prisma.server.update.mockResolvedValue({ id: 's1', name: 'renamed' });
    const res = await service.update('s1', { name: 'renamed' } as any);
    expect(res.name).toBe('renamed');
    expect(prisma.server.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { name: 'renamed' },
    });
  });

  it('removeChecked refuses to delete a server that still hosts projects', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1' });
    prisma.project.count.mockResolvedValue(3);
    await expect(service.removeChecked('s1')).rejects.toThrow(BadRequestException);
    await expect(service.removeChecked('s1')).rejects.toThrow(/3 project\(s\)/);
    expect(prisma.server.delete).not.toHaveBeenCalled();
  });

  it('removeChecked with force=true deletes anyway and reports the cascade count', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1' });
    prisma.project.count.mockResolvedValue(3);
    const res = await service.removeChecked('s1', true);
    expect(res).toEqual({ message: 'Server deleted', cascadedProjects: 3 });
    expect(prisma.server.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
  });

  it('removeChecked deletes an unused server without force', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1' });
    prisma.project.count.mockResolvedValue(0);
    const res = await service.removeChecked('s1');
    expect(res.cascadedProjects).toBe(0);
  });
});

// ── install tokens ──────────────────────────────────────────────────

describe('createPending — pending server + one-shot install token', () => {
  it('creates a PENDING_INSTALL row and stores ONLY the sha256 hash of the token', async () => {
    const { service, prisma } = makeService();
    prisma.server.create.mockResolvedValue({ id: 's-new', name: 'vps-1', status: 'PENDING_INSTALL' });

    const res = await service.createPending({ name: 'vps-1' });

    expect(prisma.server.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'vps-1', host: 'pending', status: 'PENDING_INSTALL' }),
    });
    // Raw token surfaces once, in the response…
    expect(res.installToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.installCommand).toContain(`token=${res.installToken}`);
    // …while the DB row holds sha256(raw), never the raw value.
    const tokenRow = prisma.agentToken.create.mock.calls[0][0].data;
    expect(tokenRow.serverId).toBe('s-new');
    expect(tokenRow.token).toBe(encryption.hash(res.installToken));
    expect(tokenRow.token).not.toBe(res.installToken);
    // 24h claim window.
    const ttlH = (tokenRow.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(ttlH).toBeGreaterThan(23.9);
    expect(ttlH).toBeLessThanOrEqual(24);
  });

  it('install command targets PUBLIC_API_URL (trailing slash stripped)', async () => {
    const { service, prisma } = makeService();
    prisma.server.create.mockResolvedValue({ id: 's-new' });
    const prev = process.env.PUBLIC_API_URL;
    process.env.PUBLIC_API_URL = 'https://panel.acme.io/';
    try {
      const res = await service.createPending({ name: 'vps-1' });
      expect(res.installCommand).toMatch(
        /^curl -fsSL https:\/\/panel\.acme\.io\/api\/agent\/install\.sh\?token=[0-9a-f]{64} \| sudo sh$/,
      );
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_API_URL;
      else process.env.PUBLIC_API_URL = prev;
    }
  });
});

describe('getInstallCommand / regenerateInstallToken', () => {
  it('getInstallCommand 404s on unknown server', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue(null);
    await expect(service.getInstallCommand('ghost')).rejects.toThrow(NotFoundException);
  });

  it('getInstallCommand supersedes active tokens and mints a fresh hashed one', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1', agentTokens: [] });

    const res = await service.getInstallCommand('s1');

    // Old unexpired tokens invalidated first.
    expect(prisma.agentToken.deleteMany).toHaveBeenCalledWith({
      where: { serverId: 's1', expiresAt: { gt: expect.any(Date) } },
    });
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.installCommand).toContain(`token=${res.token}`);
    const tokenRow = prisma.agentToken.create.mock.calls[0][0].data;
    expect(tokenRow.token).toBe(encryption.hash(res.token));
  });

  it('regenerateInstallToken wipes ALL tokens and bumps an ONLINE server back to PENDING_INSTALL', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1', status: 'ONLINE' });

    const res = await service.regenerateInstallToken('s1');

    expect(prisma.agentToken.deleteMany).toHaveBeenCalledWith({ where: { serverId: 's1' } });
    expect(prisma.server.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { status: 'PENDING_INSTALL' },
    });
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('regenerateInstallToken leaves a non-ONLINE server status untouched', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1', status: 'PENDING_INSTALL' });
    await service.regenerateInstallToken('s1');
    expect(prisma.server.update).not.toHaveBeenCalled();
  });

  it('two consecutive mints produce different tokens', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1', status: 'PENDING_INSTALL' });
    const a = await service.regenerateInstallToken('s1');
    const b = await service.regenerateInstallToken('s1');
    expect(a.token).not.toBe(b.token);
  });
});

describe('reset', () => {
  it('wipes metrics + tokens + agent facts in ONE transaction, then re-issues an install token', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue({ id: 's1', status: 'OFFLINE' });

    const res = await service.reset('s1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.serverMetric.deleteMany).toHaveBeenCalledWith({ where: { serverId: 's1' } });
    expect(prisma.agentToken.deleteMany).toHaveBeenCalledWith({ where: { serverId: 's1' } });
    expect(prisma.server.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: expect.objectContaining({
        status: 'PENDING_INSTALL',
        agentVersion: null,
        lastSeenAt: null,
        totalMemory: null,
      }),
    });
    expect(res.message).toMatch(/re-register/);
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.installCommand).toContain(res.token);
  });

  it('404s on unknown server before any destructive write', async () => {
    const { service, prisma } = makeService();
    prisma.server.findUnique.mockResolvedValue(null);
    await expect(service.reset('ghost')).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ── local server bootstrap ──────────────────────────────────────────

describe('findLocal', () => {
  it('provisions the local server row + a hashed bootstrap agent token when none exists', async () => {
    const { service, prisma } = makeService();
    prisma.server.findFirst
      .mockResolvedValueOnce(null) // initial lookup
      .mockResolvedValueOnce({ id: 's-local', agentTokens: [{ id: 't1' }] }); // re-read
    prisma.server.create.mockResolvedValue({ id: 's-local', agentTokens: [] });

    const res = await service.findLocal();

    expect(prisma.server.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Local Server',
          host: '127.0.0.1',
          status: 'ONLINE',
        }),
      }),
    );
    const tokenRow = prisma.agentToken.create.mock.calls[0][0].data;
    expect(tokenRow.serverId).toBe('s-local');
    expect(tokenRow.token).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest of the raw token
    expect(res).toEqual({ id: 's-local', agentTokens: [{ id: 't1' }] });
  });

  it('returns the existing first server without creating anything', async () => {
    const { service, prisma } = makeService();
    prisma.server.findFirst.mockResolvedValue({ id: 's1', agentTokens: [] });
    const res = await service.findLocal();
    expect(res).toEqual({ id: 's1', agentTokens: [] });
    expect(prisma.server.create).not.toHaveBeenCalled();
  });
});

// ── local stats ─────────────────────────────────────────────────────

describe('getLocalStats (mocked linux host)', () => {
  it('aggregates os facts: cpu per-core %, memory %, disk %, formatted uptime', async () => {
    const { service } = makeService();
    const stats = await service.getLocalStats();

    expect(stats.hostname).toBe('mock-host');
    expect(stats.platform).toBe('linux');
    expect(stats.cpu.cores).toBe(2);
    expect(stats.cpu.model).toBe('Mock CPU @ 3.0GHz');
    // times: 800 busy / 1000 total → 80% per core.
    expect(stats.cpu.perCore[0].usage).toBe(80);
    expect(stats.cpu.average).toBe(80);
    expect(stats.memory.total).toBe(8_000_000_000);
    expect(stats.memory.used).toBe(6_000_000_000);
    expect(stats.memory.percent).toBe(75);
    // df mock: used 50000 / total 100000.
    expect(stats.disk).toEqual({ total: 100000, used: 50000, free: 50000, percent: 50 });
    expect(stats.uptime.formatted).toBe('1d 1h 1m');
    expect(stats.loadAverage).toEqual({ '1m': 0.5, '5m': 0.7, '15m': 0.9 });
  });

  it('parses top processes and docker containers from shell output', async () => {
    const { service } = makeService();
    const stats = await service.getLocalStats();

    expect(stats.topProcesses).toEqual([
      { name: 'node', memoryMB: 512, cpuPercent: 12.5 },
      { name: 'postgres', memoryMB: 256, cpuPercent: 3.1 }, // basename of /usr/bin/postgres
    ]);
    expect(stats.dockerContainers).toEqual([
      {
        name: 'dockcontrol-wp',
        status: 'Up 2 hours',
        image: 'wordpress:latest',
        ports: '0.0.0.0:8080->80/tcp',
      },
    ]);
  });

  it('filters internal interfaces out of the network report', async () => {
    const { service } = makeService();
    const stats = await service.getLocalStats();
    expect(stats.network.interfaces).toEqual([
      { name: 'eth0', addresses: [{ address: '10.0.0.5', family: 'IPv4' }] },
    ]);
  });

  it('docker/ps probe failures degrade to empty lists instead of throwing', async () => {
    const { service } = makeService();
    execAsyncMock.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith('df ')) return { stdout: '50000 100000\n', stderr: '' };
      throw new Error('command not found');
    });
    const stats = await service.getLocalStats();
    expect(stats.topProcesses).toEqual([]);
    expect(stats.dockerContainers).toEqual([]);
  });
});

describe('setupLocal', () => {
  it('refreshes the local row with live os facts and records a metric sample', async () => {
    const { service, prisma } = makeService();
    const local = { id: 's-local', agentTokens: [] };
    prisma.server.findFirst.mockResolvedValue(local);
    prisma.server.update.mockResolvedValue({ ...local, name: 'mock-host' });

    const res = await service.setupLocal();

    expect(res?.name).toBe('mock-host');
    expect(prisma.server.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's-local' },
        data: expect.objectContaining({
          name: 'mock-host',
          host: '127.0.0.1',
          status: 'ONLINE',
          os: 'linux 6.1.0-mock',
          arch: 'x64',
          cpuCores: 2,
          totalMemory: 8_000_000_000n,
          agentVersion: 'built-in',
          lastSeenAt: expect.any(Date),
        }),
      }),
    );
    // collectMetrics() ran: a ServerMetric row was recorded for the server.
    expect(prisma.serverMetric.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serverId: 's-local',
          memoryTotal: 8_000_000_000n,
          memoryUsed: 6_000_000_000n,
        }),
      }),
    );
  });
});
