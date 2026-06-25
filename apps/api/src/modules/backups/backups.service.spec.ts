import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

// The service touches disk (BACKUPS_DIR mkdir at construction, dump files)
// and docker (execFile/spawn) — both are mocked away entirely so these stay
// pure service-level tests (same approach as projects.service.spec).
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// RBAC project check (used by create() for project-scoped backups) — mocked so
// the scope tests don't need full membership fixtures.
vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => {
  const promises = {
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue('/tmp/dockcontrol-test'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{}'),
    copyFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 123 }),
    open: vi.fn(),
  };
  const fsMock = {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    promises,
  };
  return { ...fsMock, default: fsMock };
});

import * as fs from 'fs';
import { execFile } from 'child_process';
import { BackupsService } from './backups.service';
import { previousOccurrence, scheduledRunName, BACKUP_SCHEDULE_PATTERN } from './backup-schedule.util';

const mockFs = fs as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  promises: Record<string, ReturnType<typeof vi.fn>>;
};

function makePrisma() {
  return {
    backup: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    server: { findMany: vi.fn(), findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
    projectMember: { findMany: vi.fn() },
    database: { findMany: vi.fn(), findUnique: vi.fn() },
    application: { findMany: vi.fn() },
    agentTask: { findFirst: vi.fn().mockResolvedValue(null) },
  };
}

function makeService() {
  const prisma = makePrisma();
  const systemConfig = { get: vi.fn().mockReturnValue(undefined) };
  const encryption = {
    decrypt: vi.fn().mockReturnValue('pw'),
    // Deterministic marker so tests can assert payloads carry the encrypted
    // form (never the plaintext).
    encrypt: vi.fn((s: string) => `v1.enc(${s})`),
  };
  const notifications = { sendBackupResult: vi.fn().mockResolvedValue(undefined) };
  const agent = {
    enqueueTask: vi.fn().mockResolvedValue({ id: 'task1' }),
    registerTaskCompletionHandler: vi.fn(),
    transferDir: vi.fn((id: string) => `/data/transfers/${id}`),
    newLocalTransferId: vi.fn().mockReturnValue('local-xfer-1'),
    cleanupTransfers: vi.fn().mockResolvedValue(undefined),
  };
  const service = new BackupsService(
    prisma as any,
    systemConfig as any,
    encryption as any,
    notifications as any,
    agent as any,
  );
  return { service, prisma, systemConfig, encryption, notifications, agent };
}

/** Non-admin user with access to exactly `serverIds`. */
function grantAccess(prisma: ReturnType<typeof makePrisma>, serverIds: string[]) {
  prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
  prisma.projectMember.findMany.mockResolvedValue(
    serverIds.map((id) => ({ project: { serverId: id } })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.existsSync.mockReturnValue(true);
});

// ── RBAC ─────────────────────────────────────────────────────────────

describe('access control', () => {
  it('admins see every server', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.server.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    prisma.backup.findMany.mockResolvedValue([]);

    await service.findAll('admin');
    expect(prisma.backup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serverId: { in: ['s1', 's2'] } } }),
    );
    expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
  });

  it('non-admins are scoped to their project servers', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.backup.findMany.mockResolvedValue([]);

    await service.findAll('u1');
    expect(prisma.backup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serverId: { in: ['s1'] } } }),
    );
  });

  it('findAll rejects an explicit serverId outside the accessible set', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);

    await expect(service.findAll('u1', 's2')).rejects.toThrow(ForbiddenException);
  });

  it('findOne 404s on a missing backup', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findUnique.mockResolvedValue(null);

    await expect(service.findOne('u1', 'b1')).rejects.toThrow(NotFoundException);
  });

  it('findOne forbids a backup on an inaccessible server', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.backup.findUnique.mockResolvedValue({ id: 'b1', serverId: 's2' });

    await expect(service.findOne('u1', 'b1')).rejects.toThrow(ForbiddenException);
  });
});

