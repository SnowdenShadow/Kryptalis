import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertAppOwnership } from '../applications/applications.helpers';
import { ApplicationOpsService } from '../applications/application-ops.service';
import { SchedulerLeaderService } from '../../common/scheduler/scheduler-leader.service';
import { CreateCronJobDto } from './dto/create-cron-job.dto';
import { UpdateCronJobDto } from './dto/update-cron-job.dto';
import { previousOccurrence, nextOccurrence } from './cron-schedule.util';

const TICK_INTERVAL_MS = 60_000;

/**
 * Scheduler + CRUD for user-managed cron jobs. Mirrors the backups scheduler:
 * a 60s setInterval tick compares each enabled job's previousOccurrence against
 * its lastRunAt watermark and, when due, runs the command INSIDE the app's
 * container via ApplicationOpsService.execCommand (local docker exec OR remote
 * EXEC agent task — already wired both ways). One API process = one scheduler;
 * no leader election, minute granularity, missed-while-down runs are skipped.
 */
@Injectable()
export class CronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronService.name);
  private timer: NodeJS.Timeout | null = null;
  // In-process guard so a slow command can't be double-fired by the next tick
  // before lastRunAt is persisted (belt-and-braces on top of the watermark).
  private readonly running = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private ops: ApplicationOpsService,
    private schedulerLeader: SchedulerLeaderService,
  ) {}

  onModuleInit() {
    // Single-instance scheduler guard: no live timer in tests OR on a follower
    // replica (SCHEDULER_ENABLED=false) — otherwise each replica would fire
    // every due cron job, running user commands N× per tick.
    if (!this.schedulerLeader.shouldRun()) return;
    this.timer = setInterval(
      () => void this.runDueJobs().catch((e) =>
        this.logger.error(`Cron tick crashed: ${(e as Error).message}`),
      ),
      TICK_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  async list(userId: string, applicationId?: string) {
    // Scope to apps the user can access. assertAppOwnership throws if not —
    // when an applicationId is given we gate on it; otherwise list across all
    // the user's accessible projects' apps.
    if (applicationId) {
      await assertAppOwnership(this.prisma, userId, applicationId, 'VIEWER');
      const jobs = await this.prisma.cronJob.findMany({
        where: { applicationId },
        orderBy: { createdAt: 'desc' },
      });
      return jobs.map((j) => this.withNextRun(j));
    }
    const jobs = await this.prisma.cronJob.findMany({
      where: { application: { project: { members: { some: { userId } } } } },
      orderBy: { createdAt: 'desc' },
      include: { application: { select: { id: true, name: true, displayName: true } } },
    });
    return jobs.map((j) => this.withNextRun(j));
  }

  async create(userId: string, dto: CreateCronJobDto) {
    // DEVELOPER+ can schedule jobs on an app they have access to.
    await assertAppOwnership(this.prisma, userId, dto.applicationId, 'DEVELOPER');
    const job = await this.prisma.cronJob.create({
      data: {
        name: dto.name,
        applicationId: dto.applicationId,
        schedule: dto.schedule,
        command: dto.command,
        enabled: dto.enabled ?? true,
      },
    });
    return this.withNextRun(job);
  }

  async update(userId: string, id: string, dto: UpdateCronJobDto) {
    await this.assertJobAccess(userId, id, 'DEVELOPER');
    const job = await this.prisma.cronJob.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.schedule !== undefined ? { schedule: dto.schedule } : {}),
        ...(dto.command !== undefined ? { command: dto.command } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    return this.withNextRun(job);
  }

  async remove(userId: string, id: string) {
    await this.assertJobAccess(userId, id, 'DEVELOPER');
    await this.prisma.cronJob.delete({ where: { id } });
    return { message: 'Cron job deleted' };
  }

  /** Run a job NOW (manual trigger), independent of its schedule. */
  async runNow(userId: string, id: string) {
    const job = await this.assertJobAccess(userId, id, 'DEVELOPER');
    await this.execute(job, userId);
    const fresh = await this.prisma.cronJob.findUnique({ where: { id } });
    return fresh ? this.withNextRun(fresh) : { message: 'Cron job triggered' };
  }

  // ── Scheduler ───────────────────────────────────────────────────────

  async runDueJobs(now: Date = new Date()): Promise<void> {
    const jobs = await this.prisma.cronJob.findMany({ where: { enabled: true } });
    for (const job of jobs) {
      try {
        if (this.running.has(job.id)) continue;
        const occurrence = previousOccurrence(job.schedule, now);
        if (!occurrence) continue; // invalid expression — skip quietly
        const last = job.lastRunAt ?? job.createdAt;
        if (last.getTime() >= occurrence.getTime()) continue; // already honoured

        // Mark the occurrence honoured BEFORE running so a slow command can't
        // be re-triggered by the next tick.
        await this.prisma.cronJob.update({
          where: { id: job.id },
          data: { lastRunAt: occurrence },
        });

        this.logger.log(`Cron job "${job.name}" (${job.schedule}) due — running.`);
        // Fire async; per-job isolation. The owning project's first member is
        // used as the actor for the exec ownership check (the job was created
        // by an authorized user; execution is system-driven).
        void this.execute(job).catch((e) =>
          this.logger.error(`Cron job ${job.id} run failed: ${(e as Error).message}`),
        );
      } catch (err) {
        this.logger.error(`Cron job "${job.name}" (${job.id}) failed to launch: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Execute a job's command inside its app container and record the outcome.
   * When `actorId` is omitted (scheduler path) we resolve an authorized member
   * of the app's project so the shared execCommand ownership check passes.
   */
  private async execute(job: { id: string; applicationId: string; command: string }, actorId?: string) {
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    const ranAt = new Date();
    try {
      const userId = actorId ?? (await this.resolveActor(job.applicationId));
      if (!userId) {
        this.logger.warn(`Cron job ${job.id}: no authorized actor for app ${job.applicationId} — skipping.`);
        await this.recordRun(job.id, ranAt, -1, 'Skipped: no authorized owner for this app.');
        return;
      }

      // Guard: if the app isn't running, `docker exec` fails with a raw, cryptic
      // docker error ("No such container" / "is not running"). Surface a clear,
      // distinct message instead so the user understands the cause.
      const app = await this.prisma.application.findUnique({
        where: { id: job.applicationId },
        select: { status: true, name: true },
      });
      if (app && app.status !== 'RUNNING') {
        await this.recordRun(
          job.id, ranAt, -1,
          `Skipped: the application "${app.name}" is ${app.status?.toLowerCase?.() || 'not running'}. ` +
          `Start it before this job can run its command.`,
        );
        return;
      }

      const res = await this.ops.execCommand(userId, job.applicationId, job.command);
      await this.recordRun(job.id, ranAt, res.exitCode, res.output || '');
    } finally {
      this.running.delete(job.id);
    }
  }

  /** Persist a run's outcome — lastRunAt is set on EVERY execution (manual or
   *  scheduled), so the dashboard's "Last run" reflects the most recent run. */
  private async recordRun(jobId: string, ranAt: Date, exitCode: number, output: string) {
    await this.prisma.cronJob.update({
      where: { id: jobId },
      data: { lastRunAt: ranAt, lastExitCode: exitCode, lastOutput: output.slice(0, 4000) },
    }).catch((e) => this.logger.warn(`Cron job ${jobId}: could not record run: ${(e as Error).message}`));
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /** First project member (the owner) — used as the actor for scheduler runs. */
  private async resolveActor(applicationId: string): Promise<string | null> {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: {
        project: {
          select: {
            members: {
              where: { role: 'OWNER' },
              select: { userId: true },
              take: 1,
            },
          },
        },
      },
    });
    return app?.project?.members?.[0]?.userId ?? null;
  }

  private async assertJobAccess(
    userId: string,
    id: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER',
  ) {
    const job = await this.prisma.cronJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Cron job not found');
    await assertAppOwnership(this.prisma, userId, job.applicationId, minRole);
    return job;
  }

  private withNextRun<T extends { schedule: string }>(job: T): T & { nextRunAt: string | null } {
    const next = nextOccurrence(job.schedule, new Date());
    return { ...job, nextRunAt: next ? next.toISOString() : null };
  }
}
