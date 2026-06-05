import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TriggerDeploymentDto } from './dto/trigger-deployment.dto';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';

@Injectable()
export class DeploymentsService {
  constructor(private prisma: PrismaService) {}

  async trigger(userId: string, dto: TriggerDeploymentDto) {
    const app = await this.prisma.application.findUnique({
      where: { id: dto.applicationId },
      select: { projectId: true },
    });
    if (!app) throw new NotFoundException('Application not found');
    await assertProjectAccess(this.prisma, userId, app.projectId, 'DEVELOPER');
    return this.prisma.deployment.create({
      data: {
        applicationId: dto.applicationId,
        commitSha: dto.commitSha,
        triggeredById: userId,
      },
    });
  }

  async findAll(userId: string, applicationId?: string) {
    if (applicationId) {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { projectId: true },
      });
      if (!app) throw new NotFoundException('Application not found');
      await assertProjectAccess(this.prisma, userId, app.projectId, 'VIEWER');
      return this.prisma.deployment.findMany({
        where: { applicationId },
        include: { application: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    }
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    if (projectIds.length === 0) return [];
    return this.prisma.deployment.findMany({
      where: { application: { projectId: { in: projectIds } } },
      include: { application: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async findOne(userId: string, id: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id },
      include: {
        application: true,
        triggeredBy: { select: { id: true, name: true } },
      },
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    await assertProjectAccess(
      this.prisma,
      userId,
      deployment.application.projectId,
      'VIEWER',
    );
    return deployment;
  }
}
