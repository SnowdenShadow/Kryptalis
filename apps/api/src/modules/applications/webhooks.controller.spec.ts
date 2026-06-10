import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { timingSafeStrEq } from './webhooks.controller';

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
