import type { ProjectRole } from '@prisma/client';
import { ROLE_RANK } from './project-access';

/**
 * Fine-grained permission catalog for per-project custom roles.
 *
 * A permission is a `resource:action` string. The 4 built-in ProjectRoles
 * (OWNER/ADMIN/DEVELOPER/VIEWER) are expressed here as concrete permission
 * sets, so the whole system has ONE source of truth: a built-in role and a
 * custom role are both just "a set of permissions". Custom roles pick any
 * subset; the effective set is what the RBAC layer checks.
 *
 * Design rules:
 * - `view` on a resource = read (list/detail/logs/metrics).
 * - `manage` (or finer verbs) = mutate. Finer verbs (deploy, restart…) let a
 *   custom role grant "can deploy but not delete", etc.
 * - Some capabilities are OWNER-only and NOT delegable via custom roles
 *   (delete the project, transfer ownership, manage members, edit roles). Those
 *   live in OWNER_ONLY and are never part of a custom role's grantable set.
 */

// ── Resources & their actions ──────────────────────────────────────────────

export const RESOURCES = {
  apps: ['view', 'create', 'deploy', 'restart', 'delete', 'env', 'exec', 'logs'],
  databases: ['view', 'create', 'manage', 'delete'],
  domains: ['view', 'manage', 'delete'],
  backups: ['view', 'create', 'restore', 'delete'],
  files: ['view', 'manage'],
  sftp: ['view', 'manage'],
  monitoring: ['view'],
  email: ['view', 'manage'],
  marketplace: ['install'],
  deployments: ['view'],
} as const;

export type Resource = keyof typeof RESOURCES;

/** Every valid `resource:action` permission string. */
export type Permission = string; // narrowed at runtime by isKnownPermission

/** Flat list of every permission a custom role may grant. */
export const ALL_PERMISSIONS: string[] = Object.entries(RESOURCES).flatMap(
  ([resource, actions]) => (actions as readonly string[]).map((a) => `${resource}:${a}`),
);

const ALL_PERMISSION_SET = new Set(ALL_PERMISSIONS);

export function isKnownPermission(p: string): boolean {
  return ALL_PERMISSION_SET.has(p);
}

/** Keep only the valid permission strings from an arbitrary input list. */
export function sanitizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const p of input) {
    if (typeof p === 'string' && ALL_PERMISSION_SET.has(p)) seen.add(p);
  }
  return [...seen];
}

// ── Capabilities that are NEVER delegable to a custom role ──────────────────
// These stay gated by the built-in role rank (ADMIN/OWNER), independent of the
// fine-grained grid — a custom role can't grant "delete the whole project".

export const OWNER_ONLY = ['project:delete', 'project:transfer'] as const;
export const ADMIN_CAPS = ['members:manage', 'roles:manage', 'project:settings'] as const;

// ── Built-in role → permission set ──────────────────────────────────────────

/** VIEWER: read everything, mutate nothing. */
const VIEWER_PERMS = ALL_PERMISSIONS.filter((p) => p.endsWith(':view'));

/**
 * DEVELOPER: full control of the day-to-day build/ship surface (apps, domains,
 * databases, files, sftp, marketplace installs, backups) but NOT member/role
 * administration or project deletion.
 */
const DEVELOPER_PERMS = [
  'apps:view', 'apps:create', 'apps:deploy', 'apps:restart', 'apps:delete', 'apps:env', 'apps:exec', 'apps:logs',
  'databases:view', 'databases:create', 'databases:manage', 'databases:delete',
  'domains:view', 'domains:manage', 'domains:delete',
  'backups:view', 'backups:create', 'backups:restore', 'backups:delete',
  'files:view', 'files:manage',
  'sftp:view', 'sftp:manage',
  'monitoring:view',
  'email:view', 'email:manage',
  'marketplace:install',
  'deployments:view',
];

/** ADMIN & OWNER: every fine-grained permission (member/role admin handled
 *  separately via the role rank, see hasCapability). */
const ADMIN_PERMS = [...ALL_PERMISSIONS];

export const BUILTIN_ROLE_PERMISSIONS: Record<ProjectRole, string[]> = {
  OWNER: ADMIN_PERMS,
  ADMIN: ADMIN_PERMS,
  DEVELOPER: DEVELOPER_PERMS,
  VIEWER: VIEWER_PERMS,
};

/**
 * The permission set a built-in role grants. Used both to seed a custom role
 * from a preset and to resolve a member who has no custom role.
 */
export function permissionsForRole(role: ProjectRole): string[] {
  return BUILTIN_ROLE_PERMISSIONS[role] ?? [];
}

// ── Capability checks that stay rank-based (not custom-role delegable) ───────

/**
 * OWNER-only / ADMIN-only capabilities are gated by the built-in role RANK of
 * the member (a custom role always carries a baseRole for exactly this). A
 * custom role can raise a member's fine-grained grants but never their
 * administrative rank above its baseRole.
 */
export function rankAllows(role: ProjectRole, cap: string): boolean {
  if ((OWNER_ONLY as readonly string[]).includes(cap)) {
    return ROLE_RANK[role] >= ROLE_RANK.OWNER;
  }
  if ((ADMIN_CAPS as readonly string[]).includes(cap)) {
    return ROLE_RANK[role] >= ROLE_RANK.ADMIN;
  }
  return false;
}
