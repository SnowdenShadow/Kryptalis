import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { AdminService } from '../admin/admin.service';
import {
  assertProjectAccess,
  getProjectRole,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import type { ProjectRole } from '@prisma/client';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private admin: AdminService,
  ) {}

  async create(userId: string, dto: CreateProjectDto) {
    const mode = await this.admin.getDeploymentMode();
    let serverId = dto.serverId;
    if (mode === 'LOCAL') {
      // In LOCAL mode there is only one server — the local one. Use it
      // regardless of what the client sent (silently override).
      const local = await this.prisma.server.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      if (!local) {
        throw new BadRequestException('No local server provisioned yet');
      }
      serverId = local.id;
    } else {
      // MULTI mode: a serverId is required and must point at an ONLINE server.
      if (!serverId) {
        throw new BadRequestException('serverId is required in MULTI mode — pick a server in the wizard');
      }
      const server = await this.prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw new NotFoundException('Server not found');
      if (server.status !== 'ONLINE') {
        throw new BadRequestException(`Server "${server.name}" is ${server.status} — choose an ONLINE server`);
      }
    }
    const project = await this.prisma.project.create({
      data: {
        ...dto,
        serverId,
        userId,
        members: {
          create: { userId, role: 'OWNER' },
        },
      },
      include: { server: { select: { id: true, name: true, host: true } } },
    });
    return project;
  }

  async findAll(userId: string) {
    const ids = await listAccessibleProjectIds(this.prisma, userId);
    if (ids.length === 0) return [];
    return this.prisma.project.findMany({
      where: { id: { in: ids } },
      include: {
        server: { select: { id: true, name: true, host: true } },
        applications: {
          select: {
            id: true,
            name: true,
            status: true,
            framework: true,
            port: true,
          },
        },
        members: { where: { userId }, select: { role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const role = await assertProjectAccess(this.prisma, userId, id, 'VIEWER');
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        server: { select: { id: true, name: true, host: true } },
        applications: {
          include: {
            domains: { select: { id: true, domain: true, sslStatus: true } },
          },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return { ...project, currentRole: role };
  }

  async update(id: string, userId: string, dto: UpdateProjectDto) {
    await assertProjectAccess(this.prisma, userId, id, 'ADMIN');
    return this.prisma.project.update({
      where: { id },
      data: dto,
      include: { server: { select: { id: true, name: true, host: true } } },
    });
  }

  async remove(id: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, id, 'OWNER');
    await this.prisma.project.delete({ where: { id } });
    return { message: 'Project deleted' };
  }

  // ── Members ───────────────────────────────────────────────────────

  async listMembers(projectId: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(
    projectId: string,
    actorId: string,
    payload: { email?: string; userId?: string; role: ProjectRole },
  ) {
    const actorRole = await assertProjectAccess(
      this.prisma,
      actorId,
      projectId,
      'ADMIN',
    );
    if (payload.role === 'OWNER' && actorRole !== 'OWNER') {
      throw new BadRequestException('Only the OWNER can grant OWNER role');
    }
    let targetUserId = payload.userId;
    if (!targetUserId && payload.email) {
      const user = await this.prisma.user.findUnique({
        where: { email: payload.email },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('User not found');
      targetUserId = user.id;
    }
    if (!targetUserId) throw new BadRequestException('email or userId required');

    return this.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: targetUserId } },
      create: {
        projectId,
        userId: targetUserId,
        role: payload.role,
        invitedById: actorId,
      },
      update: { role: payload.role },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async updateMember(
    projectId: string,
    actorId: string,
    memberId: string,
    role: ProjectRole,
  ) {
    const actorRole = await assertProjectAccess(
      this.prisma,
      actorId,
      projectId,
      'ADMIN',
    );
    const member = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === role) return member; // no-op
    if (member.role === 'OWNER' && actorRole !== 'OWNER') {
      throw new BadRequestException('Only the OWNER can modify the OWNER');
    }
    if (role === 'OWNER' && actorRole !== 'OWNER') {
      throw new BadRequestException('Only the OWNER can grant OWNER role');
    }
    // never allow demoting the last OWNER — a project always needs at least one
    if (member.role === 'OWNER' && role !== 'OWNER') {
      const owners = await this.prisma.projectMember.count({
        where: { projectId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new BadRequestException(
          'Cannot demote the last OWNER. Promote another member to OWNER first.',
        );
      }
    }
    return this.prisma.projectMember.update({
      where: { id: memberId },
      data: { role },
    });
  }

  async removeMember(projectId: string, actorId: string, memberId: string) {
    const actorRole = await assertProjectAccess(
      this.prisma,
      actorId,
      projectId,
      'ADMIN',
    );
    const member = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === 'OWNER') {
      // can't remove the last OWNER
      const owners = await this.prisma.projectMember.count({
        where: { projectId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new BadRequestException(
          'Cannot remove the last OWNER. Transfer ownership first.',
        );
      }
      if (actorRole !== 'OWNER') {
        throw new BadRequestException('Only OWNERs can remove an OWNER');
      }
    }
    if (member.userId === actorId && actorRole === 'OWNER') {
      const owners = await this.prisma.projectMember.count({
        where: { projectId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new BadRequestException(
          'You are the last OWNER. Transfer ownership first.',
        );
      }
    }
    await this.prisma.projectMember.delete({ where: { id: memberId } });
    return { message: 'Member removed' };
  }

  async getMyRole(projectId: string, userId: string) {
    const role = await getProjectRole(this.prisma, userId, projectId);
    return { role };
  }

  /**
   * Transfer project ownership: actor (current OWNER) hands off OWNER to another
   * existing member, and downgrades themself to ADMIN.
   * Works only if actor is OWNER. Target must already be a member (any role).
   */
  async transferOwnership(projectId: string, actorId: string, targetUserId: string) {
    if (actorId === targetUserId) {
      throw new BadRequestException('You already are the OWNER');
    }
    const actorRole = await getProjectRole(this.prisma, actorId, projectId);
    if (actorRole !== 'OWNER') {
      throw new ForbiddenException('Only the OWNER can transfer ownership');
    }
    const target = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: targetUserId },
    });
    if (!target) {
      throw new BadRequestException('Target user must already be a project member');
    }
    // Run as a transaction so we never end up with zero OWNERs.
    await this.prisma.$transaction([
      this.prisma.projectMember.update({
        where: { id: target.id },
        data: { role: 'OWNER' },
      }),
      this.prisma.projectMember.updateMany({
        where: { projectId, userId: actorId, role: 'OWNER' },
        data: { role: 'ADMIN' },
      }),
      // sync the legacy Project.userId field to point at the new OWNER for backward compat
      this.prisma.project.update({
        where: { id: projectId },
        data: { userId: targetUserId },
      }),
    ]);
    return { message: 'Ownership transferred' };
  }
}
