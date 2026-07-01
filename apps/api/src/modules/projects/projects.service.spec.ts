import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
  getProjectRole: vi.fn(),
  listAccessibleProjectIds: vi.fn(),
}));

import {
  assertProjectAccess,
  getProjectRole,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { ProjectsService } from './projects.service';

/**
 * Pure service-level tests: every dependency is a plain object of vi.fn()s —
 * no DB, no docker, no TestingModule (same approach as project-access.spec).
 */
function makePrisma() {
  return {
    project: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    projectMember: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    application: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    database: { updateMany: vi.fn().mockResolvedValue({}) },
    containerMetric: { findMany: vi.fn().mockResolvedValue([]) },
    agentTask: { findFirst: vi.fn() },
    server: { findFirst: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
  };
}

function makeService() {
  const prisma = makePrisma();
  const admin = { getDeploymentMode: vi.fn() };
  const agent = {
    enqueueTask: vi.fn().mockResolvedValue({ id: 't-1' }),
    // Default: every awaited agent task succeeds. Individual tests override.
    enqueueAndWait: vi.fn().mockResolvedValue({ id: 't-1', status: 'COMPLETED', result: { volumes: [] } }),
    registerTaskCompletionHandler: vi.fn(),
    transferDir: vi.fn((id: string) => `/data/transfers/${id}`),
    newLocalTransferId: vi.fn().mockReturnValue('local-xfer-1'),
    cleanupTransfers: vi.fn().mockResolvedValue(undefined),
  };
  const proxy = { regenerate: vi.fn().mockResolvedValue(undefined) };
  const mailServer = { removeForDomain: vi.fn() };
  const notifications = { sendUserInvited: vi.fn(), sendUserAddedToProject: vi.fn() };
  const ops = { redeploy: vi.fn().mockResolvedValue({ message: 'ok' }) };
  const encryption = { decrypt: vi.fn((v: string) => v) };
  // ApplicationsService.remove() — project teardown delegates per-app cleanup
  // to it now (single source of truth). Default: resolves; tests assert calls.
  const applications = { remove: vi.fn().mockResolvedValue({ message: 'Application deleted' }) };
  // DatabasesService.remove() — standalone-DB teardown delegates to it so each
  // DB is torn down on its OWN server (per-DB placement). Default: resolves.
  const databases = { remove: vi.fn().mockResolvedValue({ message: 'Database deleted' }) };
  const service = new ProjectsService(
    prisma as any,
    admin as any,
    agent as any,
    proxy as any,
    mailServer as any,
    notifications as any,
    ops as any,
    encryption as any,
    applications as any,
    databases as any,
  );
  return { service, prisma, admin, agent, proxy, mailServer, notifications, ops, encryption, applications, databases };
}

const mockAssert = vi.mocked(assertProjectAccess);
const mockGetRole = vi.mocked(getProjectRole);
const mockListIds = vi.mocked(listAccessibleProjectIds);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create', () => {
  // A project is a purely logical grouping now — it has NO server. create()
  // never touches the server table; the machine is chosen per app/DB later.
  it('creates a server-agnostic project (no serverId written, no server lookup)', async () => {
    const { service, prisma } = makeService();
    prisma.project.create.mockResolvedValue({ id: 'p1' });

    await service.create('u1', { name: 'demo' } as any);

    const arg = prisma.project.create.mock.calls[0][0];
    expect(arg.data).toEqual(expect.objectContaining({ name: 'demo', userId: 'u1' }));
    expect(arg.data).not.toHaveProperty('serverId');
    // No server resolution happens at project-create time.
    expect(prisma.server.findFirst).not.toHaveBeenCalled();
    expect(prisma.server.findUnique).not.toHaveBeenCalled();
  });

  it('creates the creator as OWNER member', async () => {
    const { service, prisma } = makeService();
    prisma.project.create.mockResolvedValue({ id: 'p1' });

    await service.create('u1', { name: 'demo' } as any);

    expect(prisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          members: { create: { userId: 'u1', role: 'OWNER' } },
        }),
      }),
    );
  });
});

