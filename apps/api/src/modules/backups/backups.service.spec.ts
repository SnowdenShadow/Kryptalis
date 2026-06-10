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

vi.mock('fs', () => {
  const promises = {
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue('/tmp/kryptalis-test'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{}'),
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
    server: { findMany: vi.fn() },
    projectMember: { findMany: vi.fn() },
    database: { findMany: vi.fn(), findUnique: vi.fn() },
    application: { findMany: vi.fn() },
  };
}

function makeService() {
  const prisma = makePrisma();
  const systemConfig = { get: vi.fn().mockReturnValue(undefined) };
  const encryption = { decrypt: vi.fn().mockReturnValue('pw') };
  const notifications = { sendBackupResult: vi.fn().mockResolvedValue(undefined) };
  const service = new BackupsService(
    prisma as any,
    systemConfig as any,
    encryption as any,
    notifications as any,
  );
  return { service, prisma, systemConfig, encryption, notifications };
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

  it('skips remote (agent-managed) servers — the engine is local-only', async () => {
    const { service, prisma } = makeService();
    prisma.backup.findMany.mockResolvedValue([
      template({ server: { host: '10.0.0.5' } }),
    ]);

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