// ── create ───────────────────────────────────────────────────────────

describe('create', () => {
  it('forbids creating a backup on an inaccessible server', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);

    await expect(
      service.create('u1', { name: 'b', serverId: 's2', target: 'LOCAL' } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('400s on a remote target when S3 is not configured', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);

    await expect(
      service.create('u1', { name: 'b', serverId: 's1', target: 'S3' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.backup.create).not.toHaveBeenCalled();
  });

  it('returns the PENDING row and launches the job in the background', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    const row = { id: 'b1', status: 'PENDING' };
    prisma.backup.create.mockResolvedValue(row);
    const job = vi
      .spyOn(service as any, 'runBackupJob')
      .mockResolvedValue(undefined);

    const res = await service.create('u1', {
      name: 'b',
      serverId: 's1',
      target: 'LOCAL',
      schedule: '@daily',
    } as any);

    expect(res).toBe(row);
    expect(prisma.backup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ schedule: '@daily', target: 'LOCAL' }),
      }),
    );
    expect(job).toHaveBeenCalledWith('b1');
  });

  // ── project scope ─────────────────────────────────────────────────
  it('persists projectId when the project is on the server + accessible', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.project.findUnique.mockResolvedValue({ id: 'p1', serverId: 's1' });
    prisma.backup.create.mockResolvedValue({ id: 'b1', status: 'PENDING' });
    vi.spyOn(service as any, 'runBackupJob').mockResolvedValue(undefined);

    await service.create('u1', { name: 'b', serverId: 's1', projectId: 'p1', target: 'LOCAL' } as any);

    expect(prisma.backup.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: 'p1' }) }),
    );
  });

  it('rejects a project that is on a DIFFERENT server', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.project.findUnique.mockResolvedValue({ id: 'p1', serverId: 's2' });

    await expect(
      service.create('u1', { name: 'b', serverId: 's1', projectId: 'p1', target: 'LOCAL' } as any),
    ).rejects.toThrow(/not on the selected server/i);
    expect(prisma.backup.create).not.toHaveBeenCalled();
  });

  it('404s on a missing project', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(
      service.create('u1', { name: 'b', serverId: 's1', projectId: 'pX', target: 'LOCAL' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('a whole-server backup (no projectId) persists projectId null', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.backup.create.mockResolvedValue({ id: 'b1', status: 'PENDING' });
    vi.spyOn(service as any, 'runBackupJob').mockResolvedValue(undefined);

    await service.create('u1', { name: 'b', serverId: 's1', target: 'LOCAL' } as any);

    expect(prisma.backup.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: null }) }),
    );
  });
});

// ── project-scoped exporters ──────────────────────────────────────────
describe('exporters honour project scope', () => {
  it('dumpDatabases filters by projectId when set, else by serverId', async () => {
    const { service, prisma } = makeService();
    prisma.database.findMany.mockResolvedValue([]);
    const manifest: any = { databases: [] };

    await (service as any).dumpDatabases('/tmp/x', 's1', manifest, 'p1');
    expect(prisma.database.findMany).toHaveBeenCalledWith({ where: { projectId: 'p1' } });

    await (service as any).dumpDatabases('/tmp/x', 's1', manifest, null);
    expect(prisma.database.findMany).toHaveBeenLastCalledWith({ where: { serverId: 's1' } });
  });

  it('exportApplications filters by projectId when set, else by serverId', async () => {
    const { service, prisma } = makeService();
    prisma.application.findMany.mockResolvedValue([]);

    await (service as any).exportApplications('/tmp/x', 's1', 'p1');
    expect(prisma.application.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'p1' } }),
    );

    await (service as any).exportApplications('/tmp/x', 's1', null);
    expect(prisma.application.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { project: { serverId: 's1' } } }),
    );
  });
});

// ── restore guards ───────────────────────────────────────────────────

