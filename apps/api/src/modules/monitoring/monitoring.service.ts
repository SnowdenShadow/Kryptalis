import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAlertRuleDto } from './dto/create-alert-rule.dto';

const PERIOD_MAP: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

@Injectable()
export class MonitoringService {
  constructor(private prisma: PrismaService) {}

  /**
   * Resolve the set of serverIds the caller can see via project membership
   * (or the entire fleet for platform admins). Used to scope read-only
   * metric and alert-rule listings.
   */
  private async accessibleServerIds(userId: string): Promise<string[]> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (me?.role === 'ADMIN' || me?.role === 'SUPERADMIN') {
      const all = await this.prisma.server.findMany({ select: { id: true } });
      return all.map((s) => s.id);
    }
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { project: { select: { serverId: true } } },
    });
    return Array.from(new Set(memberships.map((m) => m.project.serverId).filter(Boolean)));
  }

  async getMetrics(userId: string, serverId: string, period: string = '24h') {
    const allowed = await this.accessibleServerIds(userId);
    if (!allowed.includes(serverId)) {
      throw new ForbiddenException('You do not have access to this server.');
    }
    const ms = PERIOD_MAP[period] || PERIOD_MAP['24h'];
    const since = new Date(Date.now() - ms);
    return this.prisma.serverMetric.findMany({
      where: { serverId, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
  }

  async createAlertRule(dto: CreateAlertRuleDto) {
    // Mutation is admin-only at the controller layer.
    return this.prisma.alertRule.create({ data: dto as any });
  }

  async updateAlertRule(
    id: string,
    dto: Partial<{ enabled: boolean; threshold: number; channel: string; webhookUrl: string | null }>,
  ) {
    const rule = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Alert rule not found');
    return this.prisma.alertRule.update({ where: { id }, data: dto as any });
  }

  async getAlertRules(userId: string, serverId?: string) {
    const allowed = await this.accessibleServerIds(userId);
    const where: any = { serverId: { in: allowed } };
    if (serverId) {
      if (!allowed.includes(serverId)) {
        throw new ForbiddenException('You do not have access to this server.');
      }
      where.serverId = serverId;
    }
    return this.prisma.alertRule.findMany({ where });
  }

  async deleteAlertRule(id: string) {
    const rule = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Alert rule not found');
    await this.prisma.alertRule.delete({ where: { id } });
    return { message: 'Alert rule deleted' };
  }
}
