import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ProjectRole } from '@prisma/client';

/**
 * RBAC matrix (per project):
 *   OWNER     — full control, can delete project, transfer ownership, manage all members
 *   ADMIN     — manage members (except OWNER), manage all resources
 *   DEVELOPER — create/edit/delete apps, domains, deploy, redeploy
 *   VIEWER    — read-only
 *
 * Rank is used to compare (higher number = more rights).
 *
 * **Platform-admin bypass.** A user whose global `role` is `ADMIN` or
 * `SUPERADMIN` is treated as an implicit OWNER on every project. This
 * mirrors the ad-hoc bypasses that used to live across services (domains,
 * email, databases…) and keeps them in one place. Per-project membership
 * is still checked first so a regular user with explicit project access
 * gets their actual role (avoids the case where ADMIN's project role
 * shadows their explicit member role).
 */
export const ROLE_RANK: Record<ProjectRole, number> = {
  OWNER: 100,
  ADMIN: 80,
  DEVELOPER: 50,
  VIEWER: 10,
};

export function hasRole(role: ProjectRole, min: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

async function isPlatformAdmin(prisma: PrismaService, userId: string): Promise<boolean> {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';
}

export async function getProjectRole(
  prisma: PrismaService,
  userId: string,
  projectId: string,
): Promise<ProjectRole> {
  const [member, proj] = await Promise.all([
    prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    }),
  ]);
  if (!proj && !member) throw new NotFoundException('Project not found');

  // The legacy owner pointer (project.userId) is OWNER-equivalent and must
  // NEVER be shadowed by a lower membership row: a project creator who
  // accidentally re-adds themselves as a lower role (the "I put my email in
  // DEVELOPER and it demoted me" foot-gun) would otherwise be locked out of
  // their own project. This wins even over an explicit membership row.
  if (proj?.userId === userId) {
    // Self-heal a membership row that drifted below OWNER. Idempotent: writes
    // only when actually inconsistent, so it's a no-op after one correction
    // and the members list then shows the right role too.
    if (member && member.role !== 'OWNER') {
      await prisma.projectMember
        .update({
          where: { projectId_userId: { projectId, userId } },
          data: { role: 'OWNER' },
        })
        .catch(() => {});
    }
    return 'OWNER';
  }

  // An explicit membership row is authoritative next — it deliberately
  // shadows the platform-admin bypass so a global ADMIN who was given an
  // explicit VIEWER role on a project stays VIEWER there.
  if (member) return member.role;

  // No membership: platform admins act as implicit OWNER everywhere.
  if (await isPlatformAdmin(prisma, userId)) return 'OWNER';
  throw new ForbiddenException('You are not a member of this project');
}

export async function assertProjectAccess(
  prisma: PrismaService,
  userId: string,
  projectId: string,
  minRole: ProjectRole = 'VIEWER',
): Promise<ProjectRole> {
  const role = await getProjectRole(prisma, userId, projectId);
  if (!hasRole(role, minRole)) {
    throw new ForbiddenException(
      `Requires role >= ${minRole}, you are ${role}`,
    );
  }
  return role;
}

/** All project IDs the user has any role on. Platform admins see them all. */
export async function listAccessibleProjectIds(
  prisma: PrismaService,
  userId: string,
): Promise<string[]> {
  if (await isPlatformAdmin(prisma, userId)) {
    const all = await prisma.project.findMany({ select: { id: true } });
    return all.map((p) => p.id);
  }
  const [memberships, owned] = await Promise.all([
    prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    }),
    prisma.project.findMany({
      where: { userId },
      select: { id: true },
    }),
  ]);
  const set = new Set<string>();
  for (const m of memberships) set.add(m.projectId);
  for (const o of owned) set.add(o.id);
  return [...set];
}