describe('findAll / findOne', () => {
  it('findAll returns [] without querying when the user has no accessible projects', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue([]);

    expect(await service.findAll('u1')).toEqual([]);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('findOne attaches the caller role as currentRole', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('DEVELOPER');
    prisma.project.findUnique.mockResolvedValue({ id: 'p1', name: 'demo' });

    const res = await service.findOne('p1', 'u1');
    expect(res.currentRole).toBe('DEVELOPER');
  });

  it('findOne 404s when the project row is gone', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(service.findOne('p1', 'u1')).rejects.toThrow(NotFoundException);
  });
});

describe('setQuota', () => {
  it('rejects non-integer input', async () => {
    const { service } = makeService();
    await expect(service.setQuota('p1', 'not-a-number')).rejects.toThrow(BadRequestException);
  });

  it('rejects negative quota', async () => {
    const { service } = makeService();
    await expect(service.setQuota('p1', -1)).rejects.toThrow(BadRequestException);
  });

  it('accepts 0 and persists as bigint', async () => {
    const { service, prisma } = makeService();
    prisma.project.findUnique.mockResolvedValue({ id: 'p1' });
    prisma.project.update.mockResolvedValue({ id: 'p1' });

    await service.setQuota('p1', 0);
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { storageQuotaBytes: 0n },
      }),
    );
  });
});

describe('updateMember', () => {
  it('only an OWNER can modify an OWNER', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm1', role: 'OWNER' });

    await expect(service.updateMember('p1', 'actor', 'm1', 'ADMIN')).rejects.toThrow(
      'Only the OWNER can modify the OWNER',
    );
  });

  it('only an OWNER can grant OWNER', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm1', role: 'DEVELOPER' });

    await expect(service.updateMember('p1', 'actor', 'm1', 'OWNER')).rejects.toThrow(
      'Only the OWNER can grant OWNER role',
    );
  });

  it('refuses to demote the last OWNER', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('OWNER');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm1', role: 'OWNER' });
    prisma.projectMember.count.mockResolvedValue(1);

    await expect(service.updateMember('p1', 'actor', 'm1', 'ADMIN')).rejects.toThrow(
      'Cannot demote the last OWNER',
    );
    expect(prisma.projectMember.update).not.toHaveBeenCalled();
  });

  it('allows demoting an OWNER when another OWNER remains', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('OWNER');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm1', role: 'OWNER' });
    prisma.projectMember.count.mockResolvedValue(2);
    prisma.projectMember.update.mockResolvedValue({ id: 'm1', role: 'ADMIN' });

    const res = await service.updateMember('p1', 'actor', 'm1', 'ADMIN');
    expect(res.role).toBe('ADMIN');
  });

  it('is a no-op when the role is unchanged', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm1', role: 'DEVELOPER' });

    await service.updateMember('p1', 'actor', 'm1', 'DEVELOPER');
    expect(prisma.projectMember.update).not.toHaveBeenCalled();
  });

  it('404s on a member from another project', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('OWNER');
    prisma.projectMember.findFirst.mockResolvedValue(null);

    await expect(service.updateMember('p1', 'actor', 'mX', 'VIEWER')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('removeMember', () => {
  it('refuses to remove the last OWNER', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('OWNER');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm1', role: 'OWNER', userId: 'other' });
    prisma.projectMember.count.mockResolvedValue(1);

    await expect(service.removeMember('p1', 'actor', 'm1')).rejects.toThrow(
      'Cannot remove the last OWNER',
    );
    expect(prisma.projectMember.delete).not.toHaveBeenCalled();
  });

  it('a non-OWNER admin cannot remove an OWNER even when several exist', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm1', role: 'OWNER', userId: 'other' });
    prisma.projectMember.count.mockResolvedValue(2);

    await expect(service.removeMember('p1', 'actor', 'm1')).rejects.toThrow(
      'Only OWNERs can remove an OWNER',
    );
  });

  it('removes a regular member', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm1', role: 'VIEWER', userId: 'other' });
    prisma.projectMember.delete.mockResolvedValue({});

    const res = await service.removeMember('p1', 'actor', 'm1');
    expect(res).toEqual({ message: 'Member removed' });
    expect(prisma.projectMember.delete).toHaveBeenCalledWith({ where: { id: 'm1' } });
  });
});

