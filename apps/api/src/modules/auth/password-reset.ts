/**
 * Pure password-reset token policy, extracted from AuthService so the
 * expiry / single-use rules are unit-testable without Prisma or Nest.
 *
 * The tokens themselves are 32 random bytes, stored ONLY as sha256 hashes
 * (see EncryptionService.hash) in the password_reset_tokens table.
 */

/** Reset links live for 1 hour, single use. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Expiry timestamp for a token minted "now". */
export function passwordResetExpiry(now: number = Date.now()): Date {
  return new Date(now + PASSWORD_RESET_TTL_MS);
}

/**
 * A stored token row is usable iff it exists, was never consumed and has
 * not expired. Centralised so forgot/reset flows can't drift apart.
 */
export function isResetTokenUsable(
  row: { usedAt: Date | null; expiresAt: Date } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!row) return false;
  if (row.usedAt) return false;
  return row.expiresAt.getTime() > now.getTime();
}
