import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  RequestTimeoutException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { randomBytes } from 'crypto';
import { TaskType } from '@prisma/client';

export type AgentTaskType = keyof typeof TaskType;

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
 */
@Injectable()
export class AgentService {
  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  async getTask(taskId: string) {
    const task = await this.prisma.agentTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    return task;
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
    // Install tokens are stored as sha256 hashes too — register lookup is
    // by hash. The fresh token returned to the agent is the only plaintext
    // copy that ever exists in memory.
    const installHash = this.encryption.hash(installToken);
    const token = await this.prisma.agentToken.findFirst({
      where: { token: installHash },
      include: { server: true },
    });
    if (!token) throw new UnauthorizedException('Invalid install token');
    if (token.expiresAt && token.expiresAt < new Date()) {
      throw new UnauthorizedException('Install token expired');
    }
    // Issue a long-lived agent token (raw, returned once) and persist its
    // hash. Any later poll/heartbeat/result call provides the raw token
    // which we hash for lookup.
    const newToken = randomBytes(32).toString('hex');
    const newHash = this.encryption.hash(newToken);
    await this.prisma.agentToken.update({
      where: { id: token.id },
      data: { token: newHash, expiresAt: null },
    });
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
        agentVersion: '0.1.0',
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

    return { tasks: claimed };
  }

  async heartbeat(
    serverId: string,
    token: string,
    data: { agentVersion: string; os: string; arch: string; uptime: number; metrics: any },
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
    return { ok: true };
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
      select: { id: true, serverId: true, status: true },
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
    // multi-MB JSON blobs.
    let safeResult: any = result;
    try {
      const serialized = JSON.stringify(result ?? null);
      if (serialized.length > 500_000) {
        safeResult = { truncated: true, head: serialized.slice(0, 500_000) };
      }
    } catch {
      safeResult = { error: 'unserializable agent result' };
    }
    const safeError = error ? String(error).slice(0, 50_000) : null;

    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status: status as any,
        result: safeResult ?? undefined,
        error: safeError,
        completedAt: new Date(),
      },
    });
    return { ok: true };
  }
}
