/**
 * The ONE password-strength policy for the whole platform.
 *
 * Every write path that sets a user password — self-registration,
 * changePassword, resetPassword, AND the admin-driven reset — must run the
 * same check, or the weakest path silently defines the real policy. Previously
 * the admin reset (admin.service.ts) only enforced `@MinLength(8)` on its DTO,
 * letting an admin set an 8-char password that every other path would reject.
 *
 * Kept as a pure function (no Nest deps) so it can be shared across services
 * and unit-tested in isolation, mirroring registration-policy.ts /
 * password-reset.ts.
 */
export interface PasswordStrength {
  ok: boolean;
  reason?: string;
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MIN_CLASSES = 3;

export function checkPasswordStrength(pw: unknown): PasswordStrength {
  if (!pw || typeof pw !== 'string') {
    return { ok: false, reason: 'Password is required.' };
  }
  if (pw.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.` };
  }
  if (pw.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, reason: `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.` };
  }
  const classes = [
    /[a-z]/.test(pw),
    /[A-Z]/.test(pw),
    /[0-9]/.test(pw),
    /[^A-Za-z0-9]/.test(pw),
  ].filter(Boolean).length;
  if (classes < PASSWORD_MIN_CLASSES) {
    return {
      ok: false,
      reason:
        'Password must contain at least 3 of: lowercase letter, uppercase letter, digit, symbol.',
    };
  }
  return { ok: true };
}