describe('remove (project teardown)', () => {
  function setupRemove(project: any) {
    const ctx = makeService();
    const { prisma } = ctx;
    mockAssert.mockResolvedValue('OWNER');
    prisma.project.findUnique.mockResolvedValue(project);
    // domain.deleteMany + project.delete are hit at the end of remove().
    (prisma as any).domain = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
    prisma.project.delete.mockResolvedValue({});
    return ctx;
  }

  const localProject = {
    id: 'p1', name: 'Shop', serverId: 'srv1', server: { id: 'srv1', host: 'localhost' },
    applications: [
      { id: 'prestaapp01', name: 'prestashop', server: { id: 'srv1', host: 'localhost' } },
    ],
    // A bundled DB (rides the app) + a standalone DB.
    databases: [
      { id: 'bundled1', name: 'prestashop', autoImported: true },
      { id: 'standalone1', name: 'analytics', autoImported: false },
    ],
    domains: [],
  };

  it('delegates each app teardown to applications.remove() (the real, dir-resolving path)', async () => {
    const { service, applications } = setupRemove(localProject);
    await service.remove('p1', 'u1');
    expect(applications.remove).toHaveBeenCalledTimes(1);
    expect(applications.remove).toHaveBeenCalledWith('u1', 'prestaapp01');
  });

  it('delegates standalone DB teardown to databases.remove() (its OWN server); skips bundled DBs', async () => {
    const { service, databases } = setupRemove(localProject);
    await service.remove('p1', 'u1');
    // Standalone DB → databases.remove() with its row id (which resolves the
    // DB's OWN server, so a DB placed off-project is torn down on the right host).
    expect(databases.remove).toHaveBeenCalledTimes(1);
    expect(databases.remove).toHaveBeenCalledWith('u1', 'standalone1');
    // Bundled DB → NEVER hits the standalone loop (it left with its app).
    expect(databases.remove).not.toHaveBeenCalledWith('u1', 'bundled1');
  });

  it('one DB cleanup failure does not abort the whole teardown', async () => {
    const { service, prisma, databases } = setupRemove(localProject);
    databases.remove.mockRejectedValueOnce(new Error('docker hiccup'));
    await service.remove('p1', 'u1');
    // Teardown still completes: the project row is deleted.
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });

  it('still deletes the project row + domains at the end', async () => {
    const { service, prisma } = setupRemove(localProject);
    await service.remove('p1', 'u1');
    expect((prisma as any).domain.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'p1' } });
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });

  it('one app cleanup failure does not abort the whole teardown', async () => {
    const { service, prisma, applications } = setupRemove(localProject);
    applications.remove.mockRejectedValueOnce(new Error('docker hiccup'));
    await service.remove('p1', 'u1');
    // Despite the app failure, the project is still deleted (best-effort).
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });
});

