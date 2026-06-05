import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  RequestTimeoutException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { randomBytes } from 'crypto';
import { TaskType } from '@prisma/client';

export type AgentTaskType = keyof typeof TaskType;

@Injectable()
export class AgentService {
  constructor(private prisma: PrismaService) {}

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
    const token = await this.prisma.agentToken.findFirst({
      where: { token: installToken },
      include: { server: true },
    });
    if (!token) throw new UnauthorizedException('Invalid install token');
    if (token.expiresAt && token.expiresAt < new Date()) {
      throw new UnauthorizedException('Install token expired');
    }
    // upgrade the install token to a long-lived one
    const newToken = randomBytes(32).toString('hex');
    await this.prisma.agentToken.update({
      where: { id: token.id },
      data: { token: newToken, expiresAt: null },
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
    const agentToken = await this.prisma.agentToken.findFirst({
      where: { serverId, token },
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

  async taskResult(taskId: string, status: string, result?: any, error?: string) {
    if (status !== 'COMPLETED' && status !== 'FAILED') {
      throw new UnauthorizedException('Invalid status (expected COMPLETED or FAILED)');
    }
    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status: status as any,
        result: result ?? undefined,
        error: error || null,
        completedAt: new Date(),
      },
    });
    return { ok: true };
  }
}
