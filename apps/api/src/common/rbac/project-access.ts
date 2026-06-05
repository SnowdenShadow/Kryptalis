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

/**
 * Returns the user's role on the project, throwing if no access at all.
 * The "legacy" project.userId field is treated as an implicit OWNER membership
 * so older projects (pre-RBAC) keep working without backfill races.
 */
export async function getProjectRole(
  prisma: PrismaService,
  userId: string,
  projectId: string,
): Promise<ProjectRole> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  if (member) return member.role;
  // legacy fallback: original creator
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  });
  if (!proj) throw new NotFoundException('Project not found');
  if (proj.userId === userId) return 'OWNER';
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

/** All project IDs the user has any role on (membership OR legacy owner). */
export async function listAccessibleProjectIds(
  prisma: PrismaService,
  userId: string,
): Promise<string[]> {
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
