import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { MailServerService } from '../email/mail-server.service';
import { DomainAttachService } from './domain-attach.service';

@Injectable()
export class DomainsService {
  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    @Inject(forwardRef(() => MailServerService))
    private mailServer: MailServerService,
    private domainAttach: DomainAttachService,
  ) {}

  async create(userId: string, dto: CreateDomainDto) {
    const existing = await this.prisma.domain.findUnique({
      where: { domain: dto.domain },
    });
    if (existing) throw new ConflictException('Domain already exists');
    const { autoSsl, ...data } = dto;

    // resolve project: prefer explicit projectId, fall back to app's project
    let projectId = (dto as any).projectId as string | undefined;
    let applicationId = data.applicationId as string | undefined;

    if (applicationId) {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { projectId: true },
      });
      if (!app) throw new NotFoundException('Application not found');
      projectId = projectId || app.projectId;
      if (projectId !== app.projectId) {
        throw new BadRequestException("Application doesn't belong to the given project");
      }
    }

    if (!projectId) {
      throw new BadRequestException(
        'projectId is required — a domain must always belong to a project, even without an app',
      );
    }
    await assertProjectAccess(this.prisma, userId, projectId, 'DEVELOPER');

    const created = await this.prisma.domain.create({
      data: {
        ...data,
        projectId,
        applicationId: applicationId || null,
      },
    });
    this.proxy.regenerate().catch(() => {});
    return created;
  }

  async findAll(userId: string) {
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    if (projectIds.length === 0) return [];
    const domains = await this.prisma.domain.findMany({
      where: { projectId: { in: projectIds } },
      include: {
        project: { select: { id: true, name: true } },
        application: {
          select: {
            id: true,
            name: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    // attach mailServer flag — marketplace UI uses it to filter the domain
    // dropdown when installing webmail (Roundcube/SnappyMail/Rainloop) so
    // users can only pick a domain that has a running mail server.
    const mailServers = await this.prisma.mailServer.findMany({
      where: { domainId: { in: domains.map((d) => d.id) } },
      select: { domainId: true, status: true, hostname: true },
    });
    const msByDomain = new Map(mailServers.map((m) => [m.domainId, m]));
    return domains.map((d) => ({
      ...d,
      mailServer: msByDomain.get(d.id) || null,
    }));
  }

  private async assertDomainAccess(
    userId: string,
    id: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'VIEWER',
  ) {
    const domain = await this.prisma.domain.findUnique({
      where: { id },
      include: { application: { select: { projectId: true } } },
    });
    if (!domain) throw new NotFoundException('Domain not found');
    const projectId = domain.projectId || domain.application?.projectId;
    if (!projectId) {
      // legacy/orphan: admin-only
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (me?.role !== 'ADMIN' && me?.role !== 'SUPERADMIN') {
        throw new ForbiddenException('Domain has no project');
      }
      return domain;
    }
    await assertProjectAccess(this.prisma, userId, projectId, minRole);
    return domain;
  }

  async findOne(userId: string, id: string) {
    await this.assertDomainAccess(userId, id, 'VIEWER');
    const domain = await this.prisma.domain.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        application: true,
        dnsRecords: true,
        certificate: true,
      },
    });
    if (!domain) throw new NotFoundException('Domain not found');
    return domain;
  }

  async update(
    userId: string,
    id: string,
    data: { applicationId?: string | null; projectId?: string | null },
  ) {
    await this.assertDomainAccess(userId, id, 'DEVELOPER');

    if (data.applicationId !== undefined) {
      if (data.applicationId === null) {
        // Detaching everything: drop the clean-URL slot AND every port
        // binding the previous app had on this domain. Goes through the
        // central service so port bindings actually get cleaned up.
        const cur = await this.prisma.domain.findUnique({
          where: { id },
          select: { applicationId: true },
        });
        if (cur?.applicationId) {
          await this.domainAttach.detachAll(cur.applicationId, id);
        } else {
          await this.prisma.domain.update({ where: { id }, data: { applicationId: null } });
        }
      } else {
        // Attaching: route through DomainAttachService so multi-app rules
        // apply uniformly (same conflict policy as marketplace + git deploy).
        const app = await this.prisma.application.findUnique({
          where: { id: data.applicationId },
          select: { projectId: true, port: true, customPort: true },
        });
        if (!app) throw new NotFoundException('Target application not found');
        await assertProjectAccess(this.prisma, userId, app.projectId, 'DEVELOPER');
        await this.domainAttach.attach({
          applicationId: data.applicationId,
          domainId: id,
          projectId: app.projectId,
          customPort: !!app.customPort,
          port: app.port ?? 80,
        });
        // also re-home the domain under the app's project for visibility
        await this.prisma.domain.update({
          where: { id },
          data: { projectId: app.projectId },
        });
      }
    }

    if (data.projectId !== undefined && data.applicationId === undefined) {
      if (data.projectId) {
        await assertProjectAccess(this.prisma, userId, data.projectId, 'DEVELOPER');
        await this.prisma.domain.update({ where: { id }, data: { projectId: data.projectId } });
      } else {
        await this.prisma.domain.update({ where: { id }, data: { projectId: null } });
      }
    }

    this.proxy.regenerate().catch(() => {});
    return this.prisma.domain.findUnique({ where: { id } });
  }

  async remove(userId: string, id: string) {
    await this.assertDomainAccess(userId, id, 'ADMIN');
    // Tear down mail stack BEFORE deleting the domain row so the mailbox/alias
    // FKs still resolve and the container can be cleanly stopped + removed
    // (frees ports, removes compose dir, drops mail_servers row).
    try { await this.mailServer.removeForDomain(id); } catch {}
    await this.prisma.domain.delete({ where: { id } });
    this.proxy.regenerate().catch(() => {});
    return { message: 'Domain deleted' };
  }

  /**
   * Transfer a domain to a different project. Requires:
   *   - ADMIN on the source project
   *   - DEVELOPER on the target project
   * If the domain was linked to an app, the link is broken (the new project
   * likely doesn't have the same apps).
   */
  async transfer(userId: string, id: string, targetProjectId: string) {
    await this.assertDomainAccess(userId, id, 'ADMIN');
    await assertProjectAccess(this.prisma, userId, targetProjectId, 'DEVELOPER');
    const updated = await this.prisma.domain.update({
      where: { id },
      data: { projectId: targetProjectId, applicationId: null },
      include: {
        project: { select: { id: true, name: true } },
      },
    });
    this.proxy.regenerate().catch(() => {});
    return updated;
  }
}