describe('restore', () => {
  function setup(backup: Record<string, unknown>) {
    const ctx = makeService();
    grantAccess(ctx.prisma, ['s1']);
    ctx.prisma.backup.findUnique.mockResolvedValue({
      id: 'b1',
      serverId: 's1',
      target: 'LOCAL',
      status: 'COMPLETED',
      ...backup,
    });
    return ctx;
  }

  it('refuses any status other than COMPLETED', async () => {
    const { service } = setup({ status: 'FAILED' });
    await expect(service.restore('u1', 'b1')).rejects.toThrow(
      'Only COMPLETED backups can be restored',
    );
  });

  it('400s when the row has no filename on record', async () => {
    const { service } = setup({ filename: null });
    await expect(service.restore('u1', 'b1')).rejects.toThrow(
      'no archive on record',
    );
  });

  it('400s when the file is missing from disk', async () => {
    const { service } = setup({ filename: 'b1.tar.gz' });
    mockFs.existsSync.mockReturnValue(false);
    await expect(service.restore('u1', 'b1')).rejects.toThrow(
      'missing from disk',
    );
  });

  it('refuses to restore on a sha256 mismatch', async () => {
    const { service } = setup({ filename: 'b1.tar.gz', sha256: 'expected' });
    vi.spyOn(service as any, 'sha256File').mockResolvedValue('actual-different');

    await expect(service.restore('u1', 'b1')).rejects.toThrow(
      'corrupted or tampered',
    );
  });

  it('local backup with no recorded checksum is allowed (legacy on-disk row)', async () => {
    const { service } = setup({ filename: 'b1.tar.gz', sha256: null, encryptedAt: false });
    // Past the checksum gate the flow extracts the archive (mocked tar) — the
    // point is it does NOT throw the "unverifiable" guard for a LOCAL target.
    vi.mocked(execFile).mockImplementation(((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    }) as any);
    // No manifest in the mocked archive → restore fails LATER, not at the
    // checksum gate. Assert it's not the remote-unverifiable error.
    mockFs.promises.readFile.mockResolvedValue('not json');
    await expect(service.restore('u1', 'b1')).rejects.not.toThrow(
      'unverifiable remote object',
    );
  });

  it('refuses to restore a REMOTE backup that has no recorded checksum', async () => {
    const { service, prisma } = setup({ target: 'S3', filename: 'b1.tar.gz', sha256: null });
    prisma.server.findUnique.mockResolvedValue({ host: 'localhost' });
    // Skip the real S3 download — we only care about the fail-closed gate.
    vi.spyOn(service as any, 'downloadBackupFromS3').mockResolvedValue('/tmp/remote.dump');

    await expect(service.restore('u1', 'b1')).rejects.toThrow(
      'no recorded checksum',
    );
  });

  it('refuses an encrypted backup when no encryption key is configured', async () => {
    const { service, systemConfig } = setup({
      filename: 'b1.tar.gz',
      sha256: null,
      encryptedAt: true,
    });
    systemConfig.get.mockReturnValue(undefined); // no backup_encryption_key

    await expect(service.restore('u1', 'b1')).rejects.toThrow(
      'BACKUP_ENCRYPTION_KEY is not configured',
    );
  });
});

// ── remove ───────────────────────────────────────────────────────────

describe('remove', () => {
  it('unlinks the local file best-effort and deletes the row', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.backup.findUnique.mockResolvedValue({
      id: 'b1',
      serverId: 's1',
      target: 'LOCAL',
      filename: 'b1.tar.gz',
    });
    mockFs.promises.unlink.mockRejectedValue(new Error('ENOENT'));
    prisma.backup.delete.mockResolvedValue({});

    const res = await service.remove('u1', 'b1');

    expect(mockFs.promises.unlink).toHaveBeenCalledWith(
      expect.stringContaining('b1.tar.gz'),
    );
    // unlink failure never blocks deleting the row
    expect(prisma.backup.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
    expect(res).toEqual({ message: 'Backup deleted' });
  });
});

