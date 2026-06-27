import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

vi.mock('./applications.helpers', () => ({
  execFileAsync: vi.fn(),
  slugify: (s: string) => s.toLowerCase(),
  containerName: (s: string) => `dockcontrol-${s}`,
  resolveContainerName: vi.fn(),
  remoteAppSlug: vi.fn(),
  resolveAppDir: vi.fn(),
  dockerCompose: vi.fn(),
  findComposePath: vi.fn(),
  resolveAppServer: vi.fn(),
  isAppLocal: vi.fn(() => true),
  assertAppOwnership: vi.fn(),
  projectNetworkName: vi.fn(),
  imageName: vi.fn(),
  removeCollidingContainers: vi.fn(),
  parseDockerfileExposed: vi.fn(),
  APPS_DIR: '/tmp/apps',
}));

import { ApplicationOpsService } from './application-ops.service';

function makeService(deploymentMock: any) {
  const prisma = { deployment: deploymentMock } as any;
  const svc = new ApplicationOpsService(
    prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { svc, prisma };
}

// P2002 = Prisma unique-constraint violation (our partial inflight index).
function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
  });
}

beforeEach(() => vi.clearAllMocks());

describe('createInflightDeployment — DB-race → friendly 409', () => {
  it('returns the created row on success', async () => {
    const { svc } = makeService({ create: vi.fn().mockResolvedValue({ id: 'dep1' }) });
    const row = await (svc as any).createInflightDeployment({
      applicationId: 'a', status: 'PENDING', triggeredById: 'u',
    });
    expect(row.id).toBe('dep1');
  });

  it('maps a Prisma P2002 unique violation to ConflictException (not a raw 500)', async () => {
    const { svc } = makeService({ create: vi.fn().mockRejectedValue(p2002()) });
    await expect(
      (svc as any).createInflightDeployment({ applicationId: 'a', status: 'PENDING', triggeredById: 'u' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rethrows non-P2002 errors unchanged', async () => {
    const boom = new Error('connection reset');
    const { svc } = makeService({ create: vi.fn().mockRejectedValue(boom) });
    await expect(
      (svc as any).createInflightDeployment({ applicationId: 'a', status: 'PENDING', triggeredById: 'u' }),
    ).rejects.toBe(boom);
  });
});

describe('onModuleInit — orphaned-inflight reconcile', () => {
  it('fails in-flight deployments older than the threshold so the unique index cannot wedge an app', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const { svc } = makeService({ updateMany });
    // The guard returns early in NODE_ENV=test; force the reconcile path.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await svc.onModuleInit();
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where.status.in).toEqual(['PENDING', 'BUILDING', 'DEPLOYING']);
    expect(arg.where.createdAt.lt).toBeInstanceOf(Date);
    expect(arg.data.status).toBe('FAILED');
  });

  it('does NOT run the reconcile in test mode (no stray DB writes)', async () => {
    const updateMany = vi.fn();
    const { svc } = makeService({ updateMany });
    await svc.onModuleInit(); // NODE_ENV is 'test' under vitest
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('never throws if the reconcile query fails (must not block startup)', async () => {
    const updateMany = vi.fn().mockRejectedValue(new Error('db down'));
    const { svc } = makeService({ updateMany });
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
