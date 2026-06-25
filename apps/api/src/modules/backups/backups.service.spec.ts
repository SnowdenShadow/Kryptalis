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

// RBAC helpers — mocked so the scope tests don't need full membership
// fixtures. listAccessibleProjectIds mirrors the real shape: admin → every
// project (prisma.project.findMany), else the member/owned set the test seeded
// via grantProjects (prisma.project.findMany also returns that set).
vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn().mockResolvedValue(undefined),
  listAccessibleProjectIds: vi.fn(async (prisma: any) => {
    const rows = await prisma.project.findMany({ select: { id: true } });
    return rows.map((p: any) => p.id);
  }),
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
import { assertProjectAccess } from '../../common/rbac/project-access';
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
    project: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    projectBackupStorage: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    projectMember: { findMany: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
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

/** Admin user — reaches every server + every backup (incl. server-wide). */
function grantAdmin(prisma: ReturnType<typeof makePrisma>, serverIds: string[]) {
  prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
  prisma.server.findMany.mockResolvedValue(serverIds.map((id) => ({ id })));
}

/** Non-admin who is a member of the given projectIds (for project-scoped access). */
function grantProjects(prisma: ReturnType<typeof makePrisma>, projectIds: string[]) {
  prisma.project.findMany.mockResolvedValue(projectIds.map((id) => ({ id })));
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

  it('non-admins see ONLY backups of their own projects (not other projects on the server)', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    grantProjects(prisma, ['p1', 'p2']); // member of p1, p2
    prisma.backup.findMany.mockResolvedValue([]);

    await service.findAll('u1');
    // Scoped to the user's projects → excludes other projects + server-wide (null).
    expect(prisma.backup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          serverId: { in: ['s1'] },
          projectId: { in: ['p1', 'p2'] },
        }),
      }),
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

  it('findOne forbids a backup of a project the user is NOT a member of', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    grantProjects(prisma, ['p1']); // member of p1 only
    prisma.backup.findUnique.mockResolvedValue({ id: 'b1', serverId: 's1', projectId: 'pOther' });

    await expect(service.findOne('u1', 'b1')).rejects.toThrow(ForbiddenException);
  });

  it('findOne allows a backup of the user\'s OWN project', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    grantProjects(prisma, ['p1']);
    const row = { id: 'b1', serverId: 's1', projectId: 'p1' };
    prisma.backup.findUnique.mockResolvedValue(row);

    await expect(service.findOne('u1', 'b1')).resolves.toBe(row);
  });

  it('findOne forbids a non-admin from a SERVER-WIDE backup (projectId null)', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    grantProjects(prisma, ['p1']);
    prisma.backup.findUnique.mockResolvedValue({ id: 'b1', serverId: 's1', projectId: null });

    await expect(service.findOne('u1', 'b1')).rejects.toThrow(/administrators/i);
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
    grantAdmin(prisma, ['s1']); // admin can do a server-wide backup → reaches the S3 check

    await expect(
      service.create('admin', { name: 'b', serverId: 's1', target: 'S3' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.backup.create).not.toHaveBeenCalled();
  });

  it('returns the PENDING row and launches the job in the background', async () => {
    const { service, prisma } = makeService();
    grantAdmin(prisma, ['s1']); // server-wide backup is admin-only
    const row = { id: 'b1', status: 'PENDING' };
    prisma.backup.create.mockResolvedValue(row);
    const job = vi
      .spyOn(service as any, 'runBackupJob')
      .mockResolvedValue(undefined);

    const res = await service.create('admin', {
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

  it('ADMIN can create a whole-server backup (projectId null)', async () => {
    const { service, prisma } = makeService();
    grantAdmin(prisma, ['s1']);
    prisma.backup.create.mockResolvedValue({ id: 'b1', status: 'PENDING' });
    vi.spyOn(service as any, 'runBackupJob').mockResolvedValue(undefined);

    await service.create('admin', { name: 'b', serverId: 's1', target: 'LOCAL' } as any);

    expect(prisma.backup.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: null }) }),
    );
  });

  it('a NON-admin CANNOT create a whole-server backup (must pick a project)', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']); // non-admin, member on s1
    await expect(
      service.create('u1', { name: 'b', serverId: 's1', target: 'LOCAL' } as any),
    ).rejects.toThrow(/administrators only|Choose a project/i);
    expect(prisma.backup.create).not.toHaveBeenCalled();
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

// ── per-project remote storage config ─────────────────────────────────
describe('per-project S3 storage', () => {
  it('s3Config uses the PROJECT bucket when it has a complete config', async () => {
    const { service, prisma, encryption } = makeService();
    prisma.projectBackupStorage.findUnique.mockResolvedValue({
      projectId: 'p1', target: 'R2',
      endpoint: 'https://r2.example.com', bucket: 'proj-bucket', region: 'auto',
      accessKey: 'AK', secretKeyEnc: 'v1.enc(SK)',
    });

    const cfg = await (service as any).s3Config('p1');
    expect(cfg.bucket).toBe('proj-bucket');
    expect(cfg.endpoint).toBe('https://r2.example.com');
    // The stored secretKeyEnc is run through encryption.decrypt (mock → 'pw').
    expect(cfg.secretKey).toBe('pw');
    expect(encryption.decrypt).toHaveBeenCalledWith('v1.enc(SK)');
  });

  it('s3Config falls back to GLOBAL when the project has no config', async () => {
    const { service, prisma, systemConfig } = makeService();
    prisma.projectBackupStorage.findUnique.mockResolvedValue(null);
    systemConfig.get.mockImplementation((k: string) => ({
      s3_endpoint: 'https://global', s3_bucket: 'global-bucket',
      s3_access_key: 'GAK', s3_secret_key: 'GSK', s3_region: 'auto',
    } as any)[k]);

    const cfg = await (service as any).s3Config('p1');
    expect(cfg.bucket).toBe('global-bucket');
  });

  it('setProjectStorage encrypts the secret (never stores plaintext) + upserts', async () => {
    const { service, prisma, encryption } = makeService();
    prisma.projectBackupStorage.findUnique.mockResolvedValue(null);
    prisma.projectBackupStorage.upsert.mockResolvedValue({ target: 'R2', bucket: 'b' });

    await service.setProjectStorage('u1', 'p1', {
      target: 'R2', endpoint: 'https://r2', bucket: 'b', accessKey: 'AK', secretKey: 'plain-secret',
    } as any);

    expect(encryption.encrypt).toHaveBeenCalledWith('plain-secret');
    const upsertArg = prisma.projectBackupStorage.upsert.mock.calls[0][0];
    expect(upsertArg.create.secretKeyEnc).toBe('v1.enc(plain-secret)');
    expect(JSON.stringify(upsertArg)).not.toContain('plain-secret"'); // no raw secret persisted
  });

  it('setProjectStorage keeps the existing secret when none is provided', async () => {
    const { service, prisma, encryption } = makeService();
    prisma.projectBackupStorage.findUnique.mockResolvedValue({ secretKeyEnc: 'v1.enc(old)' });
    prisma.projectBackupStorage.upsert.mockResolvedValue({ target: 'R2', bucket: 'b' });

    await service.setProjectStorage('u1', 'p1', {
      target: 'R2', endpoint: 'https://r2', bucket: 'b', accessKey: 'AK',
    } as any);

    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(prisma.projectBackupStorage.upsert.mock.calls[0][0].update.secretKeyEnc).toBe('v1.enc(old)');
  });

  it('getProjectStorage never returns the secret (only secretKeySet)', async () => {
    const { service, prisma } = makeService();
    prisma.projectBackupStorage.findUnique.mockResolvedValue({
      target: 'R2', endpoint: 'https://r2', bucket: 'b', region: 'auto',
      accessKey: 'AK', secretKeyEnc: 'v1.enc(SK)', updatedAt: new Date(),
    });

    const res: any = await service.getProjectStorage('u1', 'p1');
    expect(res.configured).toBe(true);
    expect(res.secretKeySet).toBe(true);
    expect(JSON.stringify(res)).not.toContain('secretKeyEnc');
    expect(JSON.stringify(res)).not.toContain('SK');
  });

  it('create() with a remote target + a project that has its OWN config succeeds', async () => {
    const { service, prisma } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.project.findUnique.mockResolvedValue({ id: 'p1', serverId: 's1' });
    prisma.projectBackupStorage.findUnique.mockResolvedValue({
      target: 'R2', endpoint: 'https://r2', bucket: 'b', region: 'auto',
      accessKey: 'AK', secretKeyEnc: 'v1.enc(SK)',
    });
    prisma.backup.create.mockResolvedValue({ id: 'b1', status: 'PENDING' });
    vi.spyOn(service as any, 'runBackupJob').mockResolvedValue(undefined);

    await expect(
      service.create('u1', { name: 'b', serverId: 's1', projectId: 'p1', target: 'R2' } as any),
    ).resolves.toBeTruthy();
  });

  it('create() remote target with NO project config and NO global config → 400', async () => {
    const { service, prisma, systemConfig } = makeService();
    grantAccess(prisma, ['s1']);
    prisma.project.findUnique.mockResolvedValue({ id: 'p1', serverId: 's1' });
    prisma.projectBackupStorage.findUnique.mockResolvedValue(null);
    systemConfig.get.mockReturnValue(undefined); // no global config either

    await expect(
      service.create('u1', { name: 'b', serverId: 's1', projectId: 'p1', target: 'S3' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.backup.create).not.toHaveBeenCalled();
  });

  it('getTargets(projectId) requires project access (no cross-tenant probing)', async () => {
    const { service } = makeService();
    // Drive the (mocked) RBAC gate to reject, as it would for a non-member.
    vi.mocked(assertProjectAccess).mockRejectedValueOnce(
      new ForbiddenException('not a member'),
    );
    await expect(service.getTargets('intruder', 'p1')).rejects.toThrow(ForbiddenException);
  });

  it('getTargets(projectId) reports projectConfigured from the project bucket', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' }); // passes access
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue({ id: 'p1', userId: 'admin' });
    prisma.projectBackupStorage.findUnique.mockResolvedValue({
      target: 'R2', endpoint: 'https://r2', bucket: 'b', region: 'auto',
      accessKey: 'AK', secretKeyEnc: 'v1.enc(SK)',
    });

    const res = await service.getTargets('admin', 'p1');
    expect(res.projectConfigured).toBe(true);
    expect(res.s3Configured).toBe(true);
  });

  it('getTargets(projectId) degrades gracefully when the project secret is undecryptable', async () => {
    const { service, prisma, encryption, systemConfig } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue({ id: 'p1', userId: 'admin' });
    prisma.projectBackupStorage.findUnique.mockResolvedValue({
      target: 'R2', endpoint: 'https://r2', bucket: 'b', region: 'auto',
      accessKey: 'AK', secretKeyEnc: 'v1.corrupt',
    });
    encryption.decrypt.mockImplementation(() => { throw new Error('bad key'); });
    systemConfig.get.mockReturnValue(undefined); // no global fallback either

    const res = await service.getTargets('admin', 'p1');
    expect(res.projectConfigured).toBe(false); // did not 500
    expect(res.s3Configured).toBe(false);
  });
});

describe('storage config pinning (restore/delete use the bucket the dump was written to)', () => {
  it('s3ClientForBackup PREFERS the pinned config over the live project config', async () => {
    const { service, prisma, encryption } = makeService();
    // The pinned config points at the ORIGINAL bucket.
    encryption.decrypt.mockReturnValue(JSON.stringify({
      endpoint: 'https://orig', bucket: 'orig-bucket', region: 'auto',
      accessKey: 'OAK', secretKey: 'OSK',
    }));
    const { bucket } = await (service as any).s3ClientForBackup({
      id: 'b1', projectId: 'p1', storageConfigEnc: 'v1.enc(pinned)',
    });
    expect(bucket).toBe('orig-bucket');
    // Must NOT have consulted the live project storage row.
    expect(prisma.projectBackupStorage.findUnique).not.toHaveBeenCalled();
  });

  it('s3ClientForBackup falls back to dynamic resolution for legacy rows (no pinned config)', async () => {
    const { service, prisma } = makeService();
    prisma.projectBackupStorage.findUnique.mockResolvedValue({
      target: 'R2', endpoint: 'https://r2', bucket: 'live-bucket', region: 'auto',
      accessKey: 'AK', secretKeyEnc: 'v1.enc(SK)',
    });
    const { bucket } = await (service as any).s3ClientForBackup({
      id: 'b1', projectId: 'p1', storageConfigEnc: null,
    });
    expect(bucket).toBe('live-bucket');
    expect(prisma.projectBackupStorage.findUnique).toHaveBeenCalled();
  });

  it('finalize pins the resolved config; decode round-trips it', async () => {
    const { service, encryption } = makeService();
    encryption.encrypt.mockImplementation((s: string) => `v1.enc(${s})`);
    const cfg = { endpoint: 'https://r2', bucket: 'b', region: 'auto', accessKey: 'AK', secretKey: 'SK' };
    const enc = (service as any).encodeStorageConfig(cfg);
    expect(enc).toContain('v1.enc(');
    // decode uses encryption.decrypt — make it return the JSON we encoded.
    encryption.decrypt.mockReturnValue(JSON.stringify(cfg));
    expect((service as any).decodeStorageConfig(enc)).toEqual(cfg);
  });

  it('decodeStorageConfig returns null on corrupt envelope (→ caller falls back)', () => {
    const { service, encryption } = makeService();
    encryption.decrypt.mockImplementation(() => { throw new Error('bad'); });
    expect((service as any).decodeStorageConfig('v1.broken')).toBeNull();
  });
});

// ── restore guards ───────────────────────────────────────────────────

describe('restore', () => {
  function setup(backup: Record<string, unknown>) {
    const ctx = makeService();
    // Admin actor: these tests exercise the restore GUARDS (status / filename /
    // sha256), not the access policy — so use an admin to pass the access gate
    // for a server-wide row. Access policy has its own dedicated tests below.
    grantAdmin(ctx.prisma, ['s1']);
    ctx.prisma.backup.findUnique.mockResolvedValue({
      id: 'b1',
      serverId: 's1',
      projectId: null,
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
    grantAdmin(prisma, ['s1']); // server-wide row → admin access; test is about file unlink
    prisma.backup.findUnique.mockResolvedValue({
      id: 'b1',
      serverId: 's1',
      projectId: null,
      target: 'LOCAL',
      filename: 'b1.tar.gz',
    });
    mockFs.promises.unlink.mockRejectedValue(new Error('ENOENT'));
    prisma.backup.delete.mockResolvedValue({});

    const res = await service.remove('admin', 'b1');

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
    grantAdmin(prisma, ['s1']); // server-wide row → admin; test is about the remote restore flow
    // The shared verify/extract gate runs before the remote branch — let the
    // promisified `tar -xzf` succeed.
    vi.mocked(execFile).mockImplementation(((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    }) as any);
    prisma.backup.findUnique.mockResolvedValue({
      id: 'b1',
      serverId: 's1',
      projectId: null,
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

    const res = await service.restore('admin', 'b1');

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
