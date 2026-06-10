/**
 * Pure registration-policy helpers (unit-testable, no Nest/Prisma deps).
 *
 * `default_user_role` (SystemSetting) picks the role granted to every
 * non-bootstrap signup. Only low-privilege roles are allowed — an admin
 * typo (or a tampered DB row) must never mint ADMIN/SUPERADMIN accounts
 * on public registration.
 */

export const ALLOWED_DEFAULT_ROLES = ['USER', 'VIEWER'] as const;
export type DefaultRole = (typeof ALLOWED_DEFAULT_ROLES)[number];

export function resolveDefaultRole(raw: unknown): DefaultRole {
  if (typeof raw === 'string') {
    const candidate = raw.trim().toUpperCase();
    if ((ALLOWED_DEFAULT_ROLES as readonly string[]).includes(candidate)) {
      return candidate as DefaultRole;
    }
  }
  return 'USER';
}
