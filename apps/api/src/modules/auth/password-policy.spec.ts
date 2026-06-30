import { describe, it, expect } from 'vitest';
import { checkPasswordStrength, PASSWORD_MIN_LENGTH } from './password-policy';

describe('checkPasswordStrength (single shared policy)', () => {
  it('rejects empty / non-string', () => {
    expect(checkPasswordStrength('').ok).toBe(false);
    expect(checkPasswordStrength(undefined).ok).toBe(false);
    expect(checkPasswordStrength(null).ok).toBe(false);
    expect(checkPasswordStrength(12345678 as any).ok).toBe(false);
  });

  it(`rejects shorter than ${PASSWORD_MIN_LENGTH} chars (the admin-reset 8-char hole)`, () => {
    // 8-char, 3-class password that the old admin DTO (@MinLength(8)) accepted.
    const r = checkPasswordStrength('Ab3!xyzQ');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/at least 12/i);
  });

  it('rejects when fewer than 3 character classes are present', () => {
    expect(checkPasswordStrength('alllowercaseletters').ok).toBe(false); // 1 class, long
    expect(checkPasswordStrength('lowercaseUPPERCASE').ok).toBe(false); // 2 classes
  });

  it('rejects longer than 128 chars', () => {
    expect(checkPasswordStrength('Aa1!'.repeat(40)).ok).toBe(false); // 160 chars
  });

  it('accepts a 12+ char password with 3+ classes', () => {
    expect(checkPasswordStrength('Abcdef123!xyz').ok).toBe(true);
    expect(checkPasswordStrength('correct horse Battery 9').ok).toBe(true);
  });
});
