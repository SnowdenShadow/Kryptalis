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
    server: { findFirst: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
  };
}

function makeService() {
  const prisma = makePrisma();
  const admin = { getDeploymentMode: vi.fn() };
  const agent = { enqueueTask: vi.fn() };
  const proxy = { regenerate: vi.fn().mockResolvedValue(undefined) };
  const mailServer = { removeForDomain: vi.fn() };
  const notifications = { sendUserInvited: vi.fn() };
  const service = new ProjectsService(
    prisma as any,
    admin as any,
    agent as any,
    proxy as any,
    mailServer as any,
    notifications as any,
  );
  return { service, prisma, admin, agent, proxy, mailServer, notifications };
}

const mockAssert = vi.mocked(assertProjectAccess);
const mockGetRole = vi.mocked(getProjectRole);
const mockListIds = vi.mocked(listAccessibleProjectIds);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create', () => {
  it('LOCAL mode: overrides any client-sent serverId with the local server', async () => {
    const { service, prisma, admin } = makeService();
    admin.getDeploymentMode.mockResolvedValue('LOCAL');
    prisma.server.findFirst.mockResolvedValue({ id: 'srv-local' });
    prisma.project.create.mockResolvedValue({ id: 'p1' });

    await service.create('u1', { name: 'demo', serverId: 'srv-evil' } as any);

    expect(prisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ serverId: 'srv-local', userId: 'u1' }),
      }),
    );
  });

  it('LOCAL mode: 400 when no local server is provisioned', async () => {
    const { service, prisma, admin } = makeService();
    admin.getDeploymentMode.mockResolvedValue('LOCAL');
    prisma.server.findFirst.mockResolvedValue(null);

    await expect(service.create('u1', { name: 'demo' } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('MULTI mode: requires a serverId', async () => {
    const { service, admin } = makeService();
    admin.getDeploymentMode.mockResolvedValue('MULTI');

    await expect(service.create('u1', { name: 'demo' } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('MULTI mode: rejects a server that is not ONLINE', async () => {
    const { service, prisma, admin } = makeService();
    admin.getDeploymentMode.mockResolvedValue('MULTI');
    prisma.server.findUnique.mockResolvedValue({ id: 's1', name: 'node-1', status: 'OFFLINE' });

    await expect(
      service.create('u1', { name: 'demo', serverId: 's1' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates the creator as OWNER member', async () => {
    const { service, prisma, admin } = makeService();
    admin.getDeploymentMode.mockResolvedValue('MULTI');
    prisma.server.findUnique.mockResolvedValue({ id: 's1', name: 'node-1', status: 'ONLINE' });
    prisma.project.create.mockResolvedValue({ id: 'p1' });

    await service.create('u1', { name: 'demo', serverId: 's1' } as any);

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
    notifications.sendUserInvited.mockRejectedValue(new Error('smtp down'));

    const res = await service.addMember('p1', 'actor', { userId: 'u2', role: 'DEVELOPER' });
    expect(res.id).toBe('m2');
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
  function setupMigrate() {
    const ctx = makeService();
    mockAssert.mockResolvedValue('ADMIN');
    ctx.prisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      serverId: 'old',
      server: { id: 'old', host: '10.0.0.1', name: 'old-node' },
      applications: [{ id: 'a1', name: 'Web App', status: 'RUNNING' }],
      databases: [{ id: 'd1', name: 'maindb' }],
    });
    ctx.prisma.server.findUnique.mockResolvedValue({ id: 'new', name: 'new-node', status: 'ONLINE' });
    return ctx;
  }

  it('rejects migrating to the same server', async () => {
    const { service, prisma } = setupMigrate();
    prisma.server.findUnique.mockResolvedValue({ id: 'old', name: 'old-node', status: 'ONLINE' });
    prisma.project.findUnique.mockResolvedValue({
      id: 'p1', serverId: 'old', server: { id: 'old' }, applications: [], databases: [],
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

  it('tears down with purgeVolumes:false and re-deploys on the target', async () => {
    const { service, prisma, agent } = setupMigrate();
    agent.enqueueTask.mockResolvedValue({});
    prisma.project.update.mockResolvedValue({});

    const res = await service.migrate('p1', 'u1', 'new');

    expect(agent.enqueueTask).toHaveBeenCalledWith('old', 'REMOVE',
      expect.objectContaining({ purgeVolumes: false }));
    expect(agent.enqueueTask).toHaveBeenCalledWith('new', 'DEPLOY',
      expect.objectContaining({ applicationId: 'a1' }));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { serverId: 'new' },
    });
    expect(res.status).toBe('ok');
    expect(res.queued).toContain('Web App');
    expect(res.queued).toContain('db:maindb');
  });

  it('keeps migrating when the old server is unreachable, reporting warnings', async () => {
    const { service, prisma, agent } = setupMigrate();
    agent.enqueueTask.mockImplementation(async (serverId: string) => {
      if (serverId === 'old') throw new Error('agent offline');
      return {};
    });
    prisma.project.update.mockResolvedValue({});

    const res = await service.migrate('p1', 'u1', 'new');
    expect(res.status).toBe('ok');
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('reports partial status when re-deploy enqueue fails', async () => {
    const { service, prisma, agent } = setupMigrate();
    agent.enqueueTask.mockImplementation(async (serverId: string, type: string) => {
      if (type === 'DEPLOY') throw new Error('queue full');
      return {};
    });
    prisma.project.update.mockResolvedValue({});

    const res = await service.migrate('p1', 'u1', 'new');
    expect(res.status).toBe('partial');
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

    expect(mesh.apps[0].host).toBe('kryptalis-my-shop');
    expect(mesh.apps[0].url).toBe('http://kryptalis-my-shop:3000');
    expect(mesh.databases[0].host).toBe('kryptalis-db-shopdb');
    expect(mesh.databases[0].url).toContain('postgres://shop:');
    expect(mesh.envSuggestions).toHaveLength(1);
    expect(mesh.envSuggestions[0].envVar).toBe('DATABASE_URL');
  });

  it('404s on a missing project', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER');
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(service.getServiceMesh('p1', 'u1')).rejects.toThrow(NotFoundException);
  });
});
