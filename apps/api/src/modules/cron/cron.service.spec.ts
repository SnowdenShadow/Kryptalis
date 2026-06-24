import { describe, it, expect, vi, beforeEach } from 'vitest';

// assertAppOwnership is a module-level fn — mock it so access checks pass.
vi.mock('../applications/applications.helpers', () => ({
  assertAppOwnership: vi.fn().mockResolvedValue({ id: 'app1', projectId: 'p1' }),
}));

import { CronService } from './cron.service';

function makePrisma() {
  return {
    cronJob: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    application: {
      // Superset shape: resolveActor reads project.members; the run-status
      // guard reads status + name. Default to a RUNNING app owned by owner1.
      findUnique: vi.fn().mockResolvedValue({
        status: 'RUNNING',
        name: 'app',
        project: { members: [{ userId: 'owner1' }] },
      }),
    },
  } as any;
}

function makeService(prisma: any) {
  const ops = { execCommand: vi.fn().mockResolvedValue({ output: 'ok', exitCode: 0 }) };
  const svc = new CronService(prisma, ops as any);
  return { svc, ops, prisma };
}

// runDueJobs fires each job's command via `void this.execute(...)` (fire and
// forget), so the execCommand call lands on the microtask queue AFTER
// runDueJobs resolves. Flush pending microtasks before asserting on it.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('CronService.runDueJobs', () => {
  let prisma: any;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('runs a job that is due and records exit code + output', async () => {
    const { svc, ops } = makeService(prisma);
    const now = new Date(2026, 5, 24, 14, 5, 0); // 14:05
    prisma.cronJob.findMany.mockResolvedValue([
      {
        id: 'j1', name: 'tick', schedule: '*/5 * * * *', command: 'echo hi',
        enabled: true, applicationId: 'app1',
        lastRunAt: new Date(2026, 5, 24, 14, 0, 0), // honoured 14:00; 14:05 is now due
        createdAt: new Date(2026, 5, 24, 13, 0, 0),
      },
    ]);

    await svc.runDueJobs(now);
    await flush();

    // Watermark advanced to the occurrence BEFORE running.
    expect(prisma.cronJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'j1' }, data: { lastRunAt: expect.any(Date) } }),
    );
    // Command executed inside the app container via the shared exec primitive.
    expect(ops.execCommand).toHaveBeenCalledWith('owner1', 'app1', 'echo hi');
    // Outcome persisted.
    expect(prisma.cronJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastExitCode: 0 }) }),
    );
  });

  it('does NOT run a job whose latest occurrence is already honoured', async () => {
    const { svc, ops } = makeService(prisma);
    const now = new Date(2026, 5, 24, 14, 5, 30);
    prisma.cronJob.findMany.mockResolvedValue([
      {
        id: 'j1', name: 'tick', schedule: '*/5 * * * *', command: 'echo hi',
        enabled: true, applicationId: 'app1',
        lastRunAt: new Date(2026, 5, 24, 14, 5, 0), // already ran 14:05
        createdAt: new Date(2026, 5, 24, 13, 0, 0),
      },
    ]);

    await svc.runDueJobs(now);
    expect(ops.execCommand).not.toHaveBeenCalled();
  });

  it('skips a job with an invalid cron expression (never runs, never crashes the tick)', async () => {
    const { svc, ops } = makeService(prisma);
    prisma.cronJob.findMany.mockResolvedValue([
      {
        id: 'j1', name: 'bad', schedule: 'not a cron', command: 'echo hi',
        enabled: true, applicationId: 'app1', lastRunAt: null,
        createdAt: new Date(2026, 5, 24, 13, 0, 0),
      },
    ]);
    await svc.runDueJobs(new Date(2026, 5, 24, 14, 5, 0));
    expect(ops.execCommand).not.toHaveBeenCalled();
  });

  it('a brand-new job does not fire for occurrences before its createdAt', async () => {
    const { svc, ops } = makeService(prisma);
    const now = new Date(2026, 5, 24, 14, 5, 30);
    prisma.cronJob.findMany.mockResolvedValue([
      {
        id: 'j1', name: 'fresh', schedule: '*/5 * * * *', command: 'echo hi',
        enabled: true, applicationId: 'app1',
        lastRunAt: null,
        // Created at 14:05:10 — the 14:05:00 occurrence predates it, so not due.
        createdAt: new Date(2026, 5, 24, 14, 5, 10),
      },
    ]);
    await svc.runDueJobs(now);
    expect(ops.execCommand).not.toHaveBeenCalled();
  });

  it('does NOT exec when the app is not running — records a clear skip message instead', async () => {
    const { svc, ops, prisma: p } = makeService(prisma);
    p.application.findUnique.mockResolvedValue({
      status: 'STOPPED', name: 'web', project: { members: [{ userId: 'owner1' }] },
    });
    const now = new Date(2026, 5, 24, 14, 5, 0);
    p.cronJob.findMany.mockResolvedValue([
      { id: 'j1', name: 'tick', schedule: '*/5 * * * *', command: 'echo hi', enabled: true, applicationId: 'app1', lastRunAt: new Date(2026, 5, 24, 14, 0, 0), createdAt: new Date(2026, 5, 24, 13, 0, 0) },
    ]);

    await svc.runDueJobs(now);
    await flush();

    expect(ops.execCommand).not.toHaveBeenCalled();
    // A clear, distinct skip outcome was recorded (not a raw docker error).
    const recorded = p.cronJob.update.mock.calls.map((c: any) => c[0].data).find((d: any) => typeof d.lastOutput === 'string');
    expect(recorded.lastOutput).toMatch(/stopped|not running/i);
    expect(recorded.lastExitCode).toBe(-1);
    expect(recorded.lastRunAt).toBeInstanceOf(Date);
  });

  it('one job failing to launch does not stop the others', async () => {
    const { svc, ops } = makeService(prisma);
    const now = new Date(2026, 5, 24, 14, 5, 0);
    prisma.cronJob.findMany.mockResolvedValue([
      { id: 'bad', name: 'x', schedule: '*/5 * * * *', command: 'a', enabled: true, applicationId: 'app1', lastRunAt: new Date(2026, 5, 24, 14, 0, 0), createdAt: new Date(2026, 5, 24, 13, 0, 0) },
      { id: 'good', name: 'y', schedule: '*/5 * * * *', command: 'b', enabled: true, applicationId: 'app2', lastRunAt: new Date(2026, 5, 24, 14, 0, 0), createdAt: new Date(2026, 5, 24, 13, 0, 0) },
    ]);
    // First update (watermark for 'bad') throws; the loop must continue to 'good'.
    prisma.cronJob.update.mockRejectedValueOnce(new Error('db hiccup'));

    await svc.runDueJobs(now);
    await flush();
    // 'good' still ran.
    expect(ops.execCommand).toHaveBeenCalledWith('owner1', 'app2', 'b');
  });
});

describe('CronService.create', () => {
  it('persists the job and returns nextRunAt', async () => {
    const prisma = makePrisma();
    const { svc } = makeService(prisma);
    prisma.cronJob.create.mockResolvedValue({
      id: 'j1', name: 'n', schedule: '0 3 * * *', command: 'c', enabled: true,
      applicationId: 'app1', lastRunAt: null, createdAt: new Date(),
    });
    const res = await svc.create('u1', { name: 'n', applicationId: 'app1', schedule: '0 3 * * *', command: 'c' } as any);
    expect(prisma.cronJob.create).toHaveBeenCalled();
    expect(res).toHaveProperty('nextRunAt');
  });
});
