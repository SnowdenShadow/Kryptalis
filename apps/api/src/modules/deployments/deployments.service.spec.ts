import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
  listAccessibleProjectIds: vi.fn(),
}));

import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { DeploymentsService } from './deployments.service';

/**
 * Pure service-level tests: prisma is a plain object of vi.fn()s, the RBAC
 * helpers are module-mocked. No DB, no TestingModule (same recipe as
 * projects.service.spec).
 */
function makePrisma() {
  return {
    application: { findUnique: vi.fn() },
    deployment: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
  };
}

function makeService() {
  const prisma = makePrisma();
  const systemConfig = { getNumber: vi.fn().mockReturnValue(90) };
  const applications = { redeploy: vi.fn().mockResolvedValue({ id: 'dep-1', status: 'PENDING' }) };
  const service = new DeploymentsService(prisma as any, systemConfig as any, applications as any);
  return { service, prisma, systemConfig, applications };
}

const mockAssert = vi.mocked(assertProjectAccess);
const mockListIds = vi.mocked(listAccessibleProjectIds);

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks wipes call history but NOT implementations, so reset the
  // RBAC helpers to a benign default (a prior test's mockRejectedValue would
  // otherwise leak into the next).
  mockAssert.mockResolvedValue('OWNER' as any);
  mockListIds.mockResolvedValue([]);
});

describe('trigger', () => {
  it('404s on an unknown application (before any RBAC / redeploy)', async () => {
    const { service, prisma, applications } = makeService();
    prisma.application.findUnique.mockResolvedValue(null);

    await expect(service.trigger('u1', { applicationId: 'missing' } as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(mockAssert).not.toHaveBeenCalled();
    expect(applications.redeploy).not.toHaveBeenCalled();
  });

  it('requires DEVELOPER on the owning project, then delegates to applications.redeploy', async () => {
    const { service, prisma, applications } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p1' });

    const res = await service.trigger('u1', { applicationId: 'a1' } as any);

    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'DEVELOPER');
    // Delegates to the REAL deploy path (so the row is processed, not parked PENDING).
    expect(applications.redeploy).toHaveBeenCalledWith('u1', 'a1');
    expect(res).toEqual({ id: 'dep-1', status: 'PENDING' });
  });

  it('propagates an RBAC rejection and never calls redeploy', async () => {
    const { service, prisma, applications } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p1' });
    mockAssert.mockRejectedValue(new Error('Forbidden'));

    await expect(service.trigger('u1', { applicationId: 'a1' } as any)).rejects.toThrow('Forbidden');
    expect(applications.redeploy).not.toHaveBeenCalled();
  });
});

describe('findAll', () => {
  it('with applicationId: 404s on unknown app', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue(null);
    await expect(service.findAll('u1', 'a1')).rejects.toThrow(NotFoundException);
  });

  it('with applicationId: requires VIEWER and scopes the query to that app (take 50, desc)', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p1' });

    await service.findAll('u1', 'a1');

    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'VIEWER');
    const arg = prisma.deployment.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ applicationId: 'a1' });
    expect(arg.take).toBe(50);
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('without applicationId: returns [] when the user has no accessible projects (no query)', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue([]);

    expect(await service.findAll('u1')).toEqual([]);
    expect(prisma.deployment.findMany).not.toHaveBeenCalled();
  });

  it('without applicationId: scopes to accessible projects', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue(['p1', 'p2']);

    await service.findAll('u1');

    const arg = prisma.deployment.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ application: { projectId: { in: ['p1', 'p2'] } } });
  });
});

describe('findOne', () => {
  it('404s on a missing deployment', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.findUnique.mockResolvedValue(null);
    await expect(service.findOne('u1', 'dep-x')).rejects.toThrow(NotFoundException);
  });

  it('enforces VIEWER on the deployment\'s owning project', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.findUnique.mockResolvedValue({
      id: 'dep-1',
      application: { projectId: 'p1' },
    });

    const res = await service.findOne('u1', 'dep-1');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'VIEWER');
    expect(res.id).toBe('dep-1');
  });
});

describe('pruneOldDeployments', () => {
  it('age-prunes non-active rows older than the configured retention window', async () => {
    const { service, prisma, systemConfig } = makeService();
    systemConfig.getNumber.mockReturnValue(30);

    await service.pruneOldDeployments();

    const arg = prisma.deployment.deleteMany.mock.calls[0][0];
    expect(arg.where.status.notIn).toEqual(['PENDING', 'BUILDING', 'DEPLOYING']);
    expect(arg.where.createdAt.lt).toBeInstanceOf(Date);
    // ~30 days back from now.
    const ageMs = Date.now() - arg.where.createdAt.lt.getTime();
    expect(ageMs).toBeGreaterThan(29 * 864e5);
    expect(ageMs).toBeLessThan(31 * 864e5);
  });

  it('falls back to 90 days when retention config is non-positive / non-finite', async () => {
    const { service, prisma, systemConfig } = makeService();
    systemConfig.getNumber.mockReturnValue(0);

    await service.pruneOldDeployments();

    const arg = prisma.deployment.deleteMany.mock.calls[0][0];
    const ageMs = Date.now() - arg.where.createdAt.lt.getTime();
    expect(ageMs).toBeGreaterThan(89 * 864e5);
    expect(ageMs).toBeLessThan(91 * 864e5);
  });

  it('per-app cap: keeps the newest 50 and deletes the rest (only over-cap apps)', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.groupBy.mockResolvedValue([
      { applicationId: 'over', _count: { _all: 55 } },
      { applicationId: 'under', _count: { _all: 10 } },
    ]);
    prisma.deployment.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({ id: `k${i}` })),
    );
    prisma.deployment.deleteMany.mockResolvedValue({ count: 5 });

    await service.pruneOldDeployments();

    // Only the over-cap app triggers a findMany(take:50) + a scoped deleteMany.
    expect(prisma.deployment.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.deployment.findMany.mock.calls[0][0]).toMatchObject({
      where: { applicationId: 'over' },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
    const capDelete = prisma.deployment.deleteMany.mock.calls[1][0];
    expect(capDelete.where.applicationId).toBe('over');
    expect(capDelete.where.id.notIn).toHaveLength(50);
    expect(capDelete.where.status.notIn).toEqual(['PENDING', 'BUILDING', 'DEPLOYING']);
  });

  it('never throws — a prune failure is swallowed and logged', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.deleteMany.mockRejectedValue(new Error('db down'));
    await expect(service.pruneOldDeployments()).resolves.toBeUndefined();
  });
});
