import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SchedulerLeaderService } from '../../common/scheduler/scheduler-leader.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { parseDockerStatsJson } from '../applications/applications.helpers';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { CreateAlertRuleDto } from './dto/create-alert-rule.dto';
import { UpdateAlertRuleDto } from './dto/update-alert-rule.dto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PERIOD_MAP: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

/** Alert-evaluation cadence. Matches the agent's 30 s metric push cadence
 *  so we evaluate roughly once per fresh sample. NotificationsService
 *  already dedupes by ruleId for 15 min so a sustained breach won't spam.
 */
const ALERT_EVAL_INTERVAL_MS = 30_000;

@Injectable()
export class MonitoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringService.name);
  private evalTimer: NodeJS.Timeout | null = null;
  private containerPruneTimer: NodeJS.Timeout | null = null;
  private localStatsTimer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private schedulerLeader: SchedulerLeaderService,
  ) {}

  onModuleInit() {
    // Single-instance scheduler guard: no loops in tests OR on a follower
    // replica (SCHEDULER_ENABLED=false) — otherwise every replica evaluates
    // the same alert rules / prunes the same table.
    if (!this.schedulerLeader.shouldRun()) return;
    this.evalTimer = setInterval(
      () => this.evaluateAlerts().catch((e) =>
        this.logger.error(`Alert eval loop crashed: ${e.message}`),
      ),
      ALERT_EVAL_INTERVAL_MS,
    );
    this.evalTimer.unref?.();
    // Container-metric retention prune: once shortly after boot, then every 6h.
    setTimeout(() => void this.pruneContainerMetrics(), 60_000);
    this.containerPruneTimer = setInterval(
      () => void this.pruneContainerMetrics(),
      6 * 60 * 60 * 1000,
    );
    this.containerPruneTimer.unref?.();
    // Local container-stats collector: remote hosts ship stats via heartbeat,
    // but LOCAL apps have no agent — so the API samples `docker stats` itself
    // on the same ~30s cadence and persists ContainerMetric rows for them.
    this.localStatsTimer = setInterval(
      () => this.collectLocalContainerStats().catch((e) =>
        this.logger.warn(`Local container-stats collect failed: ${e.message}`),
      ),
      ALERT_EVAL_INTERVAL_MS,
    );
    this.localStatsTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.evalTimer) clearInterval(this.evalTimer);
    if (this.containerPruneTimer) clearInterval(this.containerPruneTimer);
    if (this.localStatsTimer) clearInterval(this.localStatsTimer);
  }

  /**
   * Walk every enabled alert rule once, compare the most recent metric
   * sample against the rule's threshold, and hand off to
   * NotificationsService.sendAlert when crossed. Dedupe-by-ruleId lives
   * in the notifications service so the same fire isn't repeated every
   * 30 s — see NotificationsService.recentlyFiredAlerts.
   *
   * Metrics are computed as percentages so thresholds like "memory > 90"
   * mean 90 percent regardless of the server's RAM size.
   */
  private async evaluateAlerts(): Promise<void> {
    const rules = await this.prisma.alertRule.findMany({ where: { enabled: true } });
    if (rules.length === 0) return;

    // Group by server so we fetch each server's latest sample once even
    // when several rules target the same machine.
    const byServer = new Map<string, typeof rules>();
    for (const r of rules) {
      const arr = byServer.get(r.serverId) ?? [];
      arr.push(r);
      byServer.set(r.serverId, arr);
    }

    for (const [serverId, serverRules] of byServer) {
      const latest = await this.prisma.serverMetric.findFirst({
        where: { serverId },
        orderBy: { timestamp: 'desc' },
      });
      if (!latest) continue;

      for (const rule of serverRules) {
        const value = this.metricValue(rule.metric, latest, rule.operator);
        if (value == null) continue;
        if (this.compareThreshold(value, rule.operator, rule.threshold)) {
          // Fire-and-forget: notifications service swallows its own
          // errors so a misconfigured channel can't take down the loop.
          this.notifications.sendAlert(rule, value).catch((e) =>
            this.logger.error(`sendAlert(${rule.id}) failed: ${e.message}`),
          );
        }
      }
    }
  }

  /** Threshold comparison using the rule's operator. */
  private compareThreshold(value: number, op: string, threshold: number): boolean {
    switch (op) {
      case 'GT': return value > threshold;
      case 'GTE': return value >= threshold;
      case 'LT': return value < threshold;
      case 'LTE': return value <= threshold;
      case 'EQ': return value === threshold;
      default: return value >= threshold;
    }
  }

  /**
   * Convert a raw metric row → comparable percentage for the named metric.
   *
   * Direction matters for memory/disk. The dashboard advertises two intents:
   *   - GT/GTE/EQ → "used % crossed a ceiling" (e.g. disk used >= 90%)
   *   - LT/LTE    → "free % dropped below a floor" (e.g. free disk < 10%)
   *
   * The metric row only stores USED bytes, so a naive `used% < 10` would mean
   * "almost empty", the opposite of the documented "free disk < 10%". To make
   * the floor-watching intent work, for LT/LTE on memory/disk we return the
   * FREE percentage (100 − used%); GT/GTE/EQ keep using the USED percentage.
   * cpuPercent has no "free" counterpart, so the operator never flips it.
   */
  private metricValue(
    metric: string,
    row: {
      cpuPercent: number;
      memoryUsed: bigint;
      memoryTotal: bigint;
      diskUsed: bigint;
      diskTotal: bigint;
    },
    operator?: string,
  ): number | null {
    // LT/LTE on a capacity metric is a "free fell below floor" check.
    const wantFree = operator === 'LT' || operator === 'LTE';
    switch (metric) {
      case 'cpu':
        return row.cpuPercent;
      case 'memory': {
        if (row.memoryTotal === 0n) return null;
        const usedPct = Number((row.memoryUsed * 10000n) / row.memoryTotal) / 100;
        return wantFree ? 100 - usedPct : usedPct;
      }
      case 'disk': {
        if (row.diskTotal === 0n) return null;
        const usedPct = Number((row.diskUsed * 10000n) / row.diskTotal) / 100;
        return wantFree ? 100 - usedPct : usedPct;
      }
      default:
        return null;
    }
  }

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
      select: {
        project: {
          select: {
            // A project has no server of its own — its accessible servers are
            // the union of the servers its apps and databases are placed on.
            applications: { select: { serverId: true } },
            databases: { select: { serverId: true } },
          },
        },
      },
    });
    const ids = new Set<string>();
    for (const m of memberships) {
      for (const a of m.project.applications ?? []) {
        if (a.serverId) ids.add(a.serverId);
      }
      for (const d of m.project.databases ?? []) {
        if (d.serverId) ids.add(d.serverId);
      }
    }
    return Array.from(ids);
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

  // ── container metrics (per-app resource history + overview) ─────────

  /**
   * Historical per-container resource samples for one application, scoped to
   * the caller's project access (VIEWER+). Same period + downsample ladder as
   * server metrics. When an app runs several containers (multi-service /
   * PHP nginx+fpm) the samples are bucketed per containerName so each keeps
   * its own line.
   */
  async getAppMetrics(userId: string, applicationId: string, period: string = '24h') {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { projectId: true },
    });
    if (!app) throw new NotFoundException('Application not found');
    await assertProjectAccess(this.prisma, userId, app.projectId, 'VIEWER');

    const ms = PERIOD_MAP[period] || PERIOD_MAP['24h'];
    const since = new Date(Date.now() - ms);
    const rows = await this.prisma.containerMetric.findMany({
      where: { applicationId, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
    if (ms <= PERIOD_MAP['24h'] || rows.length === 0) return rows;
    return this.downsampleContainer(rows, ms);
  }

  /**
   * Fleet-wide "current usage" overview: the latest sample per container the
   * caller can see (scoped via accessibleServerIds, same as server metrics).
   * Feeds the global table on the Monitoring page (sortable by CPU/RAM).
   */
  async getContainerOverview(userId: string) {
    const allowed = await this.accessibleServerIds(userId);
    if (allowed.length === 0) return [];
    // One recent window is enough to find "latest per container" cheaply —
    // anything older than a few minutes is stale/stopped anyway.
    const since = new Date(Date.now() - 10 * 60_000);
    const rows = await this.prisma.containerMetric.findMany({
      where: { serverId: { in: allowed }, timestamp: { gte: since } },
      orderBy: { timestamp: 'desc' },
      include: {
        application: { select: { id: true, name: true, displayName: true, projectId: true } },
      },
    });
    // Keep only the newest row per containerName (rows are desc, so first wins).
    const seen = new Set<string>();
    const latest: typeof rows = [];
    for (const r of rows) {
      const key = `${r.serverId}:${r.containerName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(r);
    }
    return latest;
  }

  /**
   * Retention prune for container_metrics — this table grows an order of
   * magnitude faster than server_metrics, so the default window is shorter
   * (container_metrics_retention_days, default 7d). Age-based only; the
   * per-container index keeps the delete cheap. Runs on the leader replica.
   */
  async pruneContainerMetrics(): Promise<void> {
    try {
      const retention = this.retentionDays();
      const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000);
      const res = await this.prisma.containerMetric.deleteMany({
        where: { timestamp: { lt: cutoff } },
      });
      if (res.count > 0) {
        this.logger.log(`Container-metric retention prune: removed ${res.count} rows (> ${retention}d).`);
      }
    } catch (e) {
      this.logger.error(`Container-metric prune failed: ${(e as Error).message}`);
    }
  }

  private retentionDays(): number {
    // Kept as a method so a future SystemSetting override slots in here.
    return 7;
  }

  /**
   * Sample `docker stats` for LOCAL dockcontrol-* containers and persist them
   * as ContainerMetric rows. Remote hosts self-report via the agent heartbeat;
   * this covers the API box's own containers, which have no agent. Resolves
   * each container to its app + local server by containerName. Best-effort:
   * docker down / no local server → no-op.
   */
  async collectLocalContainerStats(): Promise<void> {
    // Find the local server row (host is a loopback alias). Without one we
    // have no serverId to attribute samples to, so skip.
    const servers = await this.prisma.server.findMany({ select: { id: true, host: true } });
    const local = servers.find((s) => isLocalHost(s.host));
    if (!local) return;

    let stdout = '';
    try {
      ({ stdout } = await execFileAsync(
        'docker',
        ['stats', '--no-stream', '--format', '{{json .}}'],
        { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      ));
    } catch {
      return; // docker missing/down — nothing to record
    }
    const stats = parseDockerStatsJson(stdout).filter((s) => s.name.startsWith('dockcontrol-'));
    if (stats.length === 0) return;

    // Attribute to apps placed on the local server by containerName.
    const apps = await this.prisma.application.findMany({
      where: { serverId: local.id, containerName: { in: stats.map((s) => s.name) } },
      select: { id: true, containerName: true },
    });
    const appByName = new Map(apps.map((a) => [a.containerName!, a.id]));

    await this.prisma.containerMetric.createMany({
      data: stats.map((s) => ({
        serverId: local.id,
        applicationId: appByName.get(s.name) ?? null,
        containerName: s.name,
        cpuPercent: Number.isFinite(s.cpuPercent) ? s.cpuPercent : 0,
        memoryUsed: BigInt(Math.max(0, Math.trunc(s.memoryUsed))),
        memoryLimit: BigInt(Math.max(0, Math.trunc(s.memoryLimit))),
        networkIn: BigInt(Math.max(0, Math.trunc(s.networkIn))),
        networkOut: BigInt(Math.max(0, Math.trunc(s.networkOut))),
        blockRead: BigInt(Math.max(0, Math.trunc(s.blockRead))),
        blockWrite: BigInt(Math.max(0, Math.trunc(s.blockWrite))),
      })),
    });
  }

  /**
   * Bucket container rows per containerName and average each numeric field
   * within a time bucket (BigInt summed then divided, like downsample()).
   * Returns rows in the same shape, one representative id per bucket.
   */
  private downsampleContainer(
    rows: Array<{
      id: string; serverId: string; applicationId: string | null; containerName: string;
      cpuPercent: number; memoryUsed: bigint; memoryLimit: bigint;
      networkIn: bigint; networkOut: bigint; blockRead: bigint; blockWrite: bigint;
      timestamp: Date;
    }>,
    windowMs: number,
  ) {
    let bucketMs = windowMs <= PERIOD_MAP['30d'] ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const slots = Math.ceil(windowMs / bucketMs);
    if (slots > 720) bucketMs = Math.ceil(windowMs / 720);

    type Acc = {
      bucketStart: number; count: number; cpuSum: number;
      memoryUsedSum: bigint; memoryLimitSum: bigint;
      networkInSum: bigint; networkOutSum: bigint; blockReadSum: bigint; blockWriteSum: bigint;
      firstId: string; serverId: string; applicationId: string | null; containerName: string;
    };
    // Key buckets by (containerName, bucket) so multi-container apps stay split.
    const buckets = new Map<string, Acc>();
    for (const r of rows) {
      const slot = Math.floor(r.timestamp.getTime() / bucketMs);
      const key = `${r.containerName}:${slot}`;
      let acc = buckets.get(key);
      if (!acc) {
        acc = {
          bucketStart: slot * bucketMs, count: 0, cpuSum: 0,
          memoryUsedSum: 0n, memoryLimitSum: 0n,
          networkInSum: 0n, networkOutSum: 0n, blockReadSum: 0n, blockWriteSum: 0n,
          firstId: r.id, serverId: r.serverId, applicationId: r.applicationId, containerName: r.containerName,
        };
        buckets.set(key, acc);
      }
      acc.count += 1;
      acc.cpuSum += r.cpuPercent;
      acc.memoryUsedSum += r.memoryUsed;
      acc.memoryLimitSum += r.memoryLimit;
      acc.networkInSum += r.networkIn;
      acc.networkOutSum += r.networkOut;
      acc.blockReadSum += r.blockRead;
      acc.blockWriteSum += r.blockWrite;
    }
    return Array.from(buckets.values())
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((a) => {
        const n = BigInt(a.count);
        return {
          id: a.firstId,
          serverId: a.serverId,
          applicationId: a.applicationId,
          containerName: a.containerName,
          cpuPercent: a.cpuSum / a.count,
          memoryUsed: a.memoryUsedSum / n,
          memoryLimit: a.memoryLimitSum / n,
          networkIn: a.networkInSum / n,
          networkOut: a.networkOutSum / n,
          blockRead: a.blockReadSum / n,
          blockWrite: a.blockWriteSum / n,
          timestamp: new Date(a.bucketStart),
        };
      });
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

  /**
   * SSRF screen for an operator-supplied webhookUrl, reusing the exact
   * ruleset NotificationsService applies at dispatch. Rejecting at write
   * time gives the admin an immediate 400 instead of a silently-skipped
   * webhook later.
   */
  private assertWebhookUrlSafe(webhookUrl?: string | null) {
    if (!webhookUrl) return;
    const violation = this.notifications.validateWebhookUrl(webhookUrl);
    if (violation) {
      throw new BadRequestException(`Invalid webhookUrl: ${violation}.`);
    }
  }

  async createAlertRule(dto: CreateAlertRuleDto) {
    // Mutation is admin-only at the controller layer.
    this.assertWebhookUrlSafe(dto.webhookUrl);
    // metric/channel/operator are validated as string literals by the DTO;
    // Prisma types them as enums, so cast at the boundary.
    return this.prisma.alertRule.create({ data: dto as any });
  }

  async updateAlertRule(id: string, dto: UpdateAlertRuleDto) {
    const rule = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Alert rule not found');
    this.assertWebhookUrlSafe(dto.webhookUrl);
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
