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
    const rows = await this.prisma.serverMetric.findMany({
      where: { serverId, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });

    // For windows > 24h, downsample to <= 720 points by averaging into
    // fixed time buckets (5m for 7d, 1h for 30d, 1d for 90d+). Smaller
    // windows are returned as-is (raw 30s rows already fit on a chart).
    if (ms <= PERIOD_MAP['24h'] || rows.length === 0) {
      return rows;
    }
    return this.downsample(rows, ms);
  }

  /**
   * Bucket raw ServerMetric rows by floor(timestamp / bucketSize) and
   * average each numeric field within the bucket. BigInt fields are
   * summed as BigInt and divided by the bucket count at the end so we
   * never lose precision mid-aggregation. Returned shape matches the
   * raw row shape (one representative `id`/`serverId` per bucket, the
   * bucket-start `timestamp`, averaged numeric fields).
   */
  private downsample(
    rows: Array<{
      id: string;
      serverId: string;
      cpuPercent: number;
      memoryUsed: bigint;
      memoryTotal: bigint;
      diskUsed: bigint;
      diskTotal: bigint;
      networkIn: bigint;
      networkOut: bigint;
      timestamp: Date;
    }>,
    windowMs: number,
  ) {
    // Pick bucket size so total buckets <= 720.
    //   <=24h:  raw (handled by caller)
    //   <=7d:   1h buckets → 168 points
    //   <=30d:  1h buckets → 720 points
    //   >30d:   1d buckets → e.g. 90d=90 points
    // (Task spec: 5-min/day, hour/week, day/month — but day-window is
    // returned raw upstream, so the effective ladder starts at "week".)
    let bucketMs: number;
    if (windowMs <= PERIOD_MAP['7d']) {
      bucketMs = 60 * 60 * 1000; // 1 hour
    } else if (windowMs <= PERIOD_MAP['30d']) {
      bucketMs = 60 * 60 * 1000; // 1 hour → 30d=720 points
    } else {
      bucketMs = 24 * 60 * 60 * 1000; // 1 day
    }
    // Hard cap: never exceed 720 buckets — widen if needed.
    const slots = Math.ceil(windowMs / bucketMs);
    if (slots > 720) {
      bucketMs = Math.ceil(windowMs / 720);
    }

    type Acc = {
      bucketStart: number;
      count: number;
      cpuSum: number;
      memoryUsedSum: bigint;
      memoryTotalSum: bigint;
      diskUsedSum: bigint;
      diskTotalSum: bigint;
      networkInSum: bigint;
      networkOutSum: bigint;
      firstId: string;
      serverId: string;
    };

    const buckets = new Map<number, Acc>();
    for (const r of rows) {
      const ts = r.timestamp.getTime();
      const key = Math.floor(ts / bucketMs);
      let acc = buckets.get(key);
      if (!acc) {
        acc = {
          bucketStart: key * bucketMs,
          count: 0,
          cpuSum: 0,
          memoryUsedSum: 0n,
          memoryTotalSum: 0n,
          diskUsedSum: 0n,
          diskTotalSum: 0n,
          networkInSum: 0n,
          networkOutSum: 0n,
          firstId: r.id,
          serverId: r.serverId,
        };
        buckets.set(key, acc);
      }
      acc.count += 1;
      acc.cpuSum += r.cpuPercent;
      acc.memoryUsedSum += r.memoryUsed;
      acc.memoryTotalSum += r.memoryTotal;
      acc.diskUsedSum += r.diskUsed;
      acc.diskTotalSum += r.diskTotal;
      acc.networkInSum += r.networkIn;
      acc.networkOutSum += r.networkOut;
    }

    const out = Array.from(buckets.values())
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((a) => {
        const n = BigInt(a.count);
        return {
          id: a.firstId,
          serverId: a.serverId,
          cpuPercent: a.cpuSum / a.count,
          memoryUsed: a.memoryUsedSum / n,
          memoryTotal: a.memoryTotalSum / n,
          diskUsed: a.diskUsedSum / n,
          diskTotal: a.diskTotalSum / n,
          networkIn: a.networkInSum / n,
          networkOut: a.networkOutSum / n,
          timestamp: new Date(a.bucketStart),
        };
      });
    return out;
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