// ── scheduling ───────────────────────────────────────────────────────

describe('schedule expression parsing', () => {
  it('accepts the documented subset and rejects everything else', () => {
    for (const ok of ['@hourly', '@daily', '@weekly', '0 3 * * *', '30 23 * * *', '15 * * * *']) {
      expect(ok).toMatch(BACKUP_SCHEDULE_PATTERN);
    }
    for (const bad of ['* * * * *', '0 3 * * 1', '60 3 * * *', '0 24 * * *', '@monthly', 'daily', '']) {
      expect(bad).not.toMatch(BACKUP_SCHEDULE_PATTERN);
    }
  });

  it('computes the previous occurrence for each supported form', () => {
    const now = new Date(2026, 5, 10, 14, 42); // Wed 2026-06-10 14:42 local
    expect(previousOccurrence('@hourly', now)).toEqual(new Date(2026, 5, 10, 14, 0));
    expect(previousOccurrence('@daily', now)).toEqual(new Date(2026, 5, 10, 0, 0));
    expect(previousOccurrence('@weekly', now)).toEqual(new Date(2026, 5, 7, 0, 0)); // Sunday
    expect(previousOccurrence('30 3 * * *', now)).toEqual(new Date(2026, 5, 10, 3, 30));
    // daily time later than now → yesterday's occurrence
    expect(previousOccurrence('0 20 * * *', now)).toEqual(new Date(2026, 5, 9, 20, 0));
    // hourly at :50, now is :42 → previous hour
    expect(previousOccurrence('50 * * * *', now)).toEqual(new Date(2026, 5, 10, 13, 50));
    expect(previousOccurrence('garbage', now)).toBeNull();
  });
});

