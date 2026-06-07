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
import { AgentService } from '../agent/agent.service';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private admin: AdminService,
    private agent: AgentService,
    private proxy: ReverseProxyService,
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

  /**
   * Move every app + DB in this project from its current server to `targetServerId`.
   *
   * Flow per app: enqueue REMOVE on the *old* server (best-effort — failures
   * are logged not blocking, because the old server may be unreachable, which
   * is often why the user is migrating in the first place), then flip the
   * project.serverId and enqueue DEPLOY on the new server. Caddy regenerates
   * so domain routing follows. Mark each app status TRANSITIONING during the
   * window so the UI shows progress.
   */
  async migrate(projectId: string, userId: string, targetServerId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'ADMIN');

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        server: { select: { id: true, host: true, name: true } },
        applications: { select: { id: true, name: true, status: true } },
        databases: { select: { id: true, name: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (project.serverId === targetServerId) {
      throw new BadRequestException('Project is already on this server');
    }

    const target = await this.prisma.server.findUnique({ where: { id: targetServerId } });
    if (!target) throw new NotFoundException('Target server not found');
    if (target.status !== 'ONLINE') {
      throw new BadRequestException(`Target server "${target.name}" is ${target.status} — must be ONLINE`);
    }

    const oldServerId = project.serverId;
    const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';

    // Best-effort tear down on old server. CRITICAL: purgeVolumes is FALSE
    // here so the source server stops the containers but KEEPS the named
    // volumes intact. Until VOLUME_EXPORT/VOLUME_IMPORT lands, this is the
    // safe default — the user can still recover the source state by
    // flipping back, instead of losing every database/upload on migrate.
    const teardownErrors: string[] = [];
    for (const app of project.applications) {
      try {
        await this.agent.enqueueTask(oldServerId, 'REMOVE', {
          slug: slugify(app.name),
          containerName: `kryptalis-${slugify(app.name)}`,
          purgeVolumes: false,
        });
      } catch (e: any) {
        teardownErrors.push(`${app.name}: ${e?.message || e}`);
      }
    }
    for (const db of project.databases) {
      try {
        await this.agent.enqueueTask(oldServerId, 'REMOVE', {
          slug: slugify(db.name),
          containerName: `kryptalis-db-${slugify(db.name)}`,
          purgeVolumes: false,
        });
      } catch (e: any) {
        teardownErrors.push(`db ${db.name}: ${e?.message || e}`);
      }
    }

    // Flip the server pointer.
    await this.prisma.project.update({
      where: { id: projectId },
      data: { serverId: targetServerId },
    });

    // Re-deploy each app on the new server (queued — agent picks them up).
    const queued: string[] = [];
    for (const app of project.applications) {
      try {
        await this.agent.enqueueTask(targetServerId, 'DEPLOY', {
          applicationId: app.id,
          slug: slugify(app.name),
        });
        queued.push(app.name);
      } catch (e: any) {
        teardownErrors.push(`redeploy ${app.name}: ${e?.message || e}`);
      }
    }
    for (const db of project.databases) {
      try {
        await this.agent.enqueueTask(targetServerId, 'DEPLOY', {
          databaseId: db.id,
          slug: slugify(db.name),
        });
        queued.push(`db:${db.name}`);
      } catch (e: any) {
        teardownErrors.push(`redeploy db ${db.name}: ${e?.message || e}`);
      }
    }

    // Caddy regen so domains follow the move.
    this.proxy.regenerate().catch(() => {});

    const hasRedeployErrors = teardownErrors.some((e) => e.startsWith('redeploy '));
    const status = hasRedeployErrors ? 'partial' : 'ok';
    const message =
      status === 'partial'
        ? `Project migration started with errors — check warnings. Source volumes are KEPT for recovery.`
        : `Project migrated from ${project.server?.name || oldServerId} → ${target.name}. NOTE: Docker volumes were not copied; databases and uploads will start empty on the target until VOLUME_EXPORT/IMPORT is implemented.`;
    return { status, message, queued, warnings: teardownErrors };
  }

  /**
   * Service-mesh view of a project: every app + database, the hostname they
   * can be reached at *from inside* the shared docker network, and ready-made
   * connection-string snippets the user can paste into another app's env vars.
   *
   * Network: kryptalis_proj_<projectId-stripped>. Every container is named
   * by its slug + id-suffix so siblings can resolve each other by DNS.
   */
  async getServiceMesh(projectId: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        applications: {
          select: {
            id: true, name: true, status: true, port: true,
            containerName: true, containerPort: true, framework: true,
          },
        },
        databases: {
          select: { id: true, name: true, type: true, port: true, username: true },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'svc';
    const networkName = `kryptalis_proj_${projectId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;

    const apps = project.applications.map((a) => {
      const slug = slugify(a.name);
      const host = a.containerName || `kryptalis-${slug}`;
      const port = a.containerPort || a.port || 80;
      return {
        id: a.id,
        name: a.name,
        kind: 'app' as const,
        status: a.status,
        framework: a.framework,
        host,
        port,
        url: `http://${host}:${port}`,
      };
    });

    const dbs = project.databases.map((d) => {
      const slug = slugify(d.name);
      const host = `kryptalis-db-${slug}`;
      const port = d.port;
      const protocol =
        d.type === 'POSTGRESQL' ? 'postgres' :
        d.type === 'MYSQL' ? 'mysql' :
        d.type === 'MARIADB' ? 'mysql' :
        d.type === 'MONGODB' ? 'mongodb' :
        d.type === 'REDIS' ? 'redis' : 'tcp';
      return {
        id: d.id,
        name: d.name,
        kind: 'database' as const,
        dbType: d.type,
        host,
        port,
        username: d.username,
        url: `${protocol}://${d.username}:<PASSWORD>@${host}:${port}/${slug}`,
      };
    });

    // Env-var suggestions: "if you link database X to app Y, paste this".
    const envSuggestions: { from: { id: string; name: string }; to: { id: string; name: string }; envVar: string; value: string }[] = [];
    for (const db of dbs) {
      const envName =
        db.dbType === 'POSTGRESQL' ? 'DATABASE_URL' :
        db.dbType === 'MYSQL' || db.dbType === 'MARIADB' ? 'DATABASE_URL' :
        db.dbType === 'MONGODB' ? 'MONGO_URL' :
        db.dbType === 'REDIS' ? 'REDIS_URL' : 'DB_URL';
      for (const app of apps) {
        envSuggestions.push({
          from: { id: db.id, name: db.name },
          to: { id: app.id, name: app.name },
          envVar: envName,
          value: db.url,
        });
      }
    }

    return {
      projectId,
      networkName,
      apps,
      databases: dbs,
      envSuggestions,
      hint: 'Containers in this project share a docker network and can reach each other by these hostnames. Use them in env vars instead of IPs.',
    };
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
