import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
  timingSafeStrEq,
  refToBranch,
  extractPushBranch,
  isReplay,
} from './webhooks.controller';

describe('timingSafeStrEq', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeStrEq('sha256=abc123', 'sha256=abc123')).toBe(true);
    expect(timingSafeStrEq('', '')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeStrEq('aaaa', 'aaab')).toBe(false);
  });

  it('returns false for different lengths without throwing', () => {
    expect(timingSafeStrEq('short', 'much-longer-string')).toBe(false);
    expect(timingSafeStrEq('x', '')).toBe(false);
  });
});

describe('refToBranch', () => {
  it('strips refs/heads/ prefix to the bare branch name', () => {
    expect(refToBranch('refs/heads/main')).toBe('main');
    expect(refToBranch('refs/heads/feature/x')).toBe('feature/x');
  });

  it('returns undefined for tag refs (a tag is not a branch)', () => {
    // Regression: a tag 'refs/tags/main' must NOT resolve to branch 'main'.
    expect(refToBranch('refs/tags/main')).toBeUndefined();
    expect(refToBranch('refs/tags/v1.0.0')).toBeUndefined();
  });

  it('returns undefined for other ref namespaces and missing ref', () => {
    expect(refToBranch('refs/remotes/origin/main')).toBeUndefined();
    expect(refToBranch(undefined)).toBeUndefined();
  });

  it('passes through a bare branch name', () => {
    expect(refToBranch('main')).toBe('main');
  });
});

describe('extractPushBranch', () => {
  it('reads GitHub/GitLab branch from top-level ref', () => {
    expect(extractPushBranch({ ref: 'refs/heads/main' })).toBe('main');
  });

  it('reads Bitbucket branch from push.changes[].new.name', () => {
    const body = {
      push: { changes: [{ new: { type: 'branch', name: 'develop' } }] },
    };
    expect(extractPushBranch(body)).toBe('develop');
  });

  it('ignores Bitbucket tag changes (new.type !== branch)', () => {
    const body = {
      push: { changes: [{ new: { type: 'tag', name: 'v1' } }] },
    };
    expect(extractPushBranch(body)).toBeUndefined();
  });

  it('returns undefined for a GitHub tag push', () => {
    expect(extractPushBranch({ ref: 'refs/tags/v1' })).toBeUndefined();
  });

  it('returns undefined when no branch info present', () => {
    expect(extractPushBranch({})).toBeUndefined();
    expect(extractPushBranch({ push: { changes: [] } })).toBeUndefined();
  });
});

describe('isReplay (in-memory delivery dedup)', () => {
  it('returns false the first time and true on replay of the same id', () => {
    const id = `test-${Math.random()}`;
    expect(isReplay(id)).toBe(false);
    expect(isReplay(id)).toBe(true);
  });

  it('treats distinct ids independently', () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    expect(isReplay(a)).toBe(false);
    expect(isReplay(b)).toBe(false);
  });

  it('skips dedup when no delivery id is present (does not break delivery)', () => {
    expect(isReplay(undefined)).toBe(false);
    expect(isReplay(undefined)).toBe(false);
  });
});
