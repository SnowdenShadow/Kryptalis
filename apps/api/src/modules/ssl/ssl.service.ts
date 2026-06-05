import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SslService {
  constructor(private prisma: PrismaService) {}

  async issue(domainId: string) {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new Error('Domain not found');

    const server = await this.prisma.application.findFirst({
      where: { id: domain.applicationId || '' },
      include: { project: { include: { server: true } } },
    });

    if (server?.project?.server) {
      await this.prisma.agentTask.create({
        data: {
          serverId: server.project.server.id,
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

  async renew(certificateId: string) {
    const cert = await this.prisma.sSLCertificate.findUnique({
      where: { id: certificateId },
      include: { domain: true },
    });
    if (!cert) throw new Error('Certificate not found');
    return this.issue(cert.domainId);
  }

  async getCertificates(domainId?: string) {
    return this.prisma.sSLCertificate.findMany({
      where: domainId ? { domainId } : {},
      include: { domain: { select: { id: true, domain: true } } },
    });
  }
}
