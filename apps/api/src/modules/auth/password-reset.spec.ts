import { describe, it, expect } from 'vitest';
import {
  PASSWORD_RESET_TTL_MS,
  passwordResetExpiry,
  isResetTokenUsable,
} from './password-reset';

describe('password-reset policy', () => {
  const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);

  it('mints expiries exactly 1 hour out', () => {
    expect(PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);
    expect(passwordResetExpiry(NOW).getTime()).toBe(NOW + 60 * 60 * 1000);
  });

  it('accepts an unused, unexpired token', () => {
    const row = { usedAt: null, expiresAt: new Date(NOW + 1000) };
    expect(isResetTokenUsable(row, new Date(NOW))).toBe(true);
  });

  it('rejects missing rows', () => {
    expect(isResetTokenUsable(null)).toBe(false);
    expect(isResetTokenUsable(undefined)).toBe(false);
  });

  it('rejects consumed tokens (single use)', () => {
    const row = { usedAt: new Date(NOW - 1000), expiresAt: new Date(NOW + 60_000) };
    expect(isResetTokenUsable(row, new Date(NOW))).toBe(false);
  });

  it('rejects expired tokens, including the exact expiry instant', () => {
    expect(
      isResetTokenUsable({ usedAt: null, expiresAt: new Date(NOW - 1) }, new Date(NOW)),
    ).toBe(false);
    // boundary: expiresAt === now → no longer usable
    expect(
      isResetTokenUsable({ usedAt: null, expiresAt: new Date(NOW) }, new Date(NOW)),
    ).toBe(false);
  });

  it('a freshly minted token is usable until (but not at) now + TTL', () => {
    const expiresAt = passwordResetExpiry(NOW);
    expect(isResetTokenUsable({ usedAt: null, expiresAt }, new Date(NOW))).toBe(true);
    expect(
      isResetTokenUsable({ usedAt: null, expiresAt }, new Date(NOW + PASSWORD_RESET_TTL_MS - 1)),
    ).toBe(true);
    expect(
      isResetTokenUsable({ usedAt: null, expiresAt }, new Date(NOW + PASSWORD_RESET_TTL_MS)),
    ).toBe(false);
  });
});
