import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';

// Transfer cleanup touches disk (fs.promises.rm) — mock it away so the
// service stays unit-testable (same approach as backups.service.spec).
vi.mock('fs', () => {
  const promises = {
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
  const fsMock = {
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    promises,
  };
  return { ...fsMock, default: fsMock };
});

import { AgentService } from './agent.service';

function makePrisma() {
  return {
    agentTask: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentToken: { findFirst: vi.fn() },
    server: { update: vi.fn().mockResolvedValue({}) },
    $queryRawUnsafe: vi.fn(),
  };
}

function makeService() {
  const prisma = makePrisma();
  const encryption = {
    hash: vi.fn((s: string) => `hash(${s})`),
    encrypt: vi.fn((s: string) => `v1.enc(${s})`),
    decrypt: vi.fn((s: string) =>
      typeof s === 'string' && s.startsWith('v1.enc(') ? s.slice(7, -1) : s,
    ),
  };
  const service = new AgentService(prisma as any, encryption as any);
  return { service, prisma, encryption };
}

/** Make validateToken succeed for any (serverId, token). */
function allowAgent(prisma: ReturnType<typeof makePrisma>) {
  prisma.agentToken.findFirst.mockResolvedValue({ id: 'tok1', serverId: 's1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GET /agent/tasks/:id scoping ─────────────────────────────────────

describe('getTaskForUser', () => {
  const row = {
    id: 't1',
    serverId: 's1',
    type: 'BACKUP',
    status: 'RUNNING',
    payload: { backupId: 'b1', databases: [{ password: 'v1.enc(secret)' }] },
    result: { ok: true },
    error: null,
    createdAt: new Date('2026-06-10T00:00:00Z'),
    startedAt: new Date('2026-06-10T00:00:01Z'),
    completedAt: null,
  };

  it('404s on a missing task', async () => {
    const { service, prisma } = makeService();
    prisma.agentTask.findUnique.mockResolvedValue(null);
    await expect(service.getTaskForUser('nope', 'USER')).rejects.toThrow(NotFoundException);
  });

  it('returns the full row (payload included) to platform admins', async () => {
    const { service, prisma } = makeService();
    prisma.agentTask.findUnique.mockResolvedValue(row);
    expect(await service.getTaskForUser('t1', 'ADMIN')).toBe(row);
    expect(await service.getTaskForUser('t1', 'SUPERADMIN')).toBe(row);
  });

  it('redacts payload AND result/error for non-admin users (M-1: status projection only)', async () => {
    const { service, prisma } = makeService();
    prisma.agentTask.findUnique.mockResolvedValue(row);

    const res = await service.getTaskForUser('t1', 'USER');

    // result/error are now admin-only too: `result` captures docker exec
    // stdout (cross-tenant secret leak via a learned task id — M-1).
    expect(res).toEqual({
      id: 't1',
      type: 'BACKUP',
      status: 'RUNNING',
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: null,
    });
    expect((res as any).payload).toBeUndefined();
    expect((res as any).result).toBeUndefined();
    expect((res as any).error).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('secret');
    // Missing/unknown roles are treated as non-admin too.
    const anon = (await service.getTaskForUser('t1', undefined)) as any;
    expect(anon.payload).toBeUndefined();
    expect(anon.result).toBeUndefined();
  });
});

// ── poll() in-flight credential decryption ───────────────────────────

describe('poll credential decryption', () => {
  it('decrypts payload.databases[].password of BACKUP/RESTORE tasks served to the agent', async () => {
    const { service, prisma, encryption } = makeService();
    allowAgent(prisma);
    prisma.$queryRawUnsafe.mockResolvedValue([
      {
        id: 't1',
        type: 'BACKUP',
        payload: {
          backupId: 'b1',
          databases: [
            { id: 'd1', password: 'v1.enc(pg-pass)' },
            { id: 'd2', password: 'legacy-plain' }, // pre-hardening payload
          ],
          volumes: ['v_data'],
        },
      },
      { id: 't2', type: 'DEPLOY', payload: { password: 'v1.enc(not-touched)' } },
    ]);

    const { tasks } = await service.poll('s1', 'tok');

    expect(tasks[0].payload.databases[0].password).toBe('pg-pass');
    // decrypt() passes legacy plaintext through unchanged.
    expect(tasks[0].payload.databases[1].password).toBe('legacy-plain');
    expect(tasks[0].payload.volumes).toEqual(['v_data']);
    // Non-sensitive task types are returned verbatim.
    expect(tasks[1].payload.password).toBe('v1.enc(not-touched)');
    expect(encryption.decrypt).toHaveBeenCalledWith('v1.enc(pg-pass)');
  });

  it('still rejects an invalid agent token', async () => {
    const { service, prisma } = makeService();
    prisma.agentToken.findFirst.mockResolvedValue(null);
    await expect(service.poll('s1', 'bad')).rejects.toThrow(UnauthorizedException);
  });
});

// ── terminal payload scrub ───────────────────────────────────────────

describe('terminal payload scrub', () => {
  const backupPayload = {
    backupId: 'b1',
    uploadName: 'b1.tar.gz',
    databases: [{ id: 'd1', username: 'admin', password: 'v1.enc(super-secret)' }],
    sourceTaskId: 'src-1',
  };

  function taskRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 't1',
      serverId: 's1',
      status: 'RUNNING',
      type: 'BACKUP',
      payload: backupPayload,
      ...overrides,
    };
  }

  it('after a BACKUP task completes, the stored payload no longer contains the password', async () => {
    const { service, prisma } = makeService();
    allowAgent(prisma);
    prisma.agentTask.findUnique.mockResolvedValue(taskRow());

    await service.taskResult('t1', 's1', 'tok', 'COMPLETED', { ok: true });

    // Find the update that rewrote the payload (the first update sets
    // status/result; the scrub update replaces payload).
    const scrubCall = prisma.agentTask.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.payload !== undefined,
    );
    expect(scrubCall).toBeDefined();
    const stored = scrubCall![0].data.payload;
    expect(stored).toEqual({ scrubbed: true, sourceTaskId: 'src-1' });
    expect(JSON.stringify(stored)).not.toContain('super-secret');
    expect(JSON.stringify(stored)).not.toContain('password');
  });

  it('scrubs AFTER handleTaskTermination — the completion handler still sees the original payload', async () => {
    const { service, prisma } = makeService();
    allowAgent(prisma);
    prisma.agentTask.findUnique.mockResolvedValue(taskRow());

    const order: string[] = [];
    prisma.agentTask.update.mockImplementation(async (args: any) => {
      if (args?.data?.payload !== undefined) order.push('scrub');
      return {};
    });
    const handler = vi.fn(async (task: any) => {
      order.push('handler');
      // The handler must receive the UN-scrubbed payload (backupId etc.).
      expect(task.payload).toEqual(backupPayload);
    });
    service.registerTaskCompletionHandler('BACKUP', handler);

    await service.taskResult('t1', 's1', 'tok', 'COMPLETED', { ok: true });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['handler', 'scrub']);
  });

  it('scrubs FAILED BACKUP/RESTORE tasks too', async () => {
    const { service, prisma } = makeService();
    allowAgent(prisma);
    prisma.agentTask.findUnique.mockResolvedValue(taskRow({ type: 'RESTORE' }));

    await service.taskResult('t1', 's1', 'tok', 'FAILED', undefined, 'boom');

    const scrubCall = prisma.agentTask.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.payload !== undefined,
    );
    expect(scrubCall).toBeDefined();
    expect(JSON.stringify(scrubCall![0].data.payload)).not.toContain('super-secret');
  });

  it('does not rewrite the payload of non-sensitive task types', async () => {
    const { service, prisma } = makeService();
    allowAgent(prisma);
    prisma.agentTask.findUnique.mockResolvedValue(
      taskRow({ type: 'DEPLOY', payload: { slug: 'app', onComplete: [] } }),
    );

    await service.taskResult('t1', 's1', 'tok', 'COMPLETED', { ok: true });

    const scrubCall = prisma.agentTask.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.payload !== undefined,
    );
    expect(scrubCall).toBeUndefined();
  });

  it('failStaleTasks scrubs the payload of stale BACKUP tasks after termination handling', async () => {
    const { service, prisma } = makeService();
    prisma.agentTask.findMany.mockResolvedValue([
      taskRow({ status: 'RUNNING' }),
      { id: 't2', serverId: 's1', status: 'QUEUED', type: 'DEPLOY', payload: { slug: 'x' } },
    ]);
    prisma.agentTask.updateMany.mockResolvedValue({ count: 2 });

    const order: string[] = [];
    prisma.agentTask.update.mockImplementation(async (args: any) => {
      if (args?.data?.payload !== undefined) order.push(`scrub:${args.where.id}`);
      return {};
    });
    const handler = vi.fn(async (task: any) => {
      order.push(`handler:${task.id}`);
      expect(task.payload).toEqual(backupPayload);
    });
    service.registerTaskCompletionHandler('BACKUP', handler);

    await (service as any).failStaleTasks();

    // BACKUP task: handler first (original payload), then scrub. DEPLOY: never scrubbed.
    expect(order).toEqual(['handler:t1', 'scrub:t1']);
    const scrubCall = prisma.agentTask.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.payload !== undefined,
    );
    expect(scrubCall![0]).toEqual({
      where: { id: 't1' },
      data: { payload: { scrubbed: true, sourceTaskId: 'src-1' } },
    });
  });
});