describe('runScheduledBackups', () => {
  const NOW = new Date(2026, 5, 10, 14, 42);

  function template(overrides: Record<string, unknown> = {}) {
    return {
      id: 'tpl1',
      name: 'nightly',
      serverId: 's1',
      target: 'LOCAL',
      includeApplications: true,
      includeDatabases: true,
      includeVolumes: false,
      schedule: '0 3 * * *',
      lastRunAt: new Date(2026, 5, 9, 3, 0), // honoured yesterday → due today
      createdAt: new Date(2026, 5, 1),
      server: { host: 'localhost' },
      ...overrides,
    };
  }

  it('spawns a child row and runs the job when an occurrence is due', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findMany.mockResolvedValue([template()]);
    prisma.backup.findFirst.mockResolvedValue(null); // nothing running
    prisma.backup.create.mockResolvedValue({ id: 'child1' });
    const job = vi.spyOn(service as any, 'runBackupJob').mockResolvedValue(undefined);

    await service.runScheduledBackups(NOW);

    // lastRunAt stamped with the occurrence BEFORE the job launches
    expect(prisma.backup.update).toHaveBeenCalledWith({
      where: { id: 'tpl1' },
      data: { lastRunAt: new Date(2026, 5, 10, 3, 0) },
    });
    expect(prisma.backup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: scheduledRunName('nightly', new Date(2026, 5, 10, 3, 0)),
          serverId: 's1',
          target: 'LOCAL',
          includeVolumes: false,
          schedule: null, // children never reschedule themselves
        }),
      }),
    );
    expect(job).toHaveBeenCalledWith('child1');
  });

  it('does nothing when the occurrence was already honoured', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findMany.mockResolvedValue([
      template({ lastRunAt: new Date(2026, 5, 10, 3, 0) }),
    ]);

    await service.runScheduledBackups(NOW);
    expect(prisma.backup.create).not.toHaveBeenCalled();
    expect(prisma.backup.update).not.toHaveBeenCalled();
  });

  it('falls back to createdAt when the template never ran', async () => {
    const { service, prisma } = makeService();
    // created after today's 03:00 occurrence → not due yet
    prisma.backup.findMany.mockResolvedValue([
      template({ lastRunAt: null, createdAt: new Date(2026, 5, 10, 10, 0) }),
    ]);

    await service.runScheduledBackups(NOW);
    expect(prisma.backup.create).not.toHaveBeenCalled();
  });

  it('skips while a run of the same template is still PENDING/IN_PROGRESS', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findMany.mockResolvedValue([template()]);
    prisma.backup.findFirst.mockResolvedValue({ id: 'child0' }); // running
    const job = vi.spyOn(service as any, 'runBackupJob').mockResolvedValue(undefined);

    await service.runScheduledBackups(NOW);
    expect(prisma.backup.create).not.toHaveBeenCalled();
    expect(prisma.backup.update).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
  });

  it('remote (agent-managed) servers: scheduled runs fire (delegated to the agent at job time)', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findMany.mockResolvedValue([
      template({ server: { host: '10.0.0.5' } }),
    ]);
    prisma.backup.findFirst.mockResolvedValue(null);
    prisma.backup.create.mockResolvedValue({ id: 'child1' });
    prisma.backup.update.mockResolvedValue({});

    await service.runScheduledBackups(NOW);
    expect(prisma.backup.create).toHaveBeenCalled();
  });

  it('remote schedules skip while a BACKUP agent task is already in flight', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findMany.mockResolvedValue([
      template({ server: { host: '10.0.0.5' } }),
    ]);
    prisma.backup.findFirst.mockResolvedValue(null);
    prisma.agentTask.findFirst.mockResolvedValue({ id: 'inflight-task' });

    await service.runScheduledBackups(NOW);
    expect(prisma.backup.create).not.toHaveBeenCalled();
  });

  it('skips templates with an unsupported expression', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findMany.mockResolvedValue([
      template({ schedule: '*/5 * * * *' }),
    ]);

    await service.runScheduledBackups(NOW);
    expect(prisma.backup.create).not.toHaveBeenCalled();
  });

  it('one failing template does not stop the loop', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findMany.mockResolvedValue([
      template({ id: 'tplA', name: 'a' }),
      template({ id: 'tplB', name: 'b' }),
    ]);
    prisma.backup.findFirst.mockResolvedValue(null);
    prisma.backup.update
      .mockRejectedValueOnce(new Error('db hiccup')) // tplA explodes
      .mockResolvedValue({});
    prisma.backup.create.mockResolvedValue({ id: 'childB' });
    const job = vi.spyOn(service as any, 'runBackupJob').mockResolvedValue(undefined);

    await service.runScheduledBackups(NOW);

    // tplB still launched despite tplA's failure
    expect(prisma.backup.create).toHaveBeenCalledTimes(1);
    expect(job).toHaveBeenCalledWith('childB');
  });
});

// ── remote (agent-managed) backups ───────────────────────────────────

