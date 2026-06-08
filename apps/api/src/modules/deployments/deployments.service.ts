import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TriggerDeploymentDto } from './dto/trigger-deployment.dto';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';

const ACTIVE_STATUSES = ['PENDING', 'BUILDING', 'DEPLOYING'] as const;
const KEEP_PER_APP = 50;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

@Injectable()
export class DeploymentsService implements OnModuleInit {
  private readonly logger = new Logger(DeploymentsService.name);
  private pruneTimer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    // Run once shortly after boot, then on a fixed interval.
    setTimeout(() => {
      void this.pruneOldDeployments();
    }, 30_000);
    this.pruneTimer = setInterval(() => {
      void this.pruneOldDeployments();
    }, PRUNE_INTERVAL_MS);
    // Don't hold the event loop open in tests / shutdown.
    this.pruneTimer.unref?.();
  }

  async pruneOldDeployments() {
    try {
      const retentionDays = Number(
        process.env.DEPLOYMENT_RETENTION_DAYS ?? 90,
      );
      const days =
        Number.isFinite(retentionDays) && retentionDays > 0
          ? retentionDays
          : 90;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // 1) Age-based prune: drop anything older than cutoff that isn't running.
      const ageDeleted = await this.prisma.deployment.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          status: { notIn: ACTIVE_STATUSES as unknown as any[] },
        },
      });

      // 2) Per-application cap: keep only the most recent KEEP_PER_APP.
      const apps = await this.prisma.deployment.groupBy({
        by: ['applicationId'],
        _count: { _all: true },
      });

      let capDeleted = 0;
      for (const a of apps) {
        if ((a._count?._all ?? 0) <= KEEP_PER_APP) continue;
        const keep = await this.prisma.deployment.findMany({
          where: { applicationId: a.applicationId },
          orderBy: { createdAt: 'desc' },
          take: KEEP_PER_APP,
          select: { id: true },
        });
        const keepIds = keep.map((k) => k.id);
        const res = await this.prisma.deployment.deleteMany({
          where: {
            applicationId: a.applicationId,
            id: { notIn: keepIds },
            status: { notIn: ACTIVE_STATUSES as unknown as any[] },
          },
        });
        capDeleted += res.count;
      }

      if (ageDeleted.count > 0 || capDeleted > 0) {
        this.logger.log(
          `Deployment retention prune: age=${ageDeleted.count} cap=${capDeleted} (retention=${days}d, keep=${KEEP_PER_APP}/app)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Deployment retention prune failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

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
