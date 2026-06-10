import { describe, it, expect } from 'vitest';
import { resolveDefaultRole } from './registration-policy';

describe('resolveDefaultRole (default_user_role setting)', () => {
  it('accepts the two allowed roles, case/whitespace-insensitively', () => {
    expect(resolveDefaultRole('USER')).toBe('USER');
    expect(resolveDefaultRole('VIEWER')).toBe('VIEWER');
    expect(resolveDefaultRole('viewer')).toBe('VIEWER');
    expect(resolveDefaultRole('  user  ')).toBe('USER');
  });

  it('never grants privileged roles from a tampered/typo setting', () => {
    expect(resolveDefaultRole('ADMIN')).toBe('USER');
    expect(resolveDefaultRole('SUPERADMIN')).toBe('USER');
    expect(resolveDefaultRole('superadmin')).toBe('USER');
  });

  it('falls back to USER for unset / non-string values', () => {
    expect(resolveDefaultRole(undefined)).toBe('USER');
    expect(resolveDefaultRole(null)).toBe('USER');
    expect(resolveDefaultRole(42)).toBe('USER');
    expect(resolveDefaultRole({})).toBe('USER');
    expect(resolveDefaultRole('')).toBe('USER');
    expect(resolveDefaultRole('GUEST')).toBe('USER');
  });
});
