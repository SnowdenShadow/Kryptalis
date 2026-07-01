import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ProjectRole } from '@prisma/client';
import { getProjectRole } from './project-access';
import {
  permissionsForRole,
  sanitizePermissions,
  rankAllows,
} from './permissions';

/**
 * Fine-grained permission resolution, layered on top of getProjectRole().
 *
 * Effective permissions for a (user, project):
 *   1. Resolve the member's built-in ProjectRole (getProjectRole) — this
 *      already honours the legacy-owner pointer + platform-admin bypass.
 *   2. OWNER/ADMIN (by rank) always hold EVERY permission — full stop. This
 *      keeps platform admins and project owners omnipotent regardless of any
 *      custom-role grid, and means a custom role only ever MATTERS for members
 *      below ADMIN.
 *   3. Otherwise, if the member has a custom role, its sanitized permission
 *      grid is the effective set. If not, the built-in role's preset set is.
 *
 * `role` is the administrative RANK (used for members/roles/project-delete via
 * rankAllows); `permissions` is the fine-grained set (used by assertPermission).
 */
export interface EffectiveAccess {
  role: ProjectRole;
  permissions: Set<string>;
  /** true when the caller is OWNER/ADMIN by rank (holds every permission). */
  isAdmin: boolean;
}

export async function effectiveAccess(
  prisma: PrismaService,
  userId: string,
  projectId: string,
): Promise<EffectiveAccess> {
  const role = await getProjectRole(prisma, userId, projectId);

  // ADMIN/OWNER by rank ⇒ everything. permissionsForRole('ADMIN') is the full
  // catalog, so this is a superset of any custom grid.
  if (role === 'OWNER' || role === 'ADMIN') {
    return { role, permissions: new Set(permissionsForRole(role)), isAdmin: true };
  }

  // Below ADMIN: a custom role (if assigned) overrides the preset grid.
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: {
      customRole: { select: { permissions: true, baseRole: true } },
    },
  });

  if (member?.customRole) {
    const perms = sanitizePermissions(member.customRole.permissions);
    return { role, permissions: new Set(perms), isAdmin: false };
  }

  return { role, permissions: new Set(permissionsForRole(role)), isAdmin: false };
}

/** Effective permission list (sorted) — for the /my-permissions endpoint. */
export async function listEffectivePermissions(
  prisma: PrismaService,
  userId: string,
  projectId: string,
): Promise<{ role: ProjectRole; isAdmin: boolean; permissions: string[] }> {
  const acc = await effectiveAccess(prisma, userId, projectId);
  return { role: acc.role, isAdmin: acc.isAdmin, permissions: [...acc.permissions].sort() };
}

/**
 * Assert a fine-grained `resource:action` permission. OWNER/ADMIN pass
 * unconditionally; everyone else must hold the exact permission in their
 * effective set. Returns the resolved access so callers can reuse it.
 */
export async function assertPermission(
  prisma: PrismaService,
  userId: string,
  projectId: string,
  permission: string,
): Promise<EffectiveAccess> {
  const acc = await effectiveAccess(prisma, userId, projectId);
  if (acc.isAdmin || acc.permissions.has(permission)) return acc;
  throw new ForbiddenException(`Missing permission: ${permission}`);
}

/**
 * Assert a rank-gated administrative capability (members:manage, roles:manage,
 * project:delete, project:transfer, project:settings). These are NEVER
 * delegable through a custom role — they follow the built-in role rank only.
 */
export async function assertCapability(
  prisma: PrismaService,
  userId: string,
  projectId: string,
  capability: string,
): Promise<ProjectRole> {
  const role = await getProjectRole(prisma, userId, projectId);
  if (!rankAllows(role, capability)) {
    throw new ForbiddenException(`Requires a higher role for: ${capability}`);
  }
  return role;
}