describe('remote backups', () => {
  function remoteBackupRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'b1',
      name: 'remote backup',
      serverId: 's1',
      target: 'LOCAL',
      status: 'PENDING',
      includeApplications: true,
      includeDatabases: true,
      includeVolumes: true,
      server: { host: '10.0.0.5' },
      ...overrides,
    };
  }

  it('runBackupJob on a remote server enqueues a BACKUP task with resolved creds + deterministic volumes', async () => {
    const { service, prisma, agent, encryption } = makeService();
    prisma.backup.findUnique.mockResolvedValue(remoteBackupRow());
    prisma.backup.update.mockResolvedValue({});
    prisma.database.findMany.mockResolvedValue([
      {
        id: 'd1', name: 'maindb', type: 'POSTGRESQL', host: 'x',
        username: 'admin', password: 'enc:pw', autoImported: false,
      },
    ]);
    prisma.application.findMany.mockResolvedValue([{ id: 'app123456789012', name: 'Web App' }]);
    encryption.decrypt.mockReturnValue('decrypted-pw');

    await (service as any).runBackupJob('b1');

    // Row flipped to IN_PROGRESS and stays there — the task result finalizes.
    expect(prisma.backup.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'IN_PROGRESS' },
    });
    expect(agent.enqueueTask).toHaveBeenCalledTimes(1);
    const [serverId, type, payload] = agent.enqueueTask.mock.calls[0];
    expect(serverId).toBe('s1');
    expect(type).toBe('BACKUP');
    expect(payload.backupId).toBe('b1');
    expect(payload.uploadName).toBe('b1.tar.gz');
    expect(payload.databases).toEqual([
      expect.objectContaining({
        id: 'd1',
        type: 'POSTGRESQL',
        container: 'dockcontrol-db-maindb', // manually provisioned naming scheme
        username: 'admin',
        // ENCRYPTED in the stored payload — poll() decrypts when serving the
        // task to the agent. Plaintext must never reach agent_tasks.
        password: 'v1.enc(decrypted-pw)',
        name: 'maindb',
        dumpAll: false,
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain('"decrypted-pw"');
    // Deterministic <composeProject>_data names — no docker volume ls remotely.
    expect(payload.volumes).toContain('maindb_data');
    expect(payload.volumes.some((v: string) => v.startsWith('web-app-'))).toBe(true);
  });

  it('runBackupJob fails the row when the enqueue fails', async () => {
    const { service, prisma, agent, notifications } = makeService();
    prisma.backup.findUnique.mockResolvedValue(remoteBackupRow());
    prisma.backup.update.mockResolvedValue({});
    prisma.database.findMany.mockResolvedValue([]);
    prisma.application.findMany.mockResolvedValue([]);
    agent.enqueueTask.mockRejectedValue(new Error('agent unreachable'));

    await (service as any).runBackupJob('b1');

    expect(prisma.backup.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'FAILED' },
    });
    expect(notifications.sendBackupResult).toHaveBeenCalledWith(
      expect.objectContaining({ backupId: 'b1', status: 'FAILED' }),
    );
  });

  it('BACKUP completion handler moves the uploaded archive and replays the finalize flow', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.backup.findUnique.mockResolvedValue(remoteBackupRow({ status: 'IN_PROGRESS' }));
    prisma.backup.update.mockResolvedValue({});
    const sha = vi.spyOn(service as any, 'sha256File').mockResolvedValue('deadbeef');

    await service.onRemoteBackupTaskResult({
      id: 'task1',
      serverId: 's1',
      type: 'BACKUP',
      status: 'COMPLETED',
      payload: { backupId: 'b1', uploadName: 'b1.tar.gz' },
    } as any);

    // transfers/<taskId>/<uploadName> → BACKUPS_DIR/<backupId>.tar.gz
    expect(mockFs.promises.rename).toHaveBeenCalledWith(
      expect.stringContaining('task1'),
      expect.stringContaining('b1.tar.gz'),
    );
    // encrypt(no key)→sha256→COMPLETED — same tail as the local engine.
    expect(sha).toHaveBeenCalled();
    expect(prisma.backup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'b1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          sha256: 'deadbeef',
          filename: 'b1.tar.gz',
        }),
      }),
    );
    expect(notifications.sendBackupResult).toHaveBeenCalledWith(
      expect.objectContaining({ backupId: 'b1', status: 'COMPLETED' }),
    );
  });

  it('BACKUP completion handler fails the row on a FAILED task', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.backup.findUnique.mockResolvedValue(remoteBackupRow({ status: 'IN_PROGRESS' }));
    prisma.backup.update.mockResolvedValue({});

    await service.onRemoteBackupTaskResult({
      id: 'task1',
      serverId: 's1',
      type: 'BACKUP',
      status: 'FAILED',
      payload: { backupId: 'b1' },
      error: 'disk full on remote host',
    } as any);

    expect(prisma.backup.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'FAILED' },
    });
    expect(notifications.sendBackupResult).toHaveBeenCalledWith(
      expect.objectContaining({
        backupId: 'b1',
        status: 'FAILED',
        error: 'disk full on remote host',
      }),
    );
  });

  it('a short configured encryption key FAILS the backup instead of silently writing plaintext', async () => {
    const { service, prisma, systemConfig, notifications } = makeService();
    prisma.backup.findUnique.mockResolvedValue(remoteBackupRow({ status: 'IN_PROGRESS' }));
    prisma.backup.update.mockResolvedValue({});
    // Key IS configured but too short — must not collapse into a plaintext dump.
    systemConfig.get.mockReturnValue('shortkey');

    await service.onRemoteBackupTaskResult({
      id: 'task1',
      serverId: 's1',
      type: 'BACKUP',
      status: 'COMPLETED',
      payload: { backupId: 'b1', uploadName: 'b1.tar.gz' },
    } as any);

    // Row FAILED — never COMPLETED — and the operator is told why.
    expect(prisma.backup.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'FAILED' },
    });
    expect(prisma.backup.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    );
    expect(notifications.sendBackupResult).toHaveBeenCalledWith(
      expect.objectContaining({
        backupId: 'b1',
        status: 'FAILED',
        error: expect.stringContaining('too short'),
      }),
    );
  });

  it('BACKUP completion handler ignores tasks without a backupId and already-final rows', async () => {
    const { service, prisma } = makeService();

    await service.onRemoteBackupTaskResult({
      id: 'task1', serverId: 's1', type: 'BACKUP', status: 'COMPLETED', payload: {},
    } as any);
    expect(prisma.backup.findUnique).not.toHaveBeenCalled();

    prisma.backup.findUnique.mockResolvedValue(remoteBackupRow({ status: 'COMPLETED' }));
    await service.onRemoteBackupTaskResult({
      id: 'task1', serverId: 's1', type: 'BACKUP', status: 'COMPLETED',
      payload: { backupId: 'b1' },
    } as any);
    expect(prisma.backup.update).not.toHaveBeenCalled();
  });

  it('restore on a remote server stages the archive and queues a RESTORE task', async () => {
    const { service, prisma, agent } = makeService();
    grantAccess(prisma, ['s1']);
    // The shared verify/extract gate runs before the remote branch — let the
    // promisified `tar -xzf` succeed.
    vi.mocked(execFile).mockImplementation(((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    }) as any);
    prisma.backup.findUnique.mockResolvedValue({
      id: 'b1',
      serverId: 's1',
      target: 'LOCAL',
      status: 'COMPLETED',
      filename: 'b1.tar.gz',
      sha256: null,
      encryptedAt: false,
    });
    prisma.server.findUnique.mockResolvedValue({ host: '10.0.0.5' });
    prisma.database.findUnique.mockResolvedValue({
      id: 'd1', name: 'maindb', type: 'POSTGRESQL', host: 'x',
      username: 'admin', password: 'enc', autoImported: false,
    });
    mockFs.promises.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        databases: [{ id: 'd1', name: 'maindb', type: 'POSTGRESQL', container: 'c', file: 'databases/d1.sql', dumpAll: false }],
        volumes: ['maindb_data'],
      }),
    );

    const res = await service.restore('u1', 'b1');

    // Archive staged under a local transfer id the agent can download from.
    expect(mockFs.promises.copyFile).toHaveBeenCalledWith(
      expect.stringContaining('b1.tar.gz'),
      expect.stringContaining('local-xfer-1'),
    );
    expect(agent.enqueueTask).toHaveBeenCalledWith('s1', 'RESTORE',
      expect.objectContaining({
        downloadName: 'b1.tar.gz',
        sourceTaskId: 'local-xfer-1',
        volumes: ['maindb_data'],
        // password is encrypted in the stored payload (decrypted by poll()).
        databases: [expect.objectContaining({ id: 'd1', container: 'dockcontrol-db-maindb', password: 'v1.enc(pw)' })],
      }),
    );
    expect(res.message).toContain('queued on remote server');
  });
});
