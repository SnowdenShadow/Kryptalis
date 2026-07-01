import { describe, it, expect } from 'vitest';
import {
  RESOURCES,
  ALL_PERMISSIONS,
  isKnownPermission,
  sanitizePermissions,
  permissionsForRole,
  rankAllows,
  BUILTIN_ROLE_PERMISSIONS,
} from './permissions';

describe('permission catalog', () => {
  it('ALL_PERMISSIONS is the flat resource:action product with no dupes', () => {
    const expected = Object.entries(RESOURCES).reduce((n, [, acts]) => n + acts.length, 0);
    expect(ALL_PERMISSIONS.length).toBe(expected);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    // Every entry is a "resource:action" pair.
    for (const p of ALL_PERMISSIONS) expect(p).toMatch(/^[a-z]+:[a-z]+$/);
  });

  it('isKnownPermission accepts catalog entries and rejects junk', () => {
    expect(isKnownPermission('apps:deploy')).toBe(true);
    expect(isKnownPermission('databases:manage')).toBe(true);
    expect(isKnownPermission('apps:nuke')).toBe(false);
    expect(isKnownPermission('project:delete')).toBe(false); // OWNER-only, not grantable
    expect(isKnownPermission('')).toBe(false);
  });

  it('sanitizePermissions drops unknowns + non-strings and dedupes', () => {
    const out = sanitizePermissions([
      'apps:view', 'apps:view', 'apps:deploy', 'bogus:x', 42, null, 'project:delete',
    ]);
    expect(out.sort()).toEqual(['apps:deploy', 'apps:view']);
  });

  it('sanitizePermissions handles non-array input', () => {
    expect(sanitizePermissions(undefined)).toEqual([]);
    expect(sanitizePermissions('apps:view')).toEqual([]);
  });
});

describe('built-in role → permissions', () => {
  it('VIEWER can only view (every perm ends with :view)', () => {
    const v = permissionsForRole('VIEWER');
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((p) => p.endsWith(':view'))).toBe(true);
  });

  it('DEVELOPER can deploy + manage resources but the set is a subset of ADMIN', () => {
    const dev = new Set(permissionsForRole('DEVELOPER'));
    expect(dev.has('apps:deploy')).toBe(true);
    expect(dev.has('databases:manage')).toBe(true);
    expect(dev.has('domains:manage')).toBe(true);
    const admin = new Set(permissionsForRole('ADMIN'));
    for (const p of dev) expect(admin.has(p)).toBe(true);
  });

  it('ADMIN and OWNER hold every fine-grained permission', () => {
    expect(new Set(permissionsForRole('ADMIN'))).toEqual(new Set(ALL_PERMISSIONS));
    expect(new Set(permissionsForRole('OWNER'))).toEqual(new Set(ALL_PERMISSIONS));
  });

  it('VIEWER ⊂ DEVELOPER ⊂ ADMIN (monotonic)', () => {
    const v = new Set(BUILTIN_ROLE_PERMISSIONS.VIEWER);
    const d = new Set(BUILTIN_ROLE_PERMISSIONS.DEVELOPER);
    for (const p of v) expect(d.has(p)).toBe(true);
  });
});

describe('rankAllows (non-delegable admin capabilities)', () => {
  it('project:delete + transfer are OWNER-only', () => {
    expect(rankAllows('OWNER', 'project:delete')).toBe(true);
    expect(rankAllows('ADMIN', 'project:delete')).toBe(false);
    expect(rankAllows('OWNER', 'project:transfer')).toBe(true);
    expect(rankAllows('DEVELOPER', 'project:transfer')).toBe(false);
  });

  it('members/roles/settings are ADMIN+', () => {
    expect(rankAllows('ADMIN', 'members:manage')).toBe(true);
    expect(rankAllows('OWNER', 'roles:manage')).toBe(true);
    expect(rankAllows('DEVELOPER', 'members:manage')).toBe(false);
    expect(rankAllows('VIEWER', 'project:settings')).toBe(false);
  });

  it('an unknown capability is never allowed by rank', () => {
    expect(rankAllows('OWNER', 'whatever:x')).toBe(false);
  });
});