describe('addMember', () => {
  it('only the OWNER can grant OWNER', async () => {
    const { service } = makeService();
    mockAssert.mockResolvedValue('ADMIN');

    await expect(
      service.addMember('p1', 'actor', { userId: 'u2', role: 'OWNER' }),
    ).rejects.toThrow('Only the OWNER can grant OWNER role');
  });

  it('resolves the target by email and 404s on unknown address', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('OWNER');
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.addMember('p1', 'actor', { email: 'ghost@x.io', role: 'VIEWER' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('requires email or userId', async () => {
    const { service } = makeService();
    mockAssert.mockResolvedValue('OWNER');

    await expect(service.addMember('p1', 'actor', { role: 'VIEWER' } as any)).rejects.toThrow(
      'email or userId required',
    );
  });

  it('upserts the membership and survives a notification failure', async () => {
    const { service, prisma, notifications } = makeService();
    mockAssert.mockResolvedValue('OWNER');
    prisma.projectMember.upsert.mockResolvedValue({
      id: 'm2',
      createdAt: new Date(),
      user: { id: 'u2', name: 'Bob', email: 'bob@x.io' },
    });
    prisma.project.findUnique.mockResolvedValue({ name: 'demo' });
    prisma.user.findUnique.mockResolvedValue({ name: 'Alice' });
    notifications.sendUserAddedToProject.mockRejectedValue(new Error('smtp down'));

    const res = await service.addMember('p1', 'actor', { userId: 'u2', role: 'DEVELOPER' });
    expect(res.id).toBe('m2');
  });

  it('sends a no-token "added to project" email (not the dead invite-accept CTA)', async () => {
    const { service, prisma, notifications } = makeService();
    mockAssert.mockResolvedValue('OWNER');
    prisma.projectMember.upsert.mockResolvedValue({
      id: 'm2',
      createdAt: new Date(),
      user: { id: 'u2', name: 'Bob', email: 'bob@x.io' },
    });
    prisma.project.findUnique.mockResolvedValue({ name: 'demo' });
    prisma.user.findUnique.mockResolvedValue({ name: 'Alice' });

    await service.addMember('p1', 'actor', { userId: 'u2', role: 'DEVELOPER' });

    expect(notifications.sendUserInvited).not.toHaveBeenCalled();
    expect(notifications.sendUserAddedToProject).toHaveBeenCalledWith(
      'bob@x.io',
      'demo',
      'Alice',
      'p1',
    );
  });
});

describe('transferOwnership', () => {
  it('rejects transferring to yourself', async () => {
    const { service } = makeService();
    await expect(service.transferOwnership('p1', 'u1', 'u1')).rejects.toThrow(
      'You already are the OWNER',
    );
  });

  it('only the OWNER can transfer', async () => {
    const { service } = makeService();
    mockGetRole.mockResolvedValue('ADMIN');

    await expect(service.transferOwnership('p1', 'u1', 'u2')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('target must already be a member', async () => {
    const { service, prisma } = makeService();
    mockGetRole.mockResolvedValue('OWNER');
    prisma.projectMember.findFirst.mockResolvedValue(null);

    await expect(service.transferOwnership('p1', 'u1', 'u2')).rejects.toThrow(
      'Target user must already be a project member',
    );
  });

  it('runs the promote/demote/legacy-pointer swap in one transaction', async () => {
    const { service, prisma } = makeService();
    mockGetRole.mockResolvedValue('OWNER');
    prisma.projectMember.findFirst.mockResolvedValue({ id: 'm2', userId: 'u2' });

    const res = await service.transferOwnership('p1', 'u1', 'u2');
    expect(res).toEqual({ message: 'Ownership transferred' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.projectMember.update).toHaveBeenCalledWith({
      where: { id: 'm2' },
      data: { role: 'OWNER' },
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { userId: 'u2' },
    });
  });
});

describe('migrate', () => {
  // Default fixture: remote source (10.0.0.1) → remote target (10.0.0.2),
  // one app + one postgres DB. enqueueAndWait succeeds by default; VOLUME_LIST
  // returns the two real volumes; the chained import poll finds a COMPLETED row.
  // Resolve each server by id — migrate now looks up BOTH the target and the
  // source (the source is derived from the apps' own serverId).
  const SERVERS: Record<string, any> = {
    old: { id: 'old', name: 'old-node', host: '10.0.0.1', status: 'ONLINE' },
    new: { id: 'new', name: 'new-node', host: '10.0.0.2', status: 'ONLINE' },
  };
  function setupMigrate() {
    const ctx = makeService();
    mockAssert.mockResolvedValue('OWNER');
    // A project has no server; every app/DB carries its own serverId ('old').
    ctx.prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      applications: [{ id: 'a1', name: 'Web App', status: 'RUNNING', serverId: 'old', hostPort: null }],
      databases: [{ id: 'd1', name: 'maindb', type: 'POSTGRESQL', username: 'u', password: 'enc:p', port: 5440, autoImported: false, serverId: 'old' }],
      domains: [],
    });
    ctx.prisma.server.findUnique.mockImplementation(async (args: any) => SERVERS[args?.where?.id] ?? null);
    ctx.prisma.project.update.mockResolvedValue({});
    // Source VOLUME_LIST returns the real host volume names.
    ctx.agent.enqueueAndWait.mockImplementation(async (_s: string, type: string) => {
      if (type === 'VOLUME_LIST') return { id: 'vl', status: 'COMPLETED', result: { volumes: ['web-app-a1_data', 'maindb_data'] } };
      return { id: 't', status: 'COMPLETED' };
    });
    // Chained remote→remote import poll → already COMPLETED.
    ctx.prisma.agentTask.findFirst.mockResolvedValue({ id: 'imp', status: 'COMPLETED' });
    return ctx;
  }

  it('requires OWNER (matches remove), not ADMIN', async () => {
    const { service } = setupMigrate();
    await service.migrate('p1', 'u1', 'new');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'OWNER');
  });

  it('rejects migrating to the same server (all apps/DBs already there)', async () => {
    const { service, prisma } = setupMigrate();
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      applications: [{ id: 'a1', name: 'Web App', status: 'RUNNING', serverId: 'old', hostPort: null }],
      databases: [],
      domains: [],
    });

    await expect(service.migrate('p1', 'u1', 'old')).rejects.toThrow(
      'Project is already on this server',
    );
  });

  it('rejects an offline target server', async () => {
    const { service, prisma } = setupMigrate();
    prisma.server.findUnique.mockResolvedValue({ id: 'new', name: 'new-node', status: 'OFFLINE' });

    await expect(service.migrate('p1', 'u1', 'new')).rejects.toThrow(
      'must be ONLINE',
    );
  });

  it('discovers REAL volumes via an awaited VOLUME_LIST on the SOURCE (no name-guessing)', async () => {
    const { service, agent } = setupMigrate();
    await service.migrate('p1', 'u1', 'new');

    const vlCall = agent.enqueueAndWait.mock.calls.find(([, type]: any[]) => type === 'VOLUME_LIST');
    expect(vlCall).toBeDefined();
    const [vlServer, , vlPayload] = vlCall!;
    expect(vlServer).toBe('old');
    // Prefixes derived from canonical appVolumePrefix/dbVolumePrefix.
    expect(vlPayload.prefixes.some((p: string) => p.startsWith('web-app-'))).toBe(true);
    expect(vlPayload.prefixes).toContain('maindb_');
  });

  it('tears down the source with purgeVolumes:false and AWAITs it before export', async () => {
    const { service, agent } = setupMigrate();
    await service.migrate('p1', 'u1', 'new');
    // REMOVE is awaited (enqueueAndWait), purgeVolumes false, on the OLD server.
    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'old', 'REMOVE', expect.objectContaining({ purgeVolumes: false }), expect.any(Number),
    );
    // DB teardown uses the RAW name (never slugified).
    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'old', 'REMOVE',
      expect.objectContaining({ slug: 'db-maindb', containerName: 'dockcontrol-db-maindb', purgeVolumes: false }),
      expect.any(Number),
    );
  });

  it('deploys APPS through ops.redeploy — never a bare {applicationId} DEPLOY', async () => {
    const { service, agent, ops } = setupMigrate();
    const res = await service.migrate('p1', 'u1', 'new');

    expect(ops.redeploy).toHaveBeenCalledWith('u1', 'a1');
    // No bare app-marker DEPLOY enqueued anywhere.
    const bare = agent.enqueueAndWait.mock.calls
      .concat(agent.enqueueTask.mock.calls)
      .find(([, type, payload]: any[]) => type === 'DEPLOY' && payload?.applicationId && !payload?.compose && !payload?.dockerImage && !payload?.gitUrl);
    expect(bare).toBeUndefined();
    expect(res.queued).toContain('Web App');
  });

  it('deploys DBs as a proper compose-carrying DEPLOY (slug db-<name>, raw name, full compose)', async () => {
    const { service, agent } = setupMigrate();
    await service.migrate('p1', 'u1', 'new');

    const dbDeploy = agent.enqueueAndWait.mock.calls.find(
      ([s, type, p]: any[]) => s === 'new' && type === 'DEPLOY' && p?.slug === 'db-maindb',
    );
    expect(dbDeploy).toBeDefined();
    const [, , payload] = dbDeploy!;
    expect(payload.appName).toBe('db-maindb');
    expect(typeof payload.compose).toBe('string');
    expect(payload.compose).toContain('container_name: dockcontrol-db-maindb');
    // Never a bare {databaseId} marker.
    expect(payload.databaseId).toBeUndefined();
  });

  it('flips each app.serverId AND database.serverId only AFTER a successful deploy', async () => {
    const { service, prisma } = setupMigrate();
    const res = await service.migrate('p1', 'u1', 'new');

    // A project has no serverId to flip; each app is re-pointed instead (before
    // its deploy, so a failure stays recoverable on the source).
    expect(prisma.application.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { serverId: 'new' },
    });
    // DB rows follow so resolveDbServer / connHost stay correct.
    expect(prisma.database.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', serverId: 'old' },
      data: { serverId: 'new' },
    });
    expect(res.status).toBe('ok');
    expect(res.flipped).toBe(true);
  });

  it('on deploy failure: does NOT flip, restarts the source, returns failed', async () => {
    const { service, prisma, agent, ops } = setupMigrate();
    ops.redeploy.mockReset();
    // First call = the migration deploy (fails); subsequent calls = rollback restart (succeed).
    ops.redeploy
      .mockRejectedValueOnce(new Error('build failed'))
      .mockResolvedValue({ message: 'restarted' });

    const res = await service.migrate('p1', 'u1', 'new');

    expect(res.status).toBe('failed');
    expect(res.flipped).toBe(false);
    // DB serverId NOT flipped on failure (the success-flip is skipped).
    expect(prisma.database.updateMany).not.toHaveBeenCalledWith({
      where: { projectId: 'p1', serverId: 'old' },
      data: { serverId: 'new' },
    });
    // Source restart attempted (rollback) — app via ops.redeploy, db via START.
    expect(ops.redeploy).toHaveBeenCalledTimes(2);
    expect(agent.enqueueTask).toHaveBeenCalledWith('old', 'START', expect.objectContaining({ slug: 'db-maindb' }));
  });

  it('reports partial when the volume transfer degrades (export FAILED) but deploy succeeds', async () => {
    const { service, agent } = setupMigrate();
    agent.enqueueAndWait.mockImplementation(async (_s: string, type: string) => {
      if (type === 'VOLUME_LIST') return { id: 'vl', status: 'COMPLETED', result: { volumes: ['maindb_data'] } };
      if (type === 'VOLUME_EXPORT') return { id: 'exp', status: 'FAILED', error: 'tar broke' };
      return { id: 't', status: 'COMPLETED' };
    });

    const res = await service.migrate('p1', 'u1', 'new');
    expect(res.status).toBe('partial');
    expect(res.warnings.some((w: string) => w.startsWith('volume transfer:'))).toBe(true);
  });

  it('keeps going (warns) when the source teardown is unreachable, still attempts deploy', async () => {
    const { service, agent, ops } = setupMigrate();
    agent.enqueueAndWait.mockImplementation(async (_s: string, type: string) => {
      if (type === 'REMOVE') throw new Error('agent offline');
      if (type === 'VOLUME_LIST') return { id: 'vl', status: 'COMPLETED', result: { volumes: [] } };
      return { id: 't', status: 'COMPLETED' };
    });

    const res = await service.migrate('p1', 'u1', 'new');
    expect(res.warnings.some((w: string) => w.startsWith('teardown '))).toBe(true);
    // Source unreachable degrades status, but the deploy is still attempted.
    expect(ops.redeploy).toHaveBeenCalledWith('u1', 'a1');
    expect(res.status).toBe('partial');
  });

  it('local→remote: exports volumes locally then awaits a remote VOLUME_IMPORT', async () => {
    const { service, prisma, agent } = setupMigrate();
    // Source apps live on a LOCAL server.
    prisma.server.findUnique.mockImplementation(async (args: any) =>
      args?.where?.id === 'old'
        ? { id: 'old', name: 'local-node', host: '127.0.0.1', status: 'ONLINE' }
        : SERVERS.new,
    );
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      applications: [{ id: 'a1', name: 'Web App', status: 'RUNNING', serverId: 'old', hostPort: null }],
      databases: [],
      domains: [],
    });
    agent.enqueueAndWait.mockResolvedValue({ id: 't', status: 'COMPLETED' });
    vi.spyOn(service as any, 'listLocalProjectVolumes').mockResolvedValue(['web-app-a1_data']);
    const exp = vi.spyOn(service as any, 'exportLocalVolumes').mockResolvedValue('local-xfer-1');

    await service.migrate('p1', 'u1', 'new');

    expect(exp).toHaveBeenCalledWith(['web-app-a1_data']);
    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'new', 'VOLUME_IMPORT',
      expect.objectContaining({ volumes: ['web-app-a1_data'], sourceTaskId: 'local-xfer-1' }),
      expect.any(Number),
    );
  });

  it('remote→local: defers the deploys onto the VOLUME_EXPORT migrateLocalImport handler', async () => {
    const { service, prisma, agent } = setupMigrate();
    // Remote source ('old' = 10.0.0.1) → LOCAL target ('new' = 127.0.0.1).
    prisma.server.findUnique.mockImplementation(async (args: any) =>
      args?.where?.id === 'new'
        ? { id: 'new', name: 'local-node', host: '127.0.0.1', status: 'ONLINE' }
        : SERVERS.old,
    );
    // App carries a compose stack so the deferred payload is full-stack.
    prisma.application.findUnique.mockResolvedValue({
      id: 'a1', name: 'Web App', dockerComposeFile: 'services: {}', envVars: null,
    });

    const res = await service.migrate('p1', 'u1', 'new');

    const exportCall = agent.enqueueTask.mock.calls.find(([, type]: any[]) => type === 'VOLUME_EXPORT');
    expect(exportCall).toBeDefined();
    const [, , payload] = exportCall!;
    expect(payload.migrateLocalImport.deploys.length).toBeGreaterThan(0);
    // Deferred app deploy is full-stack (compose), not a bare marker.
    const appDeploy = payload.migrateLocalImport.deploys.find((d: any) => d.payload.applicationId === 'a1');
    expect(appDeploy.payload.compose).toBe('services: {}');
    expect(res.flipped).toBe(true);
    // DB serverId flipped on this leg too.
    expect(prisma.database.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', serverId: 'old' },
      data: { serverId: 'new' },
    });
  });

  it('warns about mailboxes left behind when the project has domains', async () => {
    const { service, prisma } = setupMigrate();
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      applications: [{ id: 'a1', name: 'Web App', status: 'RUNNING', serverId: 'old', hostPort: null }],
      databases: [],
      domains: [{ id: 'dom1' }, { id: 'dom2' }],
    });

    const res = await service.migrate('p1', 'u1', 'new');
    expect(res.warnings.some((w: string) => w.includes('mailbox(es)') && w.includes('mail is not relocated'))).toBe(true);
  });

  it('refuses when the project\'s apps span multiple source servers (move individually)', async () => {
    const { service, prisma } = setupMigrate();
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      applications: [
        { id: 'a1', name: 'Web App', status: 'RUNNING', serverId: 'old', hostPort: null },
        { id: 'a2', name: 'Other', status: 'RUNNING', serverId: 'other', hostPort: null },
      ],
      databases: [],
      domains: [],
    });

    await expect(service.migrate('p1', 'u1', 'new')).rejects.toThrow(
      /span multiple servers/i,
    );
  });

  it('reassigns a colliding hostPort on the target before deploying the app', async () => {
    const { service, prisma } = setupMigrate();
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      applications: [{ id: 'a1', name: 'Web App', status: 'RUNNING', serverId: 'old', hostPort: 8080 }],
      databases: [],
      domains: [],
    });
    // Another app on the TARGET already holds 8080.
    prisma.application.findMany.mockResolvedValue([{ hostPort: 8080 }]);

    const res = await service.migrate('p1', 'u1', 'new');
    // hostPort persisted to a new free value.
    const portUpdate = prisma.application.update.mock.calls.find(
      ([arg]: any[]) => arg?.where?.id === 'a1' && typeof arg?.data?.hostPort === 'number',
    );
    expect(portUpdate).toBeDefined();
    expect(portUpdate![0].data.hostPort).not.toBe(8080);
    expect(res.warnings.some((w: string) => w.startsWith('port:'))).toBe(true);
  });
});

