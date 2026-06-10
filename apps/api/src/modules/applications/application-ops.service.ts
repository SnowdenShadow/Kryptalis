import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppStatus } from '@prisma/client';
import { AgentService } from '../agent/agent.service';
import { DeploymentTargetService } from '../deployment-target/deployment-target.service';
import { ApplicationDeployService } from './application-deploy.service';
import { ApplicationEnvService } from './application-env.service';
import {
  execFileAsync,
  slugify,
  resolveAppDir,
  resolveContainerName,
  dockerCompose,
  findComposePath,
  resolveAppServer,
  isAppLocal,
  assertAppOwnership,
} from './applications.helpers';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

/**
 * Runtime operations on applications: start/stop/restart, redeploy,
 * logs, in-container exec, compose/Dockerfile file editing, and the
 * docker-ps status sync. Split out of ApplicationsService.
 */
@Injectable()
export class ApplicationOpsService {
  constructor(
    private prisma: PrismaService,
    private agent: AgentService,
    private encryption: EncryptionService,
    private deploymentTarget: DeploymentTargetService,
    private deploy: ApplicationDeployService,
    private env: ApplicationEnvService,
  ) {}

  // ── lifecycle ──────────────────────────────────────────────────────

  async start(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await resolveAppServer(this.prisma, id);
    const appDir = resolveAppDir(slug, id);
    // Local: skip if the app dir was never materialized (no compose to run).
    // Remote: always dispatch — the agent owns dir state on its host.
    if (!this.deploymentTarget.isLocal(server) || fs.existsSync(appDir)) {
      await this.deploymentTarget.composeUp(server, appDir);
    }
    // Don't blindly flip the DB to RUNNING — the docker compose call returned
    // 0, but the container might still be crashlooping. syncStatus reads the
    // real docker ps state.
    return this.refreshAndReturn(id);
  }

  async stop(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await resolveAppServer(this.prisma, id);
    const appDir = resolveAppDir(slug, id);
    if (!this.deploymentTarget.isLocal(server) || fs.existsSync(appDir)) {
      await this.deploymentTarget.composeStop(server, appDir);
    }
    return this.refreshAndReturn(id);
  }

  async restart(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await resolveAppServer(this.prisma, id);
    const appDir = resolveAppDir(slug, id);
    if (!this.deploymentTarget.isLocal(server) || fs.existsSync(appDir)) {
      await this.deploymentTarget.composeRestart(server, appDir);
    }
    return this.refreshAndReturn(id);
  }

  /**
   * Reload the app from DB and run the real docker-ps check, so the
   * returned status reflects the container's actual state (not what we
   * asked it to do). Used by start/stop/restart so a click doesn't flip
   * the UI to RUNNING when the container is in fact crashlooping.
   */
  private async refreshAndReturn(id: string) {
    const fresh = await this.prisma.application.findUnique({ where: { id } });
    if (!fresh) throw new NotFoundException('Application not found');
    return this.syncStatus(fresh);
  }

  async redeploy(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id, 'DEVELOPER');

