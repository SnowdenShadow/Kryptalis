import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  ROLE_RANK,
  hasRole,
  getProjectRole,
  assertProjectAccess,
  listAccessibleProjectIds,
} from './project-access';

/**
 * Pure service-level tests: PrismaService is a plain object of vi.fn()s
 * returning fixtures — no DB, no TestingModule.
 */
function makePrisma() {
  return {
    user: { findUnique: vi.fn() },
    projectMember: { findUnique: vi.fn(), findMany: vi.fn() },
    project: { findUnique: vi.fn(), findMany: vi.fn() },
  };
}

type PrismaMock = ReturnType<typeof makePrisma>;
const asPrisma = (p: PrismaMock) => p as any;

describe('ROLE_RANK / hasRole', () => {
  it('enforces the exact hierarchy OWNER > ADMIN > DEVELOPER > VIEWER', () => {
    expect(ROLE_RANK.OWNER).toBeGreaterThan(ROLE_RANK.ADMIN);
    expect(ROLE_RANK.ADMIN).toBeGreaterThan(ROLE_RANK.DEVELOPER);
    expect(ROLE_RANK.DEVELOPER).toBeGreaterThan(ROLE_RANK.VIEWER);
  });

  it('hasRole passes when role is equal to or above the minimum', () => {
    expect(hasRole('OWNER', 'OWNER')).toBe(true);
    expect(hasRole('OWNER', 'VIEWER')).toBe(true);
    expect(hasRole('ADMIN', 'DEVELOPER')).toBe(true);
    expect(hasRole('DEVELOPER', 'DEVELOPER')).toBe(true);
    expect(hasRole('VIEWER', 'VIEWER')).toBe(true);
  });

  it('hasRole fails for every role strictly below the minimum', () => {
    expect(hasRole('ADMIN', 'OWNER')).toBe(false);
    expect(hasRole('DEVELOPER', 'ADMIN')).toBe(false);
    expect(hasRole('VIEWER', 'DEVELOPER')).toBe(false);
    expect(hasRole('VIEWER', 'OWNER')).toBe(false);
  });
});

describe('getProjectRole', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('returns the explicit membership role when the user is a member', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'DEVELOPER' });
    const role = await getProjectRole(asPrisma(prisma), 'u1', 'p1');
    expect(role).toBe('DEVELOPER');
    // Short-circuits before touching project/user tables.
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('membership shadows the platform-admin bypass (global ADMIN with VIEWER membership stays VIEWER)', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'VIEWER' });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    const role = await getProjectRole(asPrisma(prisma), 'admin-user', 'p1');
    expect(role).toBe('VIEWER');
  });

  it('legacy owner path: project without membership but owned via userId → OWNER', async () => {
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue({ userId: 'u1' });
    const role = await getProjectRole(asPrisma(prisma), 'u1', 'p1');
    expect(role).toBe('OWNER');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the project does not exist (before any admin bypass)', async () => {
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue(null);
    await expect(getProjectRole(asPrisma(prisma), 'u1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('platform ADMIN gets implicit OWNER on a project they are not a member of', async () => {
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue({ userId: 'someone-else' });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(getProjectRole(asPrisma(prisma), 'admin', 'p1')).resolves.toBe('OWNER');
  });

  it('platform SUPERADMIN gets implicit OWNER on a project they are not a member of', async () => {
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue({ userId: 'someone-else' });
    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    await expect(getProjectRole(asPrisma(prisma), 'root', 'p1')).resolves.toBe('OWNER');
  });

  it('throws ForbiddenException for a regular non-member', async () => {
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue({ userId: 'someone-else' });
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    await expect(getProjectRole(asPrisma(prisma), 'stranger', 'p1')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('assertProjectAccess', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('returns the role when it meets the minimum', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(
      assertProjectAccess(asPrisma(prisma), 'u1', 'p1', 'DEVELOPER'),
    ).resolves.toBe('ADMIN');
  });

  it('defaults the minimum to VIEWER', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'VIEWER' });
    await expect(assertProjectAccess(asPrisma(prisma), 'u1', 'p1')).resolves.toBe('VIEWER');
  });

  it('throws ForbiddenException with an explicit message when the role is below the minimum', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'DEVELOPER' });
    await expect(
      assertProjectAccess(asPrisma(prisma), 'u1', 'p1', 'ADMIN'),
    ).rejects.toThrow('Requires role >= ADMIN, you are DEVELOPER');
  });

  it('platform admin (implicit OWNER) passes even an OWNER-minimum check', async () => {
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.project.findUnique.mockResolvedValue({ userId: 'someone-else' });
    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    await expect(
      assertProjectAccess(asPrisma(prisma), 'root', 'p1', 'OWNER'),
    ).resolves.toBe('OWNER');
  });
});

describe('listAccessibleProjectIds', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('platform admin sees every project', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.project.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const ids = await listAccessibleProjectIds(asPrisma(prisma), 'admin');
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
  });

  it('regular user gets memberships + owned projects merged without duplicates', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.projectMember.findMany.mockResolvedValue([
      { projectId: 'p1' },
      { projectId: 'p2' },
    ]);
    // p2 both owned AND membership → must appear exactly once.
    prisma.project.findMany.mockResolvedValue([{ id: 'p2' }, { id: 'p3' }]);
    const ids = await listAccessibleProjectIds(asPrisma(prisma), 'u1');
    expect([...ids].sort()).toEqual(['p1', 'p2', 'p3']);
    expect(ids).toHaveLength(3);
  });

  it('returns an empty list for a user with no memberships and no owned projects', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.projectMember.findMany.mockResolvedValue([]);
    prisma.project.findMany.mockResolvedValue([]);
    await expect(listAccessibleProjectIds(asPrisma(prisma), 'u1')).resolves.toEqual([]);
  });
});
