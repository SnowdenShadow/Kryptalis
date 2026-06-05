import { Injectable, NotFoundException } from '@nestjs/common';
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

  async getMetrics(serverId: string, period: string = '24h') {
    const ms = PERIOD_MAP[period] || PERIOD_MAP['24h'];
    const since = new Date(Date.now() - ms);
    return this.prisma.serverMetric.findMany({
      where: { serverId, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
  }

  async createAlertRule(dto: CreateAlertRuleDto) {
    return this.prisma.alertRule.create({ data: dto as any });
  }

  async getAlertRules(serverId?: string) {
    return this.prisma.alertRule.findMany({
      where: serverId ? { serverId } : {},
    });
  }

  async deleteAlertRule(id: string) {
    const rule = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Alert rule not found');
    await this.prisma.alertRule.delete({ where: { id } });
    return { message: 'Alert rule deleted' };
  }
}
