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
import { DEFAULT_PHP_VERSION } from './php-site.constants';
import { ApplicationEnvService } from './application-env.service';
import {
  execFileAsync,
  slugify,
  remoteAppSlug,
  resolveAppDir,
  resolveContainerName,
  dockerCompose,
  findComposePath,
  resolveAppServer,
  isAppLocal,
  assertAppOwnership,
  projectNetworkName,
  APPS_DIR,
} from './applications.helpers';
import { assertCloneHostAllowed } from '../git-providers/git-providers.service';
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
    // remote slug/legacySlug = the agent's per-instance dir naming + the
    // bare-slug fallback for pre-convention deploys.
    if (!this.deploymentTarget.isLocal(server) || fs.existsSync(appDir)) {
      await this.deploymentTarget.composeUp(server, appDir, {
        slug: remoteAppSlug(app.name, id),
        legacySlug: slug,
      });
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
      await this.deploymentTarget.composeStop(server, appDir, {
        slug: remoteAppSlug(app.name, id),
        legacySlug: slug,
      });
    }
    return this.refreshAndReturn(id);
  }

  async restart(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await resolveAppServer(this.prisma, id);
    const appDir = resolveAppDir(slug, id);
    if (!this.deploymentTarget.isLocal(server) || fs.existsSync(appDir)) {
      await this.deploymentTarget.composeRestart(server, appDir, {
        slug: remoteAppSlug(app.name, id),
        legacySlug: slug,
      });
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

  /**
   * Concurrency guard. Two deploys in flight at the same time race for
   * the app dir, clobber compose files mid-build, and produce conflicting
   * Deployment rows. Refuse a second one while a fresh deployment is
   * still PENDING/BUILDING/DEPLOYING. A stuck DEPLOYING older than 30
   * minutes is treated as crashed and overridden.
   * Filter on createdAt — startedAt is null until the worker actually
   * picks up the job, and that's exactly the small window we MUST
   * protect against (the gap between row insert and the build step
   * wiping the app dir is when a second redeploy click would conflict).
   */
  private async assertNoInflightDeployment(applicationId: string) {
    // NOTE: this is a best-effort check, not a lock. There's an inherent
    // TOCTOU window between this read and the caller's subsequent
    // deployment.create() — two near-simultaneous redeploys can both pass.
    // A real fix needs a DB-level unique partial index on
    // (applicationId, status IN inflight) or an advisory lock; that's a
    // migration we deliberately defer. The build step's .prev snapshot +
    // force-recreate make a double-deploy recover rather than corrupt, so
    // this guard catches the overwhelmingly common double-click case without
    // introducing a race of its own.
    const inflight = await this.prisma.deployment.findFirst({
      where: {
        applicationId,
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
  }

  /**
   * Resolve the git auth header from the persisted git provider — providers
   * stay private per user, BUT any project member can (re)deploy using the
   * connector chosen at create time. (The token itself is never exposed
   * back to the requester.)
   */
  private async resolveCloneHeader(app: {
    gitProviderId: string | null;
    gitUrl: string | null;
  }): Promise<string | undefined> {
    if (!app.gitProviderId) return undefined;
    const gp = await this.prisma.gitProvider.findUnique({
      where: { id: app.gitProviderId },
    });
    if (!gp) return undefined;
    // CRITICAL: enforce HTTPS + provider-host match before injecting the
    // decrypted token into the clone. The redeploy/webhook path looks up the
    // provider by id with no user scope, so without this a member could have
    // stored a gitUrl pointing at an attacker host and exfiltrate the token.
    if (app.gitUrl) assertCloneHostAllowed(gp.provider, app.gitUrl);
    return this.deploy.buildAuthHeader(gp.provider, this.encryption.decrypt(gp.token));
  }

  async redeploy(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id, 'DEVELOPER');

    await this.assertNoInflightDeployment(id);

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

    // PHP_SITE: no git/image — regenerate the php:<ver>-apache stack. Picks up
    // a changed PHP version (rebuilds the image) and leaves the live docroot
    // bind mount (the user's SFTP files) untouched.
    if (app.framework === 'PHP_SITE') {
      const deployment = await this.prisma.deployment.create({
        data: { applicationId: app.id, status: 'PENDING', triggeredById: userId },
      });
      await this.deploy.runPhpSiteDeploy(
        deployment.id,
        app.id,
        app.name,
        app.phpVersion || DEFAULT_PHP_VERSION,
        {
          hostPort: app.hostPort ?? undefined,
          envVars: this.env.decryptEnvVars(app.envVars),
          webServer: (app as any).phpWebServer === 'nginx' ? 'nginx' : 'apache',
          extensions: ((app as any).phpExtensions || '').split(',').filter(Boolean),
          phpIni: (app as any).phpIni || null,
        },
      );
      return { message: 'PHP site rebuilt and recreated', deploymentId: deployment.id };
    }

    // Marketplace / compose-only app: no git URL, no docker image, but a
    // compose dir on disk. Redeploy = rewrite .env from the saved envVars
    // + `docker compose up -d --force-recreate`. This is what makes the
    // env tab's "save then redeploy" promise actually work for installs.
    if (!app.gitUrl && !app.dockerImage && app.framework === 'DOCKER_COMPOSE') {
      return this.redeployComposeDir(userId, app);
    }

    if (!app.gitUrl) {
      throw new BadRequestException('Application has no git URL or docker image to redeploy from');
    }

    const cloneHeader = await this.resolveCloneHeader(app);

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

  /**
   * Redeploy a compose-dir-only app (marketplace install / pasted compose
   * with no git source). The compose file on disk is the source of truth;
   * we refresh .env from the app's saved (encrypted) envVars and recreate
   * the stack so env changes take effect.
   */
  private async redeployComposeDir(userId: string, app: any) {
    const server = await resolveAppServer(this.prisma, app.id);
    if (!this.deploymentTarget.isLocal(server)) {
      // Remote target: we can't touch the agent's app dir from here, so ship
      // the stored compose + saved envVars to the agent exactly like a
      // marketplace install. The agent writes compose/.env under
      // /opt/dockcontrol/apps/<remoteSlug> and brings the stack up; its DEPLOY
      // completion handler flips the Application row. This is also the building
      // block migrate()/moveServer() use to relocate a compose app's stack.
      //
      // The compose MUST come from the DB (app.dockerComposeFile) — the local
      // APPS_DIR copy is on the platform host, not the agent, so it's the wrong
      // (or missing) file for a remote app. If it was never persisted, there's
      // nothing to ship; tell the user to reinstall.
      const compose: string | null = app.dockerComposeFile;
      if (!compose) {
        throw new BadRequestException(
          'No saved compose file for this app — it cannot be redeployed on the remote server. Reinstall it from the marketplace.',
        );
      }

      const deployment = await this.prisma.deployment.create({
        data: {
          applicationId: app.id,
          status: 'DEPLOYING',
          commitMessage: 'Redeploy (env refresh)',
          triggeredById: userId,
          startedAt: new Date(),
        },
      });

      try {
        // envVars are passed RAW (like marketplace) — the agent writes them to
        // .env on its host. We don't pre-interpolate here the way the local
        // path does: the agent owns the .env merge + compose interpolation.
        const task = await this.agent.enqueueAndWait(
          server!.id,
          'DEPLOY',
          {
            slug: remoteAppSlug(app.name, app.id),
            appName: app.name,
            applicationId: app.id,
            compose,
            envVars: this.env.decryptEnvVars(app.envVars),
            projectNetwork: projectNetworkName(app.projectId),
          },
          15 * 60_000,
        );
        if (task.status === 'FAILED') {
          throw new Error(task.error || 'agent deploy failed');
        }
        await this.prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'RUNNING', finishedAt: new Date() },
        });
        await this.prisma.application.update({
          where: { id: app.id },
          data: { status: 'RUNNING' },
        });
        return {
          message: 'Stack recreated with the updated environment',
          deploymentId: deployment.id,
        };
      } catch (err: any) {
        await this.prisma.deployment.update({
          where: { id: deployment.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            buildLogs: String(err?.message || err).slice(0, 50_000),
          },
        });
        await this.prisma.application.update({
          where: { id: app.id },
          data: { status: 'ERROR' },
        });
        throw new BadRequestException(
          `Redeploy failed: ${String(err?.message || err).slice(0, 500)}`,
        );
      }
    }

    // Marketplace installs write into <catalogSlug>-<id12>, which diverges
    // from slugify(app.name) for renamed/suffixed installs ("WordPress 2").
    // Custom-image installs use custom-<id12>. Scan for the per-instance
    // suffix first; resolveAppDir covers the plain cases.
    const id12 = app.id.slice(0, 12);
    let appDir = resolveAppDir(slugify(app.name), app.id);
    if (!findComposePath(appDir) && fs.existsSync(APPS_DIR)) {
      const match = fs
        .readdirSync(APPS_DIR)
        .find((d) => d.endsWith(`-${id12}`) && findComposePath(path.join(APPS_DIR, d)));
      if (match) appDir = path.join(APPS_DIR, match);
    }
    if (!findComposePath(appDir)) {
      throw new BadRequestException(
        'No compose file found for this app on the server — it may have been removed. Reinstall it from the marketplace.',
      );
    }

    const deployment = await this.prisma.deployment.create({
      data: {
        applicationId: app.id,
        status: 'DEPLOYING',
        commitMessage: 'Redeploy (env refresh)',
        triggeredById: userId,
        startedAt: new Date(),
      },
    });

    // .env refresh: saved envVars are the user-editable layer. We merge them
    // OVER the existing .env (which holds the install-time generated
    // passwords) so deleting a row in the UI doesn't wipe a generated
    // credential the compose still references via ${VAR:-default}.
    const saved = this.env.decryptEnvVars(app.envVars);
    const envPath = path.join(appDir, '.env');
    const existing: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) existing[m[1]] = m[2];
      }
    }
    const merged = { ...existing, ...Object.fromEntries(
      Object.entries(saved).map(([k, v]) => [k, String(v).replace(/\n/g, '\\n')]),
    ) };
    fs.writeFileSync(envPath, Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

    try {
      // --force-recreate: env changes alone don't alter the compose hash,
      // so a plain `up -d` would conclude "nothing to do".
      await dockerCompose(appDir, ['up', '-d', '--force-recreate'], undefined, 300_000);
      await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'RUNNING', finishedAt: new Date() },
      });
      await this.prisma.application.update({ where: { id: app.id }, data: { status: 'RUNNING' } });
      return { message: 'Stack recreated with the updated environment', deploymentId: deployment.id };
    } catch (err: any) {
      await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'FAILED', finishedAt: new Date(), buildLogs: String(err?.message || err).slice(0, 50_000) },
      });
      await this.prisma.application.update({ where: { id: app.id }, data: { status: 'ERROR' } });
      throw new BadRequestException(`Redeploy failed: ${String(err?.message || err).slice(0, 500)}`);
    }
  }

  /**
   * Manual rollback: redeploy the exact commit of an earlier successful
   * deployment. The automatic rollback in the deploy pipeline only fires on
   * a FAILED deploy — this endpoint lets a user revert a deploy that
   * succeeded technically but shipped a bad version.
   *
   * Git-based apps only (a deployment must carry a commitSha to be
   * reproducible). The clone is non-shallow + detached checkout, so the
   * target commit must still be reachable from the configured branch
   * (force-pushed-away commits will fail with a clear log).
   */
  async rollback(userId: string, id: string, deploymentId: string) {
    const app = await assertAppOwnership(this.prisma, userId, id, 'DEVELOPER');

    if (!app.gitUrl) {
      throw new BadRequestException(
        'Rollback requires a git-based application — docker-image apps have no commit history to roll back to.',
      );
    }
    if (!deploymentId) {
      throw new BadRequestException('deploymentId is required');
    }

    const target = await this.prisma.deployment.findFirst({
      where: { id: deploymentId, applicationId: id },
    });
    if (!target) throw new NotFoundException('Deployment not found for this application');
    if (!target.commitSha) {
      throw new BadRequestException('Target deployment has no commit SHA to roll back to');
    }

    await this.assertNoInflightDeployment(id);

    const cloneHeader = await this.resolveCloneHeader(app);

    const deployment = await this.prisma.deployment.create({
      data: {
        applicationId: id,
        status: 'PENDING',
        triggeredById: userId,
        commitMessage: `Rollback to ${target.commitSha.slice(0, 7)}`,
      },
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
      gitRef: target.commitSha,
    }).catch(() => {});
    return { message: `Rollback to ${target.commitSha.slice(0, 7)} triggered`, deploymentId: deployment.id };
  }

  // ── logs / exec ────────────────────────────────────────────────────

  async getLogs(userId: string, id: string, lines = 100) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    const slug = slugify(app.name);
    const server = await resolveAppServer(this.prisma, id);
    if (!isAppLocal(server) && server) {
      try {
        const task = await this.agent.enqueueAndWait(
          server.id,
          'LOGS',
          { slug: remoteAppSlug(app.name, id), legacySlug: slug, lines },
          30_000,
        );
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
    // Prefer the container name the deploy ACTUALLY persisted (app.containerName)
    // over the on-disk heuristic. The heuristic (resolveContainerName) appends a
    // -<id12> suffix whenever the per-instance dir exists, but several deploy
    // paths — PHP sites, docker-image, dockerfile — write a per-instance DIR yet
    // name the container WITHOUT the suffix (containerName(slug)). That mismatch
    // made `docker exec` (cron + terminal) target a non-existent name
    // ("No such container: dockcontrol-<slug>-<id12>"). The stored value is the
    // source of truth; fall back to the heuristic only for legacy rows that
    // never persisted one.
    let cname = app.containerName || resolveContainerName(slug, id);
    // NGINX-mode PHP sites run TWO containers: the public nginx:alpine web
    // container (persisted as app.containerName, NO php binary) and the actual
    // PHP runtime in the php-fpm sidecar named `<containerName>-fpm`. A terminal
    // command, `php artisan …`, `composer …`, or a cron EXEC must hit the PHP
    // runtime — exec'ing the nginx container would fail with "php: not found".
    // Apache mode keeps mod_php in the single container, so it's unaffected.
    if (app.framework === 'PHP_SITE' && (app as any).phpWebServer === 'nginx') {
      cname = `${cname}-fpm`;
    }
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
      const states = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return String(JSON.parse(line).State || '');
          } catch {
            return line.includes('running') ? 'running' : 'other';
          }
        });
      // A multi-container stack is only truly UP when EVERY service is running.
      // This matters for nginx-mode PHP sites: nginx (the persisted container)
      // runs `restart: unless-stopped` and stays up even if its php-fpm sidecar
      // crashed — so a `.some()` union would report RUNNING while every request
      // 502s. Requiring the conjunction makes a dead fpm flip the app to STOPPED
      // (the truthful state). Single-service stacks (apache mode, every other
      // app) are unaffected — one service, any vs all are equivalent.
      const isMultiService =
        app.framework === 'PHP_SITE' && app.phpWebServer === 'nginx';
      const running = isMultiService
        ? states.length > 0 && states.every((s) => s === 'running')
        : states.some((s) => s === 'running');
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