describe('getServiceMesh', () => {
  it('builds DNS hostnames, urls and env suggestions for apps and databases', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      applications: [
        { id: 'a1', name: 'My Shop', status: 'RUNNING', port: 3000, containerName: null, containerPort: null, framework: 'nextjs' },
      ],
      databases: [
        { id: 'd1', name: 'shopdb', type: 'POSTGRESQL', port: 5432, username: 'shop' },
      ],
    });

    const mesh = await service.getServiceMesh('p1', 'u1');

    expect(mesh.apps[0].host).toBe('dockcontrol-my-shop');
    expect(mesh.apps[0].url).toBe('http://dockcontrol-my-shop:3000');
    expect(mesh.databases[0].host).toBe('dockcontrol-db-shopdb');
    expect(mesh.databases[0].url).toContain('postgres://shop:');
    expect(mesh.envSuggestions).toHaveLength(1);
    expect(mesh.envSuggestions[0].envVar).toBe('DATABASE_URL');
  });

  it('REGRESSION: db host uses the raw db.name (matches the real container), not a slugified one', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    // A name slugify would mangle (uppercase + dot): real container is
    // `dockcontrol-db-Cache.1`, but slugify would yield `cache-1`.
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      applications: [],
      databases: [
        { id: 'd1', name: 'Cache.1', type: 'REDIS', port: 6390, username: 'default' },
      ],
    });

    const mesh = await service.getServiceMesh('p1', 'u1');
    expect(mesh.databases[0].host).toBe('dockcontrol-db-Cache.1');
    expect(mesh.databases[0].url).toContain('@dockcontrol-db-Cache.1:6390/Cache.1');
  });

  it('404s on a missing project', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(service.getServiceMesh('p1', 'u1')).rejects.toThrow(NotFoundException);
  });
});

