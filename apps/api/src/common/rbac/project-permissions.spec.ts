import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';

// Only stub getProjectRole — keep the real ROLE_RANK/hasRole exports, which
// permissions.ts (rankAllows) depends on transitively.
vi.mock('./project-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./project-access')>();
  return { ...actual, getProjectRole: vi.fn() };
});

import { getProjectRole } from './project-access';
import {
  effectiveAccess,
  assertPermission,
  assertCapability,
  listEffectivePermissions,
} from './project-permissions';
import { permissionsForRole } from './permissions';

const mockRole = vi.mocked(getProjectRole);

function makePrisma() {
  return {
    projectMember: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}
const asPrisma = (p: any) => p as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('effectiveAccess', () => {
  it('OWNER holds every permission and isAdmin (custom role ignored)', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('OWNER' as any);
    const acc = await effectiveAccess(asPrisma(prisma), 'u1', 'p1');
    expect(acc.isAdmin).toBe(true);
    expect(acc.permissions.has('apps:delete')).toBe(true);
    expect(acc.permissions.has('databases:manage')).toBe(true);
    // Never bothers looking up a custom role for an admin.
    expect(prisma.projectMember.findUnique).not.toHaveBeenCalled();
  });

  it('ADMIN also holds every permission by rank', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('ADMIN' as any);
    const acc = await effectiveAccess(asPrisma(prisma), 'u1', 'p1');
    expect(acc.isAdmin).toBe(true);
    expect(acc.permissions.size).toBe(permissionsForRole('ADMIN').length);
  });

  it('DEVELOPER with NO custom role gets the DEVELOPER preset', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('DEVELOPER' as any);
    prisma.projectMember.findUnique.mockResolvedValue({ customRole: null });
    const acc = await effectiveAccess(asPrisma(prisma), 'u1', 'p1');
    expect(acc.isAdmin).toBe(false);
    expect(acc.permissions.has('apps:deploy')).toBe(true);
    expect(acc.permissions.has('members:manage')).toBe(false); // not a fine-grained perm
  });

  it('a custom role OVERRIDES the preset for a below-admin member', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('DEVELOPER' as any);
    prisma.projectMember.findUnique.mockResolvedValue({
      customRole: { baseRole: 'DEVELOPER', permissions: ['databases:view', 'databases:manage', 'bogus:x'] },
    });
    const acc = await effectiveAccess(asPrisma(prisma), 'u1', 'p1');
    // Only the sanitized custom perms — NOT the DEVELOPER preset's apps:deploy.
    expect(acc.permissions.has('databases:manage')).toBe(true);
    expect(acc.permissions.has('apps:deploy')).toBe(false);
    expect(acc.permissions.has('bogus:x')).toBe(false); // junk dropped
  });
});

describe('assertPermission', () => {
  it('admin passes unconditionally', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('ADMIN' as any);
    await expect(assertPermission(asPrisma(prisma), 'u1', 'p1', 'apps:delete')).resolves.toBeDefined();
  });

  it('a member WITHOUT the permission is refused', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('VIEWER' as any);
    prisma.projectMember.findUnique.mockResolvedValue({ customRole: null });
    await expect(assertPermission(asPrisma(prisma), 'u1', 'p1', 'apps:deploy')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a member WITH the custom permission passes', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('VIEWER' as any);
    prisma.projectMember.findUnique.mockResolvedValue({
      customRole: { baseRole: 'VIEWER', permissions: ['apps:view', 'apps:deploy'] },
    });
    await expect(assertPermission(asPrisma(prisma), 'u1', 'p1', 'apps:deploy')).resolves.toBeDefined();
  });
});

describe('assertCapability (rank-gated, non-delegable)', () => {
  it('members:manage needs ADMIN rank — a custom DEVELOPER cannot get it', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('DEVELOPER' as any);
    await expect(assertCapability(asPrisma(prisma), 'u1', 'p1', 'members:manage')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('project:delete needs OWNER', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('ADMIN' as any);
    await expect(assertCapability(asPrisma(prisma), 'u1', 'p1', 'project:delete')).rejects.toThrow(
      ForbiddenException,
    );
    mockRole.mockResolvedValue('OWNER' as any);
    await expect(assertCapability(asPrisma(prisma), 'u1', 'p1', 'project:delete')).resolves.toBe('OWNER');
  });
});

describe('listEffectivePermissions', () => {
  it('returns a sorted permission list + role + isAdmin', async () => {
    const prisma = makePrisma();
    mockRole.mockResolvedValue('VIEWER' as any);
    prisma.projectMember.findUnique.mockResolvedValue({
      customRole: { baseRole: 'VIEWER', permissions: ['databases:view', 'apps:view'] },
    });
    const res = await listEffectivePermissions(asPrisma(prisma), 'u1', 'p1');
    expect(res.role).toBe('VIEWER');
    expect(res.isAdmin).toBe(false);
    expect(res.permissions).toEqual(['apps:view', 'databases:view']);
  });
});
