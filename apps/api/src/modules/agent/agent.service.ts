import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  RequestTimeoutException,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { TRANSFERS_DIR } from '../../common/paths';
import { randomBytes, randomUUID } from 'crypto';
import { TaskType } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

export type AgentTaskType = keyof typeof TaskType;

/** Terminal task snapshot handed to registered completion handlers. */
export interface AgentTaskCompletion {
  id: string;
  serverId: string;
  type: string;
  payload: any;
  status: 'COMPLETED' | 'FAILED';
  result?: any;
  error?: string | null;
}

export type AgentTaskCompletionHandler = (task: AgentTaskCompletion) => Promise<void>;

// Transfer staging lives in .dockcontrol/transfers/<taskId>/<fileName> —
// written by the authenticated agent upload endpoint (or staged locally by the
// API for downloads) and removed when the task chain terminates. Path comes
// from the shared common/paths module (single source of truth).

/** Per-file transfer size cap. Generous by default (10 GB) — volume tars and
 *  full-server backup archives flow through here. Override with
 *  AGENT_TRANSFER_MAX_BYTES. */
const TRANSFER_MAX_BYTES = (() => {
  const raw = Number(process.env.AGENT_TRANSFER_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 1024 * 1024 * 1024;
})();

/**
 * Strip git credentials from agent-reported text before it is persisted.
 *
 * A private-repo DEPLOY embeds the token as `http.extraheader=Authorization:
 * Basic <b64>` in the cloned command, which the agent echoes into its deploy
 * logs (returned in the task result). New agents redact this at the source
 * (poller.go redactGitArgs), but an OLD agent binary talking to a freshly
 * upgraded API would not — so the API re-applies the same screen server-side
 * as defense-in-depth before the result/error ever lands in agent_tasks.
 * Mirrors application-deploy.service.ts redactSecrets().
 */
function redactAgentSecrets(text: string): string {
  return text
    .replace(/(Authorization:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9_\-+/.=]+/gi, '$1<redacted>')
    .replace(/(http\.extraheader=)[^\s'"]+/gi, '$1<redacted>')
    .replace(/(x-access-token:)[^@\s]+/gi, '$1<redacted>');
}

/**
 * Agent service. Two security invariants enforced here:
 *
 * 1. **Agent tokens are stored as sha256 hashes**, never plaintext. A DB
 *    leak no longer yields usable agent tokens. The agent still sees the
 *    raw token at register time and uses it in headers; we hash on read.
 *
 * 2. **Task result reporting is authenticated**. The previous
 *    POST /agent/tasks/:id/result endpoint was public — any anonymous
 *    HTTP client could overwrite any task's status/result/error. Now the
 *    agent must include its (serverId, token) pair and the task must
 *    belong to that server. This is checked in taskResult().
 *
 * It also implements the file-transfer plumbing + generic task chaining
 * agents use to move data between servers:
 *
 *   - POST /agent/transfers/:taskId/upload streams a raw binary body into
 *     .dockcontrol/transfers/<taskId>/<name> (validated in
 *     validateTransferUpload(); the controller does the actual streaming).
 *   - GET /agent/transfers/:taskId/download streams it back out — to the
 *     same server, or to a server holding a QUEUED/RUNNING task whose
 *     payload.sourceTaskId references the transfer (cross-server moves:
 *     VOLUME_IMPORT / RESTORE).
 *   - When a task completes and its payload carries
 *     `onComplete: [{serverId, type, payload}]`, those tasks are enqueued
 *     (COMPLETED only — a FAILED task drops its chain and logs). Modules can
 *     also register a per-type completion handler (registerTaskCompletionHandler)
 *     to react to terminal results — e.g. backups finalizing a remote dump.
 *   - Transfer dirs are cleaned up when the chain terminates: a terminal
 *     task removes transfers/<payload.sourceTaskId> (its input, now
 *     consumed/abandoned) and its own transfers/<taskId> unless a chained
 *     task still needs it (COMPLETED with a non-empty onComplete).
 */
@Injectable()
export class AgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);
  private staleTaskInterval: NodeJS.Timeout | null = null;
  private static readonly STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly STALE_TASK_THRESHOLD_MS = 30 * 60 * 1000;

  /** Per-TaskType completion hooks (e.g. BACKUP → BackupsService finalizer).
   *  One handler per type keeps the wiring simple and explicit. */
  private completionHandlers = new Map<string, AgentTaskCompletionHandler>();

  /** Task types whose payload carries database credentials in flight
   *  (encrypted at rest, decrypted only when served to the agent in poll()).
   *  Their payload is scrubbed from the DB once the task is terminal. */
  private static readonly SENSITIVE_PAYLOAD_TYPES = new Set<string>(['BACKUP', 'RESTORE']);

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  onModuleInit() {
    // Periodically fail tasks stuck in QUEUED/RUNNING beyond the threshold —
    // these indicate an agent crashed or disconnected mid-task.
    this.staleTaskInterval = setInterval(() => {
      this.failStaleTasks().catch((err) => {
        this.logger.error('failStaleTasks sweep failed', err as any);
      });
    }, AgentService.STALE_SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.staleTaskInterval) {
      clearInterval(this.staleTaskInterval);
      this.staleTaskInterval = null;
    }
  }

  /**
   * Mark any QUEUED or RUNNING task older than the threshold as FAILED.
   * Runs on a timer; assumes the agent crashed or disconnected mid-task.
   * Each stale task is routed through the same termination hooks a real
   * FAILED report triggers (completion handlers + transfer cleanup) so e.g.
   * a remote BACKUP row doesn't hang in IN_PROGRESS forever when its agent
   * dies. Chains are dropped, as for any FAILED task.
   */
  private async failStaleTasks() {
    const cutoff = new Date(Date.now() - AgentService.STALE_TASK_THRESHOLD_MS);
    const stale = await this.prisma.agentTask.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] as any },
        createdAt: { lt: cutoff },
      },
      select: { id: true, serverId: true, type: true, payload: true },
    });
    if (stale.length === 0) return;

    const error = 'Task timed out — agent disconnected';
    // Re-assert status IN (QUEUED, RUNNING) in the UPDATE predicate, not just
    // the prior SELECT. Between the findMany above and this updateMany an agent
    // can legitimately report COMPLETED; without this guard we'd clobber that
    // back to FAILED (a lost update) and re-run handleTaskTermination as FAILED
    // — which drops the onComplete chain (e.g. a cross-server VOLUME_IMPORT /
    // RESTORE would never enqueue). Keyed on id alone, the row would match
    // regardless of its current status; the status predicate makes the sweep
    // idempotent against a concurrent terminal report.
    const swept = await this.prisma.agentTask.updateMany({
      where: {
        id: { in: stale.map((t) => t.id) },
        status: { in: ['QUEUED', 'RUNNING'] as any },
      },
      data: {
        status: 'FAILED' as any,
        error,
        completedAt: new Date(),
      },
    });
    // Only run termination hooks for tasks this sweep actually transitioned.
    // If a task completed in the race window it was not updated, so we must
    // not fire FAILED-side termination for it. Re-read the rows that are still
    // FAILED with our error string to get the authoritative set.
    if (swept.count === 0) return;
    const failedIds = new Set(
      (
        await this.prisma.agentTask.findMany({
          where: { id: { in: stale.map((t) => t.id) }, status: 'FAILED' as any, error },
          select: { id: true },
        })
      ).map((t) => t.id),
    );
    this.logger.warn(`Failed ${failedIds.size} stale agent task(s) (>30m in QUEUED/RUNNING)`);

    for (const task of stale) {
      if (!failedIds.has(task.id)) continue;
      await this.handleTaskTermination({
        id: task.id,
        serverId: task.serverId,
        type: String(task.type),
        payload: task.payload,
        status: 'FAILED',
        error,
      }).catch((err) => {
        this.logger.error(
          `Stale-task termination handling for ${task.id} failed: ${(err as Error).message}`,
        );
      });
      // AFTER termination hooks (they read payload.onComplete /
      // payload.sourceTaskId / payload.backupId) — drop in-flight secrets.
      if (AgentService.SENSITIVE_PAYLOAD_TYPES.has(String(task.type))) {
        await this.scrubTerminalPayload(task.id, task.payload);
      }
    }
  }

  async getTask(taskId: string) {
    const task = await this.prisma.agentTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  /**
   * Operator-facing task read (GET /agent/tasks/:id). Several fields can carry
   * sensitive operational data:
   *  - `payload` holds BACKUP/RESTORE database credentials while in flight.
   *  - `result` captures `docker exec` stdout/stderr (EXEC runs, file/DB ops)
   *    and `error` the failure output — either can echo secrets, env dumps,
   *    or file contents from ANOTHER tenant's task.
   *
   * AgentTask has no project column and the only ownership link (via the
   * task's serverId / payload) is inconsistent across task types, so there is
   * no reliable per-project check to apply here. Because `AgentTask.id` is a
   * non-enumerable cuid, a non-admin can still hit this with a task id learned
   * from logs/referrals — a cross-tenant IDOR (M-1). We therefore fail closed:
   * only platform ADMIN/SUPERADMIN see payload/result/error; everyone else
   * gets the non-sensitive status projection (id/type/status/timestamps) the
   * dashboard consumes, with payload AND result/error omitted.
   */
  async getTaskForUser(taskId: string, role: string | undefined) {
    const task = await this.getTask(taskId);
    if (role === 'ADMIN' || role === 'SUPERADMIN') return task;
    return {
      id: task.id,
      type: task.type,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    };
  }

  /**
   * Replace a terminal task's stored payload with a minimal stub so secrets
   * (BACKUP/RESTORE database credentials) never linger in agent_tasks after
   * completion. MUST run AFTER handleTaskTermination — the termination hooks
   * read payload.onComplete / payload.sourceTaskId / payload.backupId. Only
   * `sourceTaskId` survives (it stays useful for transfer-dir correlation),
   * plus a `scrubbed` marker so operators understand why the payload is gone.
   */
  private async scrubTerminalPayload(taskId: string, payload: any): Promise<void> {
    const scrubbed: { scrubbed: true; sourceTaskId?: string } = { scrubbed: true };
    if (typeof payload?.sourceTaskId === 'string') {
      scrubbed.sourceTaskId = payload.sourceTaskId;
    }
    await this.prisma.agentTask
      .update({ where: { id: taskId }, data: { payload: scrubbed } })
      .catch((err) => {
        this.logger.error(
          `Failed to scrub payload of terminal task ${taskId}: ${(err as Error).message}`,
        );
      });
  }

  /**
   * Decrypt the credential fields of a sensitive (BACKUP/RESTORE) payload
   * just before handing the task to the agent. The DB only ever stores the
   * encrypted form (backups.service encrypts at enqueue time); the agent
   * receives plaintext over its authenticated HTTPS poll. Convention: every
   * `password` field inside `payload.databases[]`. decrypt() passes
   * non-`v1.`-prefixed values through unchanged, so legacy plaintext
   * payloads (enqueued before this hardening) keep working.
   */
  private decryptPayloadCredentials(type: string, payload: any): any {
    if (!AgentService.SENSITIVE_PAYLOAD_TYPES.has(type)) return payload;
    if (!payload || !Array.isArray(payload.databases)) return payload;
    return {
      ...payload,
      databases: payload.databases.map((db: any) =>
        db && typeof db.password === 'string'
          ? { ...db, password: this.encryption.decrypt(db.password) }
          : db,
      ),
    };
  }

  /**
   * Enqueue a task for an agent to pick up. Used by ApplicationsService etc.
   * for remote servers (server.host !== 127.0.0.1).
   */
  async enqueueTask(serverId: string, type: AgentTaskType, payload: any) {
    return this.prisma.agentTask.create({
      data: { serverId, type, status: 'QUEUED', payload },
    });
  }

  /**
   * Enqueue a task and wait for the agent to report a result (or timeout).
   * Polls the DB every 500ms; returns the AgentTask once status is terminal.
   */
  async enqueueAndWait(
    serverId: string,
    type: AgentTaskType,
    payload: any,
    timeoutMs = 300_000,
  ) {
    const task = await this.enqueueTask(serverId, type, payload);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const fresh = await this.prisma.agentTask.findUnique({ where: { id: task.id } });
      if (!fresh) throw new NotFoundException('Task vanished');
      if (fresh.status === 'COMPLETED' || fresh.status === 'FAILED') return fresh;
    }
    throw new RequestTimeoutException(`Agent task ${task.id} (${type}) timed out`);
  }

  /**
   * Agent calls this at boot with the install token to claim a server slot.
   * Returns a long-lived token (and the same serverId) the agent then uses
   * for all subsequent calls.
   */
  async register(
    installToken: string,
    payload: { host: string; hostname: string; os: string; arch: string; cpuCores: number; totalMemory: number },
  ) {
    if (!installToken) throw new UnauthorizedException('Missing install token');
    // Install tokens are stored as sha256 hashes; lookup is by hash. The
    // freshly-minted long-lived token is the only plaintext copy.
    //
    // Single-use enforcement via conditional UPDATE: two concurrent
    // register() calls cannot both succeed because only one updateMany
    // matches the row where token === installHash (after the first one
    // updates it to the new hash, the second's predicate misses).
    const installHash = this.encryption.hash(installToken);
    const candidate = await this.prisma.agentToken.findFirst({
      where: { token: installHash },
      include: { server: true },
    });
    if (!candidate) throw new UnauthorizedException('Invalid install token');
    if (candidate.expiresAt && candidate.expiresAt < new Date()) {
      throw new UnauthorizedException('Install token expired');
    }
    const newToken = randomBytes(32).toString('hex');
    const newHash = this.encryption.hash(newToken);
    const claim = await this.prisma.agentToken.updateMany({
      where: { id: candidate.id, token: installHash },
      data: { token: newHash, expiresAt: null },
    });
    if (claim.count === 0) {
      // Lost the race — another register() already consumed the install token.
      throw new UnauthorizedException('Install token already consumed.');
    }
    const token = candidate;
    await this.prisma.server.update({
      where: { id: token.serverId },
      data: {
        host: payload.host,
        name: token.server.name === 'pending' ? payload.hostname : token.server.name,
        os: payload.os,
        arch: payload.arch,
        cpuCores: payload.cpuCores,
        totalMemory: BigInt(payload.totalMemory),
        status: 'ONLINE',
        // agentVersion intentionally not set here — the first heartbeat
        // reports the ldflags-stamped binary version (single source of truth).
        lastSeenAt: new Date(),
      },
    });
    return { serverId: token.serverId, token: newToken };
  }

  private async validateToken(serverId: string, token: string) {
    if (!token) throw new UnauthorizedException('Missing agent token');
    const hash = this.encryption.hash(token);
    const agentToken = await this.prisma.agentToken.findFirst({
      where: { serverId, token: hash },
    });
    if (!agentToken) throw new UnauthorizedException('Invalid agent token');
    return agentToken;
  }

  /**
   * Atomically claim queued tasks for this server. Uses a Postgres CTE so two
   * concurrent agents sharing the same token cannot pick up the same task.
   */
  async poll(serverId: string, token: string) {
    await this.validateToken(serverId, token);

    // Touch lastSeen so the dashboard reflects an active agent even when no
    // heartbeat has fired yet.
    await this.prisma.server.update({
      where: { id: serverId },
      data: { lastSeenAt: new Date(), status: 'ONLINE' },
    }).catch(() => {});

    // SELECT ... FOR UPDATE SKIP LOCKED + UPDATE in one round-trip.
    const claimed = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; type: string; payload: any }>
    >(
      `
      WITH claimed AS (
        SELECT id FROM agent_tasks
         WHERE "serverId" = $1 AND status = 'QUEUED'
         ORDER BY "createdAt" ASC
         LIMIT 10
         FOR UPDATE SKIP LOCKED
      )
      UPDATE agent_tasks t
         SET status = 'RUNNING'::"TaskStatus", "startedAt" = NOW()
        FROM claimed
       WHERE t.id = claimed.id
      RETURNING t.id, t.type::text AS type, t.payload;
      `,
      serverId,
    );

    // Sensitive payloads (BACKUP/RESTORE) store credentials encrypted at
    // rest — decrypt them only here, at the moment the task is handed to
    // the authenticated agent.
    return {
      tasks: claimed.map((t) => ({
        ...t,
        payload: this.decryptPayloadCredentials(t.type, t.payload),
      })),
    };
  }

  async heartbeat(
    serverId: string,
    token: string,
    data: {
      agentVersion: string;
      os: string;
      arch: string;
      uptime: number;
      metrics: any;
      /** Live docker states of dockcontrol-managed containers (agent ≥ this
       *  release). Lets the dashboard show real RUNNING/STOPPED for remote
       *  apps without per-request agent round-trips. */
      containers?: Array<{ name: string; state: string }>;
    },
  ) {
    await this.validateToken(serverId, token);
    await this.prisma.server.update({
      where: { id: serverId },
      data: {
        status: 'ONLINE',
        agentVersion: data.agentVersion,
        os: data.os,
        arch: data.arch,
        lastSeenAt: new Date(),
      },
    });
    if (data.metrics) {
      await this.prisma.serverMetric.create({
        data: {
          serverId,
          cpuPercent: data.metrics.cpuPercent ?? 0,
          memoryUsed: BigInt(data.metrics.memoryUsed ?? 0),
          memoryTotal: BigInt(data.metrics.memoryTotal ?? 0),
          diskUsed: BigInt(data.metrics.diskUsed ?? 0),
          diskTotal: BigInt(data.metrics.diskTotal ?? 0),
          networkIn: BigInt(data.metrics.networkIn ?? 0),
          networkOut: BigInt(data.metrics.networkOut ?? 0),
        },
      });
    }
    if (Array.isArray(data.containers)) {
      await this.syncRemoteAppStatuses(serverId, data.containers).catch((e) =>
        this.logger.warn(`heartbeat status sync failed: ${(e as Error).message}`),
      );
    }
    return { ok: true };
  }

  /**
   * Mirror live container states from a heartbeat onto the Application rows
   * of apps resolved to this server. Status mapping: running → RUNNING,
   * anything else (exited/dead/restarting) → STOPPED. Apps mid-deploy are
   * left alone (DEPLOYING is owned by the deploy pipeline). A container
   * missing from the list = stack is down → STOPPED.
   */
  private async syncRemoteAppStatuses(
    serverId: string,
    containers: Array<{ name: string; state: string }>,
  ): Promise<void> {
    const apps = await this.prisma.application.findMany({
      where: {
        status: { in: ['RUNNING', 'STOPPED', 'ERROR'] },
        OR: [
          { serverId },
          { serverId: null, project: { serverId } },
        ],
      },
      select: { id: true, status: true, containerName: true },
    });
    if (apps.length === 0) return;
    const stateByName = new Map(containers.map((c) => [c.name, c.state.toLowerCase()]));
    for (const app of apps) {
      if (!app.containerName) continue;
      const state = stateByName.get(app.containerName);
      // ERROR rows only flip when we SEE the container running (a recovery)
      // — absence keeps the ERROR so the user still sees the failed deploy.
      const real = state === 'running' ? 'RUNNING' : app.status === 'ERROR' && state === undefined ? 'ERROR' : 'STOPPED';
      if (real !== app.status) {
        await this.prisma.application.update({
          where: { id: app.id },
          data: { status: real as any },
        }).catch(() => {});
      }
    }
  }

  async taskResult(
    taskId: string,
    serverId: string,
    token: string,
    status: string,
    result?: any,
    error?: string,
  ) {
    // Authenticate the reporting agent first.
    await this.validateToken(serverId, token);

    if (status !== 'COMPLETED' && status !== 'FAILED') {
      throw new BadRequestException('Invalid status (expected COMPLETED or FAILED)');
    }
    // The task must belong to the server the agent claims to run on.
    const task = await this.prisma.agentTask.findUnique({
      where: { id: taskId },
      select: { id: true, serverId: true, status: true, type: true, payload: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (task.serverId !== serverId) {
      throw new UnauthorizedException('Task does not belong to this server.');
    }
    // Idempotent: once COMPLETED/FAILED, reject further mutations.
    if (task.status === 'COMPLETED' || task.status === 'FAILED') {
      return { ok: true, alreadyFinalized: true };
    }

    // Cap stored result size to defend against agent flooding the DB with
    // multi-MB JSON blobs, AND redact any git credential the agent echoed into
    // its deploy logs (defense-in-depth behind poller.go's own redaction —
    // covers old agent binaries). Redaction runs on the serialized form so it
    // reaches `logs` wherever it sits in the result shape.
    let safeResult: any = result;
    try {
      const redacted = redactAgentSecrets(JSON.stringify(result ?? null));
      if (redacted.length > 500_000) {
        safeResult = { truncated: true, head: redacted.slice(0, 500_000) };
      } else {
        safeResult = JSON.parse(redacted);
      }
    } catch {
      safeResult = { error: 'unserializable agent result' };
    }
    const safeError = error ? redactAgentSecrets(String(error)).slice(0, 50_000) : null;

    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status: status as any,
        result: safeResult ?? undefined,
        error: safeError,
        completedAt: new Date(),
      },
    });

    // Post-terminal hooks (chaining, completion handlers, transfer cleanup)
    // never break the agent's ACK — failures are logged server-side instead.
    await this.handleTaskTermination({
      id: task.id,
      serverId: task.serverId,
      type: String(task.type),
      payload: task.payload,
      status: status as 'COMPLETED' | 'FAILED',
      result: safeResult,
      error: safeError,
    }).catch((err) => {
      this.logger.error(
        `Post-completion handling for task ${taskId} failed: ${(err as Error).message}`,
      );
    });

    // AFTER handleTaskTermination (which reads payload.onComplete /
    // payload.sourceTaskId and feeds completion handlers payload.backupId):
    // scrub in-flight secrets (BACKUP/RESTORE DB credentials) from the row.
    if (AgentService.SENSITIVE_PAYLOAD_TYPES.has(String(task.type))) {
      await this.scrubTerminalPayload(task.id, task.payload);
    }

    return { ok: true };
  }

  // ─── task chaining + completion hooks ──────────────────────────────

  /**
   * Register a completion hook for a TaskType — invoked after EVERY terminal
   * (COMPLETED or FAILED) result of that type. Used by BackupsService to
   * finalize remote BACKUP dumps without the agent module knowing anything
   * about backups.
   */
  registerTaskCompletionHandler(type: AgentTaskType, handler: AgentTaskCompletionHandler) {
    this.completionHandlers.set(type, handler);
  }

  /**
   * Generic chaining: when a COMPLETED task's payload carries
   * `onComplete: [{serverId, type, payload}]`, enqueue those tasks. The first
   * chained payload is augmented with `sourceTaskId` (defaulting to the
   * completed task's id) so download-style consumers (VOLUME_IMPORT, RESTORE)
   * know where to pull from. FAILED tasks never chain — the failure is logged
   * and the staged transfer dir is dropped.
   */
  private async handleTaskTermination(task: AgentTaskCompletion): Promise<void> {
    const onComplete: any[] = Array.isArray(task.payload?.onComplete)
      ? task.payload.onComplete
      : [];

    let chained = false;
    if (task.status === 'COMPLETED' && onComplete.length > 0) {
      const [next, ...rest] = onComplete;
      if (next?.serverId && next?.type) {
        // Transfer-consuming task types get the source pointer defaulted to
        // the just-completed task's id (whose transfers/ dir holds the
        // staged files); explicit values win. Other types (DEPLOY etc.) are
        // chained verbatim.
        const consumesTransfers = next.type === 'VOLUME_IMPORT' || next.type === 'RESTORE';
        try {
          await this.enqueueTask(next.serverId, next.type, {
            ...(next.payload ?? {}),
            ...(consumesTransfers
              ? { sourceTaskId: next.payload?.sourceTaskId ?? task.id }
              : {}),
            // Propagate the remainder of the chain.
            ...(rest.length > 0 ? { onComplete: rest } : {}),
          });
          chained = true;
        } catch (err) {
          this.logger.error(
            `Task ${task.id} (${task.type}) completed but chaining ${next.type} on ` +
              `${next.serverId} failed: ${(err as Error).message}`,
          );
        }
      } else {
        this.logger.warn(
          `Task ${task.id} has a malformed onComplete entry — chain dropped.`,
        );
      }
    } else if (task.status === 'FAILED' && onComplete.length > 0) {
      this.logger.warn(
        `Task ${task.id} (${task.type}) FAILED — dropping ${onComplete.length} chained task(s): ${task.error ?? 'no error reported'}`,
      );
    }

    // Module-level completion hook (e.g. backups finalizer).
    const handler = this.completionHandlers.get(task.type);
    if (handler) {
      try {
        await handler(task);
      } catch (err) {
        this.logger.error(
          `Completion handler for ${task.type} (task ${task.id}) failed: ${(err as Error).message}`,
        );
      }
    }

    // Transfer cleanup. The chain owns two staging dirs at most:
    //   - transfers/<payload.sourceTaskId>: this task's INPUT — consumed (or
    //     abandoned on failure) the moment the task terminates.
    //   - transfers/<task.id>: this task's OUTPUT — still needed if a chained
    //     task will download from it; otherwise the chain ends here.
    if (typeof task.payload?.sourceTaskId === 'string') {
      await this.cleanupTransfers(task.payload.sourceTaskId);
    }
    if (!chained) {
      await this.cleanupTransfers(task.id);
    }
  }

  // ─── file transfers (.dockcontrol/transfers/<taskId>/<name>) ─────────

  /** Max bytes a single transfer upload may carry (configurable via env). */
  get transferMaxBytes(): number {
    return TRANSFER_MAX_BYTES;
  }

  /**
   * Validate an agent transfer request (upload or download) and resolve the
   * sanitized on-disk file path. Checks, in order:
   *   1. (serverId, token) is a valid agent pair.
   *   2. `name` survives path.basename() unchanged (no traversal/separators).
   *   3. The task exists, and either belongs to the calling server, or — for
   *      downloads — the calling server holds a live (QUEUED/RUNNING) task
   *      whose payload.sourceTaskId references it (cross-server pulls:
   *      VOLUME_IMPORT / RESTORE consuming another server's staged output).
   */
  async resolveTransferPath(
    taskId: string,
    serverId: string,
    token: string,
    name: string,
    direction: 'upload' | 'download',
  ): Promise<string> {
    await this.validateToken(serverId, token);

    if (!name || typeof name !== 'string') {
      throw new BadRequestException('name query param required');
    }
    const safeName = path.basename(name);
    if (safeName !== name || safeName === '.' || safeName === '..') {
      throw new BadRequestException('Invalid file name');
    }

    const task = await this.prisma.agentTask.findUnique({
      where: { id: taskId },
      select: { id: true, serverId: true },
    });
    if (!task || task.serverId !== serverId) {
      // Two legitimate non-owner cases, both download-only:
      //   - cross-server pull: the transfer was staged under ANOTHER server's
      //     task id (VOLUME_EXPORT output consumed by VOLUME_IMPORT);
      //   - locally-staged dir: the API staged files under a `local-<uuid>`
      //     id that has no AgentTask row at all (local-source export, remote
      //     RESTORE archive).
      // Either way the calling server must hold a live task that explicitly
      // references the transfer as its payload.sourceTaskId.
      if (!task && direction === 'upload') {
        throw new NotFoundException('Task not found');
      }
      if (direction === 'upload') {
        throw new UnauthorizedException('Task does not belong to this server.');
      }
      const consumer = await this.prisma.agentTask.findFirst({
        where: {
          serverId,
          status: { in: ['QUEUED', 'RUNNING'] as any },
          payload: { path: ['sourceTaskId'], equals: taskId },
        },
        select: { id: true },
      });
      if (!consumer) {
        if (!task) throw new NotFoundException('Task not found');
        throw new UnauthorizedException('Task does not belong to this server.');
      }
    }

    // taskId was matched against a DB row or a payload.sourceTaskId above —
    // basename() defensively in case either ever carries a separator.
    return path.join(TRANSFERS_DIR, path.basename(taskId), safeName);
  }

  /** Staging dir for a task chain — used by API-side (local) export/import. */
  transferDir(taskId: string): string {
    return path.join(TRANSFERS_DIR, taskId);
  }

  /** Mint an id for a locally-staged transfer dir that has no AgentTask row
   *  (e.g. local-source volume export). Prefixed so it can't collide with
   *  cuid task ids. */
  newLocalTransferId(): string {
    return `local-${randomUUID()}`;
  }

  /** Remove transfers/<taskId>/ entirely. Idempotent, best-effort. */
  async cleanupTransfers(taskId: string): Promise<void> {
    // Defensive: never let a crafted id escape the transfers root.
    const safe = path.basename(taskId);
    if (!safe || safe !== taskId) return;
    await fs.promises
      .rm(path.join(TRANSFERS_DIR, safe), { recursive: true, force: true })
      .catch(() => undefined);
  }
}
