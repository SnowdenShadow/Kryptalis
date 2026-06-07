import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';

/**
 * SSL operations are project-scoped: only members of the project that owns
 * the domain can issue/renew/list certs for it. Orphan domains (no project)
 * are only touchable by platform admins — handled in the controller.
 *
 * Previously this service threw `new Error(...)` which NestJS surfaces as
 * 500 with no useful body. We now throw `NotFoundException` so the
 * dashboard sees a clean 404 with the original message.
 */
@Injectable()
export class SslService {
  constructor(private prisma: PrismaService) {}

  async issue(userId: string, domainId: string) {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');

    // Orphan domains (no project) are touchable only by platform admins.
    // Previously the service silently let any JWT bearer through, which
    // let them queue SSL_ISSUE tasks against arbitrary domains.
    if (!domain.projectId) {
      await this.assertPlatformAdmin(userId);
    } else {
      await assertProjectAccess(this.prisma, userId, domain.projectId, 'DEVELOPER');
    }

    const app = await this.prisma.application.findFirst({
      where: { id: domain.applicationId || '' },
      include: { project: { include: { server: true } } },
    });

    if (app?.project?.server) {
      await this.prisma.agentTask.create({
        data: {
          serverId: app.project.server.id,
          type: 'SSL_ISSUE',
          payload: { domainId, domain: domain.domain },
        },
      });
    }

    await this.prisma.domain.update({
      where: { id: domainId },
      data: { sslStatus: 'PENDING' },
    });

    return { message: 'SSL issuance queued' };
  }

  async renew(userId: string, certificateId: string) {
    const cert = await this.prisma.sSLCertificate.findUnique({
      where: { id: certificateId },
      include: { domain: true },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return this.issue(userId, cert.domainId);
  }

  async getCertificates(userId: string, domainId?: string) {
    if (domainId) {
      const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
      if (!domain) throw new NotFoundException('Domain not found');
      if (!domain.projectId) {
        await this.assertPlatformAdmin(userId);
      } else {
        await assertProjectAccess(this.prisma, userId, domain.projectId, 'VIEWER');
      }
      return this.prisma.sSLCertificate.findMany({
        where: { domainId },
        include: { domain: { select: { id: true, domain: true } } },
      });
    }
    // No domainId → scope to certs whose domain belongs to a project the
    // caller can access.
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    return this.prisma.sSLCertificate.findMany({
      where: { domain: { projectId: { in: projectIds } } },
      include: { domain: { select: { id: true, domain: true } } },
    });
  }

  private async assertPlatformAdmin(userId: string) {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (me?.role !== 'ADMIN' && me?.role !== 'SUPERADMIN') {
      throw new ForbiddenException('Orphan-domain SSL operations require platform ADMIN.');
    }
  }
}