    // Concurrency guard. Two redeploys in flight at the same time race for
    // the app dir, clobber compose files mid-build, and produce conflicting
    // Deployment rows. Refuse a second one while a fresh deployment is
    // still PENDING/BUILDING/DEPLOYING. A stuck DEPLOYING older than 30
    // minutes is treated as crashed and overridden.
    // Filter on createdAt — startedAt is null until the worker actually
    // picks up the job, and that's exactly the small window we MUST
    // protect against (the gap between row insert and the build step
    // wiping the app dir is when a second redeploy click would conflict).
    const inflight = await this.prisma.deployment.findFirst({
      where: {
        applicationId: id,
        status: { in: ['PENDING', 'BUILDING', 'DEPLOYING'] as any },
        createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (inflight) {
      throw new ConflictException(
        `A deployment is already running (status: ${inflight.status}). Wait for it to finish or cancel it first.`,
      );
    }

    // Docker-image-only app: re-pull + recreate. No git clone needed.
    if (!app.gitUrl && app.dockerImage) {
      const deployment = await this.prisma.deployment.create({
        data: { applicationId: app.id, status: 'PENDING', triggeredById: userId },
      });
      await this.deploy.runDockerImageDeploy(deployment.id, app.id, app.name, app.dockerImage, {
        port: app.port ?? undefined,
        hostPort: app.hostPort ?? undefined,
        envVars: this.env.decryptEnvVars(app.envVars),
      });
      return { message: 'Image re-pulled and stack recreated', deploymentId: deployment.id };
    }

    if (!app.gitUrl) {
      throw new BadRequestException('Application has no git URL or docker image to redeploy from');
    }

    // resolve auth header from the persisted git provider — providers stay private per user,
    // BUT any project member can redeploy using the connector chosen at create time.
    // (The token itself is never exposed back to the requester.)
    let cloneHeader: string | undefined;
    if (app.gitProviderId) {
      const gp = await this.prisma.gitProvider.findUnique({
        where: { id: app.gitProviderId },
      });
      if (gp) cloneHeader = this.deploy.buildAuthHeader(gp.provider, this.encryption.decrypt(gp.token));
    }

    const deployment = await this.prisma.deployment.create({
      data: { applicationId: id, status: 'PENDING', triggeredById: userId },
    });
    await this.prisma.application.update({
      where: { id },
      data: { status: AppStatus.DEPLOYING },
    });
    this.deploy.runDeploy(deployment.id, id, app.name, app.gitUrl, app.gitBranch || 'main', {
      port: app.port,
      hostPort: app.hostPort ?? undefined,
      envVars: this.env.decryptEnvVars(app.envVars),
      buildCommand: app.buildCommand,
      startCommand: app.startCommand,
      cloneHeader,
      portMapping: (app.portMapping as Record<string, number>) || undefined,
    }).catch(() => {});
    return { message: 'Redeploy triggered', deploymentId: deployment.id };
  }

  // ── logs / exec ────────────────────────────────────────────────────

  async getLogs(userId: string, id: string, lines = 100) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    const slug = slugify(app.name);
    const server = await resolveAppServer(this.prisma, id);
    if (!isAppLocal(server) && server) {
      try {
        const task = await this.agent.enqueueAndWait(server.id, 'LOGS', { slug, lines }, 30_000);
        if (task.status === 'FAILED') return { logs: task.error || 'Agent failed to fetch logs' };
        const r: any = task.result;
        return { logs: r?.logs || 'No output yet.' };
      } catch (err: any) {
        return { logs: err?.message || 'Failed to fetch logs from agent' };
      }
    }
    const appDir = resolveAppDir(slug, id);
    if (!fs.existsSync(appDir)) {
      return { logs: 'No logs available — app has no Docker compose directory.' };
    }
    try {
      const { stdout, stderr } = await dockerCompose(
        appDir,
        ['logs', '--tail', String(lines), '--no-color'],
        undefined,
        15_000,
      );
      return { logs: stdout || stderr || 'No output yet.' };
    } catch (err: any) {
      return { logs: err?.stderr || err?.message || 'Failed to fetch logs.' };
    }
  }

  // shell-free exec, no string interpolation
  async execCommand(userId: string, id: string, command: string) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    const slug = slugify(app.name);
    const cname = resolveContainerName(slug, id);
    const server = await resolveAppServer(this.prisma, id);

    if (!isAppLocal(server) && server) {
      try {
        const task = await this.agent.enqueueAndWait(
          server.id,
          'EXEC',
          { slug, containerName: cname, command },
          60_000,
        );
        if (task.status === 'FAILED') {
          return { output: task.error || 'Agent failed', exitCode: 1 };
        }
        const r: any = task.result;
        return { output: r?.output || '', exitCode: r?.exitCode ?? 0 };
      } catch (err: any) {
        return { output: err?.message || 'exec timeout', exitCode: 1 };
      }
    }

    const shells = ['/bin/sh', '/bin/bash', 'sh', 'bash'];
    for (const shell of shells) {
      try {
        const { stdout, stderr } = await execFileAsync(
          'docker',
          ['exec', cname, shell, '-c', command],
          { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
        );
        return { output: stdout + (stderr ? `\n${stderr}` : ''), exitCode: 0 };
      } catch (err: any) {
        const allMsg = `${err?.stderr || ''} ${err?.message || ''} ${err?.stdout || ''}`.toLowerCase();
        if (
          allMsg.includes('not found') ||
          allMsg.includes('no such file') ||
          allMsg.includes('executable file')
        ) {
          continue;
        }
        return {
          output: err?.stdout || err?.stderr || err?.message || 'Command failed',
          exitCode: err?.code || 1,
        };
      }
    }
    return {
      output:
        '⚠️ This container does not have a shell (scratch/distroless image).\nTerminal is not available for this application.\nUse the Logs tab to view container output.',
      exitCode: -1,
    };
  }

  // ── files: compose / Dockerfile ────────────────────────────────────

  async readComposeFile(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    const appDir = resolveAppDir(slugify(app.name), id);
    const p = findComposePath(appDir);
    if (!p) return { exists: false, content: '', path: null };
    return {
      exists: true,
      content: fs.readFileSync(p, 'utf-8'),
      path: path.basename(p),
    };
  }

  async writeComposeFile(userId: string, id: string, content: string) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    if (typeof content !== 'string') throw new BadRequestException('content required');
    // validate yaml
    try { yaml.load(content); } catch (e: any) {
      throw new BadRequestException(`Invalid YAML: ${e?.message || e}`);
    }
    const appDir = resolveAppDir(slugify(app.name), id);
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
    const target = findComposePath(appDir) || path.join(appDir, 'docker-compose.yml');
    fs.writeFileSync(target, content);
    return { message: 'Compose updated', path: path.basename(target) };
  }

  async readDockerfile(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    const appDir = resolveAppDir(slugify(app.name), id);
    const p = path.join(appDir, 'Dockerfile');
    if (!fs.existsSync(p)) return { exists: false, content: '' };
    return { exists: true, content: fs.readFileSync(p, 'utf-8') };
  }

  async writeDockerfile(userId: string, id: string, content: string) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    if (typeof content !== 'string') throw new BadRequestException('content required');
    const appDir = resolveAppDir(slugify(app.name), id);
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Dockerfile'), content);
    return { message: 'Dockerfile updated' };
  }

  // ── status sync ────────────────────────────────────────────────────

  async syncStatus(app: any) {
    if (app.status === 'DEPLOYING') return app;
    const appDir = resolveAppDir(slugify(app.name), app.id);
    if (!fs.existsSync(appDir)) return app;
    try {
      const { stdout } = await dockerCompose(appDir, ['ps', '--format', 'json'], undefined, 10_000);
      if (!stdout.trim()) {
        if (app.status !== 'STOPPED') {
          await this.prisma.application.update({
            where: { id: app.id },
            data: { status: 'STOPPED' },
          });
          return { ...app, status: 'STOPPED' };
        }
        return app;
      }
      const running = stdout
        .split('\n')
        .filter(Boolean)
        .some((line) => {
          try {
            return JSON.parse(line).State === 'running';
          } catch {
            return line.includes('running');
          }
        });
      const realStatus = running ? 'RUNNING' : 'STOPPED';
      if (app.status !== realStatus) {
        await this.prisma.application.update({
          where: { id: app.id },
          data: { status: realStatus },
        });
        return { ...app, status: realStatus };
      }
    } catch {}
    return app;
  }
}