describe('getResourceUsage', () => {
  function cm(over: Record<string, any> = {}) {
    return {
      applicationId: 'a1', containerName: 'dockcontrol-shop',
      cpuPercent: 10, memoryUsed: 100n, memoryLimit: 500n,
      networkIn: 1n, networkOut: 2n, blockRead: 3n, blockWrite: 4n,
      timestamp: new Date('2026-06-01T10:00:00Z'), ...over,
    };
  }

  it('requires VIEWER access', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.application.findMany.mockResolvedValue([]);
    await service.getResourceUsage('p1', 'u1');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'VIEWER');
  });

  it('returns empty totals when the project has no apps', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.application.findMany.mockResolvedValue([]);
    const res = await service.getResourceUsage('p1', 'u1');
    expect(res.apps).toEqual([]);
    expect(res.totals.cpuPercent).toBe(0);
    expect(res.totals.containers).toBe(0);
  });

  it('sums the newest sample of EVERY container per app (multi-container app)', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.application.findMany.mockResolvedValue([
      { id: 'a1', name: 'Shop', displayName: null, status: 'RUNNING', framework: 'PHP_SITE' },
    ]);
    // Two containers for a1 (web + fpm), each with an old + new row (desc order).
    prisma.containerMetric.findMany.mockResolvedValue([
      cm({ containerName: 'dockcontrol-shop', cpuPercent: 12, memoryUsed: 100n }),      // newest web
      cm({ containerName: 'dockcontrol-shop', cpuPercent: 99, memoryUsed: 999n }),      // older web (ignored)
      cm({ containerName: 'dockcontrol-shop-fpm', cpuPercent: 8, memoryUsed: 200n }),   // newest fpm
    ]);
    const res = await service.getResourceUsage('p1', 'u1');
    // Project totals sum both containers' newest: cpu 12+8=20, mem 100+200=300.
    expect(res.totals.cpuPercent).toBe(20);
    expect(res.totals.memoryUsed).toBe(300);
    expect(res.totals.containers).toBe(2);
    expect(res.apps[0].usage.cpuPercent).toBe(20);
  });

  it('an app with no samples reports zero usage (still listed)', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.application.findMany.mockResolvedValue([
      { id: 'a1', name: 'Idle', displayName: null, status: 'STOPPED', framework: 'DOCKER' },
    ]);
    prisma.containerMetric.findMany.mockResolvedValue([]);
    const res = await service.getResourceUsage('p1', 'u1');
    expect(res.apps).toHaveLength(1);
    expect(res.apps[0].usage.memoryUsed).toBe(0);
  });
});

describe('getResourceHistory', () => {
  it('returns [] when the project has no apps', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.application.findMany.mockResolvedValue([]);
    expect(await service.getResourceHistory('p1', 'u1', '24h')).toEqual([]);
  });

  it('buckets and sums CPU + memory across containers over time', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.application.findMany.mockResolvedValue([{ id: 'a1' }]);
    const base = new Date('2026-06-01T10:00:00Z').getTime();
    // Two containers in the SAME 5-min bucket → summed.
    prisma.containerMetric.findMany.mockResolvedValue([
      { cpuPercent: 10, memoryUsed: 100n, timestamp: new Date(base) },
      { cpuPercent: 5, memoryUsed: 50n, timestamp: new Date(base + 30_000) },
    ]);
    const res: any[] = await service.getResourceHistory('p1', 'u1', '24h');
    expect(res).toHaveLength(1);
    expect(res[0].cpuPercent).toBe(15);
    expect(res[0].memoryUsed).toBe(150);
  });
});
