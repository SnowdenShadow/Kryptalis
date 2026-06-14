import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AppStatus, DeploymentStatus } from '@prisma/client';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { AgentService } from '../agent/agent.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { detectStack, FRAMEWORK_DOCKERFILES, FRAMEWORK_INTERNAL_PORT } from './dockerfile-templates';
import { DatabasesService } from '../databases/databases.service';
import { ApplicationEnvService } from './application-env.service';
import {
  execFileAsync,
  slugify,
  remoteAppSlug,
  resolveAppServer,
  containerName,
  imageName,
  resolveAppDir,
  parseDockerfileExposed,
  remapComposePorts,
  injectComposeEnv,
  attachProjectNetwork,
  projectNetworkName,
  ensureSharedAppsNetwork,
  attachSharedAppsNetwork,
  stripComposePorts,
  stripReservedComposePorts,
  readComposeContainerInfo,
  dockerCompose,
  removeCollidingContainers,
  findComposePath,
} from './applications.helpers';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as crypto from 'crypto';

/**
 * Deployment pipeline for applications: git-clone deploys, docker-image
 * deploys, raw compose / raw Dockerfile deploys, healthchecks, rollback
 * and terminal-outcome notifications. Split out of ApplicationsService.
 */
@Injectable()
export class ApplicationDeployService implements OnModuleInit {
  private readonly logger = new Logger(ApplicationDeployService.name);

  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    private agent: AgentService,
    private notifications: NotificationsService,
    private databases: DatabasesService,
    private env: ApplicationEnvService,
  ) {}

  onModuleInit(): void {
    // One-shot boot sweep: canary containers (label dockcontrol.canary=1) are
    // throwaway and always torn down in canaryBoot's finally — but an API
    // crash mid-deploy can leave one behind. Reap any leftover so it doesn't
    // hold a name/port/network and confuse the next deploy. Best-effort and
    // off the boot path (never blocks startup; no docker → just logged).
    void this.reapStaleCanaries();
  }

  /** Remove leftover canary containers from a prior crash. Best-effort. */
  private async reapStaleCanaries(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['ps', '-aq', '--filter', 'label=dockcontrol.canary=1'],
        { timeout: 10_000 },
      );
      const ids = stdout.trim().split('\n').filter(Boolean);
      if (!ids.length) return;
      this.logger.warn(`Reaping ${ids.length} stale canary container(s) from a prior crash.`);
      await execFileAsync('docker', ['rm', '-f', ...ids], { timeout: 30_000 }).catch(() => {});
    } catch (err: any) {
      // docker unavailable / not installed (remote-only install) — nothing
      // to reap locally. Don't let it bubble into startup.
      this.logger.debug?.(`Canary reaper skipped: ${err?.message || err}`);
    }
  }

  /**
   * Notify the user who triggered a deployment of its terminal outcome.
   * Reads triggeredById from the Deployment row so callers don't need to
   * thread it down. Never throws — notification failures shouldn't break
   * the deploy.
   */
  private async notifyDeploymentOutcome(
    deploymentId: string,
    appName: string,
    status: 'success' | 'failed',
    error?: string,
  ) {
    try {
      const dep = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { triggeredById: true },
      });
      if (dep?.triggeredById) {
        await this.notifications.sendDeploymentResult(dep.triggeredById, appName, status, error);
      }
    } catch {}
  }

  /**
   * Resolve the app's project server; returns it when it's a REMOTE host
   * (deploy must be dispatched to the agent), null when local. Every deploy
   * path calls this first — running docker locally for a remote project
   * would plant the container on the platform host while the dashboard
   * claims it lives on the project's server.
   */
  private async resolveRemoteServer(appId: string): Promise<{ id: string; host: string | null } | null> {
    // resolveAppServer: app.serverId (per-app placement) wins over the
    // project's default server.
    const server = await resolveAppServer(this.prisma, appId);
    return server && !isLocalHost(server.host) ? server : null;
  }

  /**
   * Dispatch a non-git deploy (image / raw compose / raw Dockerfile) to the
   * remote agent and mirror the outcome onto the Application + Deployment
   * rows. The agent writes the compose/Dockerfile under its own
   * /opt/dockcontrol/apps/<slug> and runs `docker compose up -d --build`.
   */
  private async dispatchRemoteDeploy(
    server: { id: string },
    deploymentId: string,
    appId: string,
    name: string,
    payload: Record<string, unknown>,
    /** Container coordinates to persist on success — feeds the heartbeat
     *  status sync (matches on containerName) and the dashboard. Without
     *  this, remote image/compose/Dockerfile apps never get a live dot. */
    meta?: { containerName?: string | null; containerPort?: number | null },
  ) {
    // Per-instance slug — must match what lifecycle ops + remove() compute
    // (remoteAppSlug). Bare slugify(name) would collide for same-named apps
    // and diverge from the dir the agent's REMOVE later looks for.
    const slug = remoteAppSlug(name, appId);
    const started = Date.now();
    const buildLogs: string[] = [];
    try {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'DEPLOYING', startedAt: new Date() },
      });
      const appRow = await this.prisma.application.findUnique({
        where: { id: appId },
        select: { projectId: true },
      });
      const task = await this.agent.enqueueAndWait(
        server.id,
        'DEPLOY',
        {
          slug,
          appName: name,
          projectNetwork: appRow ? projectNetworkName(appRow.projectId) : null,
          ...payload,
        },
        15 * 60_000,
      );
      const r: any = task.result || {};
      if (r.logs) buildLogs.push(r.logs);
      if (task.status === 'FAILED') throw new Error(task.error || 'agent deploy failed');
      await this.prisma.application.update({
        where: { id: appId },
        data: {
          status: AppStatus.RUNNING,
          ...(meta?.containerName ? { containerName: meta.containerName } : {}),
          ...(meta?.containerPort ? { containerPort: meta.containerPort } : {}),
        },
      });
      this.proxy.regenerate().catch(() => {});
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.RUNNING,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      this.notifyDeploymentOutcome(deploymentId, name, 'success');
    } catch (err: any) {
      const msg = err?.message || 'remote deploy failed';
      buildLogs.push(`✖ ${msg}`);
      await this.prisma.application.update({
        where: { id: appId },
        data: { status: AppStatus.ERROR },
      });
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.FAILED,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          deployLogs: msg.slice(0, 10_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      this.proxy.regenerate().catch(() => {});
      this.notifyDeploymentOutcome(deploymentId, name, 'failed', msg);
    }
  }

  /**
   * Pull-and-run path for "I just want this Docker image" deploys. Writes a
   * synthesized docker-compose.yml into the app dir so the agent + dashboard
   * treat it like any other compose stack — start/stop/restart all keep
   * working, and a redeploy means "re-pull + recreate".
   */
  async runDockerImageDeploy(
    deploymentId: string,
    appId: string,
    name: string,
    image: string,
    opts: { port?: number; envVars?: Record<string, string>; hostPort?: number },
  ) {
    // Remote project → ship a synthesized compose to the agent instead of
    // running docker locally.
    const remoteForImage = await this.resolveRemoteServer(appId);
    if (remoteForImage) {
      const slugR = slugify(name);
      const env = opts.envVars || {};
      const publishHost = opts.hostPort;
      const publishContainer = opts.port ?? opts.hostPort ?? null;
      const composeDoc: any = {
        services: {
          app: {
            image,
            container_name: containerName(slugR),
            restart: 'unless-stopped',
            pull_policy: 'always',
            ...(Object.keys(env).length ? { environment: { ...env } } : {}),
            ...(publishHost && publishContainer ? { ports: [`${publishHost}:${publishContainer}`] } : {}),
            networks: ['dockcontrol_apps'],
          },
        },
        networks: { dockcontrol_apps: { external: true, name: 'dockcontrol-apps' } },
      };
      await this.dispatchRemoteDeploy(
        remoteForImage,
        deploymentId,
        appId,
        name,
        { compose: yaml.dump(composeDoc, { lineWidth: 200 }) },
        { containerName: containerName(slugR), containerPort: publishContainer },
      );
      return;
    }

    const slug = slugify(name);
    const containerNm = containerName(slug);
    const appDir = resolveAppDir(slug, appId);
    const started = Date.now();
    const buildLogs: string[] = [];
    // Scrubs git bearer tokens and basic-auth blobs from any log line before
    // persisting. Defense in depth on top of the redacted log() in clone
    // paths — any future codepath that calls log() with a stderr blob from
    // git (e.g. clone failure echoing the auth header) is also protected.
    const scrub = (line: string): string =>
      line
        .replace(/(Authorization:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9_\-+/.=]+/gi, '$1<redacted>')
        .replace(/(http\.extraheader=)[^\s'"]+/g, '$1<redacted>')
        .replace(/(x-access-token:)[^@\s]+/gi, '$1<redacted>');
    const log = (line: string) => {
      buildLogs.push(scrub(line));
    };

    try {
      await ensureSharedAppsNetwork();
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'DEPLOYING', startedAt: new Date() },
      });
      log(`> deploying docker image ${image}`);

      // Resolve project network to attach the container — same multi-app
      // discovery story as a normal compose deploy.
      const appRow = await this.prisma.application.findUnique({
        where: { id: appId },
        select: { projectId: true, project: { select: { server: { select: { host: true } } } } },
      });
      const projectNet = appRow ? projectNetworkName(appRow.projectId) : null;
      if (projectNet) {
        try {
          await execFileAsync('docker', ['network', 'inspect', projectNet], { timeout: 5000 });
        } catch {
          try { await execFileAsync('docker', ['network', 'create', projectNet], { timeout: 10_000 }); } catch {}
        }
      }

      // Fresh dir + minimal compose. If the user supplied a port, publish it
      // on host; otherwise Caddy proxies over the project network.
      if (fs.existsSync(appDir)) {
        // REDEPLOY path — `down` WITHOUT `-v` so user data (DB volumes,
        // upload dirs declared in the compose) survives. Using `-v` here
        // was wiping PrestaShop/WordPress databases on every redeploy.
        // Remove path handles -v + --rmi separately below.
        try { await dockerCompose(appDir, ['down', '--remove-orphans'], undefined, 60_000); } catch {}
        fs.rmSync(appDir, { recursive: true, force: true });
      }
      fs.mkdirSync(appDir, { recursive: true });

      const env = opts.envVars || {};
      // ports: publish host:container when the user picked a host port
      // (no-domain access path). With a domain, Caddy reaches the
      // container over the bridge — no publish needed.
      const publishHost = opts.hostPort;
      const publishContainer = opts.port ?? opts.hostPort ?? null;

      // Build compose via yaml.dump so the image string can't break out
      // of its quoted form into the parent compose document. An
      // attacker who controls the dockerImage field (auth'd user) could
      // otherwise inject \\n  privileged: true or a sibling service.
      // Attach to BOTH the per-project network (so sibling apps in the
      // same project can resolve each other by container_name) AND the
      // shared dockcontrol-apps bridge (so Caddy can resolve us by name
      // for HTTPS routing). Missing the second one → Caddy hits ENOTFOUND
      // on every request → 502. Same pattern as the compose-only and
      // marketplace install paths.
      const networks = ['dockcontrol_apps'];
      if (projectNet) networks.unshift('dockcontrol_project');
      const composeDoc: any = {
        services: {
          app: {
            image,
            container_name: containerNm,
            restart: 'unless-stopped',
            pull_policy: 'always',
            ...(Object.keys(env).length ? { environment: { ...env } } : {}),
            ...(publishHost && publishContainer
              ? { ports: [`${publishHost}:${publishContainer}`] }
              : {}),
            networks,
          },
        },
        networks: {
          ...(projectNet ? { dockcontrol_project: { external: true, name: projectNet } } : {}),
          dockcontrol_apps: { external: true, name: 'dockcontrol-apps' },
        },
      };
      const compose = yaml.dump(composeDoc, { lineWidth: 200 });
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
      log('> wrote docker-compose.yml');

      log(`> docker compose pull`);
      await dockerCompose(appDir, ['pull'], undefined, 300_000);
      await removeCollidingContainers(compose, log);
      log(`> docker compose up -d`);
      await dockerCompose(appDir, ['up', '-d', '--remove-orphans'], undefined, 180_000);

      // If the user didn't pick an explicit port, ask docker what the
      // image actually exposes. Without this, Caddy has no idea where
      // to proxy and the domain stays in 'reserved' mode.
      let detectedPort = opts.port ?? null;
      if (!detectedPort) {
        try {
          const insp = await execFileAsync(
            'docker',
            ['inspect', '--format', '{{json .Config.ExposedPorts}}', containerNm],
            { timeout: 10_000 },
          );
          const exposed = JSON.parse(insp.stdout || '{}') as Record<string, unknown>;
          for (const key of Object.keys(exposed)) {
            const n = parseInt(key.split('/')[0], 10);
            if (Number.isFinite(n)) {
              detectedPort = n;
              break;
            }
          }
        } catch {}
      }

      await this.prisma.application.update({
        where: { id: appId },
        data: {
          status: AppStatus.RUNNING,
          containerName: containerNm,
          containerPort: detectedPort,
          port: detectedPort,
        },
      });
      this.proxy.regenerate().catch(() => {});
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.RUNNING,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      this.notifyDeploymentOutcome(deploymentId, name, 'success');
    } catch (err: any) {
      const msg = err?.message || 'docker image deploy failed';
      log(`✖ ${msg}`);
      await this.prisma.application.update({
        where: { id: appId },
        data: { status: AppStatus.ERROR },
      });
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.FAILED,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          deployLogs: msg.slice(0, 10_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      // Refresh Caddy so any stale block from a prior successful deploy
      // (we just failed a new one) no longer points at a dead container.
      this.proxy.regenerate().catch(() => {});
      this.notifyDeploymentOutcome(deploymentId, name, 'failed', msg);
    }
  }

  /**
   * Raw docker-compose.yml deploy. No git, no Docker image — the user
   * pasted the entire stack as YAML. We write it to appDir and call
   * `docker compose up -d`. From there every lifecycle op (start, stop,
   * logs, restart) behaves identically to a git-cloned compose project.
   */
  async runComposeOnlyDeploy(
    deploymentId: string,
    appId: string,
    name: string,
    composeYaml: string,
    opts: { envVars?: Record<string, string> | null; hostPort?: number },
  ) {
    // Remote project → the agent writes + runs the user's compose on its host.
    const remoteForCompose = await this.resolveRemoteServer(appId);
    if (remoteForCompose) {
      // Container coordinates from the user's compose — same extraction the
      // local path does, so heartbeat status sync + Caddy targeting work.
      const info = readComposeContainerInfo(composeYaml, containerName(slugify(name)));
      await this.dispatchRemoteDeploy(
        remoteForCompose,
        deploymentId,
        appId,
        name,
        { compose: composeYaml, envVars: opts.envVars || undefined },
        { containerName: info.containerName, containerPort: info.containerPort },
      );
      return;
    }

    const slug = slugify(name);
    const appDir = resolveAppDir(slug, appId);
    const started = Date.now();
    const buildLogs: string[] = [];
    const log = (line: string) => buildLogs.push(line);

    try {
      await ensureSharedAppsNetwork();
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'DEPLOYING', startedAt: new Date() },
      });

      const appRow = await this.prisma.application.findUnique({
        where: { id: appId },
        select: { projectId: true },
      });
      const projectNet = appRow ? projectNetworkName(appRow.projectId) : null;
      if (projectNet) {
        try {
          await execFileAsync('docker', ['network', 'inspect', projectNet], { timeout: 5_000 });
        } catch {
          try { await execFileAsync('docker', ['network', 'create', projectNet], { timeout: 10_000 }); } catch {}
        }
      }

      if (fs.existsSync(appDir)) {
        // REDEPLOY path — `down` WITHOUT `-v` so user data (DB volumes,
        // upload dirs declared in the compose) survives. Using `-v` here
        // was wiping PrestaShop/WordPress databases on every redeploy.
        // Remove path handles -v + --rmi separately below.
        try { await dockerCompose(appDir, ['down', '--remove-orphans'], undefined, 60_000); } catch {}
        fs.rmSync(appDir, { recursive: true, force: true });
      }
      fs.mkdirSync(appDir, { recursive: true });

      // Attach the user's compose to the per-project + shared networks
      // so Caddy + sibling apps can reach the services by container_name.
      let finalCompose = composeYaml;
      if (projectNet) finalCompose = attachProjectNetwork(finalCompose, projectNet);
      finalCompose = attachSharedAppsNetwork(finalCompose);
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), finalCompose);
      log('> wrote docker-compose.yml');

      // Persist + write .dockcontrol.env (used by `--env-file` for ${VAR}
      // substitution in the YAML).
      let envFile: string | undefined;
      if (opts.envVars && Object.keys(opts.envVars).length) {
        envFile = path.join(appDir, '.dockcontrol.env');
        fs.writeFileSync(envFile, this.env.serializeEnv(opts.envVars));
      }
      // ALSO write a plain `.env` in the app dir. `--env-file .dockcontrol.env`
      // only substitutes ${VAR} in the compose YAML — it does NOT satisfy an
      // `env_file: .env` directive declared INSIDE the compose (marketplace
      // stacks like Portainer use it, and compose hard-fails if the file is
      // missing). Mirror the merged env (empty file is fine — it just
      // satisfies the directive) exactly as the git-deploy path does.
      try {
        fs.writeFileSync(path.join(appDir, '.env'), this.env.serializeEnv(opts.envVars || {}));
      } catch (err: any) {
        log(`! could not write .env: ${err?.message || err}`);
      }

      log('> docker compose pull');
      try { await dockerCompose(appDir, ['pull'], envFile, 300_000); } catch {}
      await removeCollidingContainers(finalCompose, log);
      log('> docker compose up -d');
      await dockerCompose(appDir, ['up', '-d', '--remove-orphans'], envFile, 300_000);

      // Pull container name + port from the first service so Caddy has a
      // reverse-proxy target. The user's compose already declared them.
      const info = readComposeContainerInfo(finalCompose, containerName(slug));
      await this.prisma.application.update({
        where: { id: appId },
        data: {
          status: AppStatus.RUNNING,
          containerName: info.containerName,
          containerPort: info.containerPort,
          port: info.containerPort,
        },
      });
      this.proxy.regenerate().catch(() => {});
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.RUNNING,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      this.notifyDeploymentOutcome(deploymentId, name, 'success');

      // Post-deploy: auto-import any DB services declared in the user's
      // compose so they show up in /dashboard/databases with the same RBAC
      // (inherited via projectId). Idempotent on redeploy via the
      // @@unique([applicationId, serviceName]) constraint. Errors here
      // are swallowed — the stack is already running by this point and
      // a registry-import failure must not flip the deploy red.
      try {
        const appRowForImport = await this.prisma.application.findUnique({
          where: { id: appId },
          // serverId: per-app placement wins — the DB sidecar runs in the
          // app's compose stack, i.e. on the app's RESOLVED server.
          select: { projectId: true, serverId: true, project: { select: { serverId: true } } },
        });
        const dbServerId = appRowForImport?.serverId ?? appRowForImport?.project?.serverId;
        if (appRowForImport && dbServerId) {
          await this.databases.importFromAppCompose({
            applicationId: appId,
            projectId: appRowForImport.projectId,
            serverId: dbServerId,
            composeYaml: finalCompose,
          });
        }
      } catch {}
    } catch (err: any) {
      const msg = err?.message || 'compose deploy failed';
      log(`✖ ${msg}`);
      await this.prisma.application.update({
        where: { id: appId },
        data: { status: AppStatus.ERROR },
      });
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.FAILED,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          deployLogs: msg.slice(0, 10_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      this.proxy.regenerate().catch(() => {});
      this.notifyDeploymentOutcome(deploymentId, name, 'failed', msg);
    }
  }

  /**
   * Raw Dockerfile deploy. No git clone — the user pasted the Dockerfile
   * (and optional context files) directly. We write them to appDir and
   * build via a synthesized one-service docker-compose.yml so every
   * lifecycle path stays identical to git/image deploys.
   */
  async runDockerfileOnlyDeploy(
    deploymentId: string,
    appId: string,
    name: string,
    dockerfile: string,
    opts: {
      port?: number;
      envVars?: Record<string, string> | null;
      hostPort?: number;
      contextFiles?: Record<string, string>;
    },
  ) {
    // Remote project → ship Dockerfile + context + synthesized compose to
    // the agent; it builds and runs on its own host.
    const remoteForDockerfile = await this.resolveRemoteServer(appId);
    if (remoteForDockerfile) {
      const slugR = slugify(name);
      const env = opts.envVars || {};
      const publishContainer = opts.port ?? null;
      const publishHost = opts.hostPort;
      const composeDoc: any = {
        services: {
          app: {
            build: { context: '.' },
            container_name: containerName(slugR),
            restart: 'unless-stopped',
            ...(Object.keys(env).length ? { environment: { ...env } } : {}),
            ...(publishHost && publishContainer ? { ports: [`${publishHost}:${publishContainer}`] } : {}),
            networks: ['dockcontrol_apps'],
          },
        },
        networks: { dockcontrol_apps: { external: true, name: 'dockcontrol-apps' } },
      };
      await this.dispatchRemoteDeploy(
        remoteForDockerfile,
        deploymentId,
        appId,
        name,
        {
          compose: yaml.dump(composeDoc, { lineWidth: 200 }),
          dockerfileOverride: dockerfile,
          sideFiles: opts.contextFiles || undefined,
        },
        { containerName: containerName(slugR), containerPort: publishContainer },
      );
      return;
    }

    const slug = slugify(name);
    const containerNm = containerName(slug);
    const appDir = resolveAppDir(slug, appId);
    const started = Date.now();
    const buildLogs: string[] = [];
    const log = (line: string) => buildLogs.push(line);

    try {
      await ensureSharedAppsNetwork();
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'BUILDING', startedAt: new Date() },
      });

      const appRow = await this.prisma.application.findUnique({
        where: { id: appId },
        select: { projectId: true },
      });
      const projectNet = appRow ? projectNetworkName(appRow.projectId) : null;
      if (projectNet) {
        try {
          await execFileAsync('docker', ['network', 'inspect', projectNet], { timeout: 5_000 });
        } catch {
          try { await execFileAsync('docker', ['network', 'create', projectNet], { timeout: 10_000 }); } catch {}
        }
      }

      if (fs.existsSync(appDir)) {
        // REDEPLOY path — `down` WITHOUT `-v` so user data (DB volumes,
        // upload dirs declared in the compose) survives. Using `-v` here
        // was wiping PrestaShop/WordPress databases on every redeploy.
        // Remove path handles -v + --rmi separately below.
        try { await dockerCompose(appDir, ['down', '--remove-orphans'], undefined, 60_000); } catch {}
        fs.rmSync(appDir, { recursive: true, force: true });
      }
      fs.mkdirSync(appDir, { recursive: true });

      // Dockerfile + any sibling context files (already path-validated
      // in the DTO check). Write them all then point compose `build: .`.
      fs.writeFileSync(path.join(appDir, 'Dockerfile'), dockerfile);
      if (opts.contextFiles) {
        for (const [rel, content] of Object.entries(opts.contextFiles)) {
          const dst = path.join(appDir, rel);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.writeFileSync(dst, content);
        }
      }
      log(`> wrote Dockerfile (${Object.keys(opts.contextFiles || {}).length} context files)`);

      const env = opts.envVars || {};
      const publishContainer = opts.port ?? null;
      const publishHost = opts.hostPort;

      const composeDoc: any = {
        services: {
          app: {
            build: { context: '.' },
            container_name: containerNm,
            restart: 'unless-stopped',
            ...(Object.keys(env).length ? { environment: { ...env } } : {}),
            ...(publishHost && publishContainer
              ? { ports: [`${publishHost}:${publishContainer}`] }
              : {}),
            ...(projectNet ? { networks: ['dockcontrol_project', 'dockcontrol_apps'] } : { networks: ['dockcontrol_apps'] }),
          },
        },
        networks: {
          ...(projectNet ? { dockcontrol_project: { external: true, name: projectNet } } : {}),
          dockcontrol_apps: { external: true, name: 'dockcontrol-apps' },
        },
      };
      const composeStr = yaml.dump(composeDoc, { lineWidth: 200 });
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), composeStr);
      log('> wrote docker-compose.yml');

      log('> docker compose build');
      await dockerCompose(appDir, ['build'], undefined, 900_000);
      await removeCollidingContainers(composeStr, log);
      log('> docker compose up -d');
      await dockerCompose(appDir, ['up', '-d', '--remove-orphans'], undefined, 180_000);

      // If user didn't pin a port, ask docker what the built image exposes.
      let detectedPort = opts.port ?? null;
      if (!detectedPort) {
        try {
          const insp = await execFileAsync(
            'docker',
            ['inspect', '--format', '{{json .Config.ExposedPorts}}', containerNm],
            { timeout: 10_000 },
          );
          const exposed = JSON.parse(insp.stdout || '{}') as Record<string, unknown>;
          for (const key of Object.keys(exposed)) {
            const n = parseInt(key.split('/')[0], 10);
            if (Number.isFinite(n)) { detectedPort = n; break; }
          }
        } catch {}
      }

      await this.prisma.application.update({
        where: { id: appId },
        data: {
          status: AppStatus.RUNNING,
          containerName: containerNm,
          containerPort: detectedPort,
          port: detectedPort,
        },
      });
      this.proxy.regenerate().catch(() => {});
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.RUNNING,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      this.notifyDeploymentOutcome(deploymentId, name, 'success');
    } catch (err: any) {
      const msg = err?.message || 'Dockerfile build failed';
      log(`✖ ${msg}`);
      await this.prisma.application.update({
        where: { id: appId },
        data: { status: AppStatus.ERROR },
      });
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.FAILED,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          deployLogs: msg.slice(0, 10_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      this.proxy.regenerate().catch(() => {});
      this.notifyDeploymentOutcome(deploymentId, name, 'failed', msg);
    }
  }

  buildAuthHeader(provider: string, token: string): string {
    // header injected via `git -c http.extraheader=...` — never lands in .git/config
    if (provider === 'GITHUB') {
      const b = Buffer.from(`x-access-token:${token}`).toString('base64');
      return `Authorization: Basic ${b}`;
    }
    if (provider === 'GITLAB') {
      return `Authorization: Bearer ${token}`;
    }
    if (provider === 'BITBUCKET') {
      const b = Buffer.from(`x-token-auth:${token}`).toString('base64');
      return `Authorization: Basic ${b}`;
    }
    const b = Buffer.from(`token:${token}`).toString('base64');
    return `Authorization: Basic ${b}`;
  }

  async runDeploy(
    deploymentId: string,
    appId: string,
    name: string,
    gitUrl: string,
    branch: string,
    opts: {
      port?: number | null;
      envVars?: Record<string, string> | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      cloneHeader?: string;
      composeOverride?: string;
      dockerfileOverride?: string;
      portMapping?: Record<string, number>;
      hostPort?: number;
      /**
       * Optional commit SHA to deploy instead of the branch tip — used by
       * the manual rollback endpoint. Requires a full (non-shallow) clone
       * so the commit is reachable, then a detached checkout.
       */
      gitRef?: string;
    },
  ) {
    const slug = slugify(name);
    // Use the per-instance app dir (slug + applicationId prefix), same
    // helper every other touchpoint uses. Without this two apps whose
    // names slugify identically (e.g. "blog" and "Blog") would share an
    // appDir and clobber each other's compose stack and clone sources.
    const appDir = resolveAppDir(slug, appId);
    const started = Date.now();
    const buildLogs: string[] = [];
    // Same scrub as runDockerImageDeploy — strips git bearer tokens and
    // basic-auth blobs from any log line before persistence.
    const scrub = (line: string): string =>
      line
        .replace(/(Authorization:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9_\-+/.=]+/gi, '$1<redacted>')
        .replace(/(http\.extraheader=)[^\s'"]+/g, '$1<redacted>')
        .replace(/(x-access-token:)[^@\s]+/gi, '$1<redacted>');
    let flushPending = false;
    const flush = async () => {
      if (flushPending) return;
      flushPending = true;
      try {
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: { buildLogs: buildLogs.join('\n').slice(-50_000) },
        });
      } catch {}
      flushPending = false;
    };
    const log = (s: string) => {
      buildLogs.push(scrub(s));
      void flush();
    };

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: 'BUILDING', startedAt: new Date() },
    });
    await ensureSharedAppsNetwork();

    // Resolve the project scope so we can attach this app to the per-project
    // docker network — enables service-name DNS between apps of the same project.
    const appRow = await this.prisma.application.findUnique({
      where: { id: appId },
      select: { projectId: true },
    });
    // Per-app placement: app.serverId wins over the project default.
    const remoteServer = await this.resolveRemoteServer(appId);

    // Remote server → delegate the entire deploy to the agent.
    if (remoteServer) {
      try {
        log(`> dispatching deploy to remote server ${remoteServer.host}`);
        const task = await this.agent.enqueueAndWait(
          remoteServer.id,
          'DEPLOY',
          {
            // Per-instance slug, same convention as lifecycle ops + remove().
            slug: remoteAppSlug(name, appId),
            appName: name,
            gitUrl,
            branch,
            cloneHeader: opts.cloneHeader,
            envVars: opts.envVars,
            buildCommand: opts.buildCommand,
            startCommand: opts.startCommand,
            composeOverride: opts.composeOverride,
            dockerfileOverride: opts.dockerfileOverride,
            portMapping: opts.portMapping,
            port: opts.port,
            // Rollback to a pinned commit — the agent does a full clone +
            // detached checkout when this is set.
            gitRef: opts.gitRef,
            projectNetwork: appRow ? projectNetworkName(appRow.projectId) : null,
          },
          15 * 60_000,
        );
        const r: any = task.result || {};
        if (r.logs) log(r.logs);
        if (task.status === 'FAILED') throw new Error(task.error || 'agent deploy failed');
        await this.prisma.application.update({
          where: { id: appId },
          data: { status: AppStatus.RUNNING },
        });
        this.proxy.regenerate().catch(() => {});
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: DeploymentStatus.RUNNING,
            buildLogs: buildLogs.join('\n').slice(0, 50_000),
            commitSha: r.commitSha || undefined,
            commitMessage: r.commitMessage || undefined,
            duration: Date.now() - started,
            finishedAt: new Date(),
          },
        });
        this.notifyDeploymentOutcome(deploymentId, name, 'success');
      } catch (err: any) {
        const msg = err?.message || 'deploy failed';
        log(`✖ ${msg}`);
        await this.prisma.application.update({
          where: { id: appId },
          data: { status: AppStatus.ERROR },
        });
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: DeploymentStatus.FAILED,
            buildLogs: buildLogs.join('\n').slice(0, 50_000),
            deployLogs: msg.slice(0, 10_000),
            duration: Date.now() - started,
            finishedAt: new Date(),
          },
        });
        this.notifyDeploymentOutcome(deploymentId, name, 'failed', msg);
      }
      return;
    }

    const projectNet = appRow ? projectNetworkName(appRow.projectId) : null;
    if (projectNet) {
      try {
        await execFileAsync('docker', ['network', 'inspect', projectNet], { timeout: 5000 });
      } catch {
        log(`> docker network create ${projectNet}`);
        try { await execFileAsync('docker', ['network', 'create', projectNet], { timeout: 10_000 }); } catch {}
      }
    }

    // Rollback snapshot of the previous appDir. The old "rollback" re-ran
    // `up -d` on the appDir ALREADY rewritten by the failed deploy — i.e. it
    // redeployed the broken config and only the healthcheck decided. We now
    // move the previous appDir aside before rewriting it, and swap it back
    // on failure. rename (not cpSync) is used: it's atomic on the same
    // filesystem and costs zero disk/time even with a huge node_modules.
    // LIMITATION: the snapshot restores the CONFIG (appDir: compose files,
    // source, Dockerfile) only — docker volumes and databases are NOT
    // snapshotted (`down` keeps them, see below). A failed deploy that
    // already ran a DB schema migration is not un-migrated by this rollback;
    // the old code comes back up against the new schema.
    const prevDir = `${appDir}.prev`;
    let hasPrevSnapshot = false;

    try {
      // 1. snapshot the previous appDir — but DO NOT stop the running
      // stack here. The old `down`-first order took the app offline for
      // the entire clone + npm-install + build (minutes of downtime per
      // push). The running containers don't need their config dir: we
      // rename it aside, build the new version next to them, and only
      // swap containers at `up` time. The compose PROJECT name is the
      // directory basename, which stays identical, so the later
      // `up --force-recreate --remove-orphans` adopts and replaces the
      // old containers (and removeCollidingContainers force-frees any
      // explicitly-named ones just before). Downtime drops from
      // minutes to the seconds of the container swap — which Caddy's
      // lb_try retries bridge for domain-routed traffic.
      if (fs.existsSync(appDir)) {
        // An orphan .prev left by a crash mid-deploy is overwritten
        // here — it's older than the appDir we're about to snapshot.
        try {
          if (fs.existsSync(prevDir)) fs.rmSync(prevDir, { recursive: true, force: true });
          fs.renameSync(appDir, prevDir);
          hasPrevSnapshot = true;
        } catch {
          // rename failed (locked file, cross-device, …) — degrade to the
          // historical stop+wipe; rollback will be best-effort.
          try {
            await dockerCompose(appDir, ['down', '--remove-orphans'], undefined, 60_000);
          } catch {}
          fs.rmSync(appDir, { recursive: true, force: true });
        }
      }
      fs.mkdirSync(appDir, { recursive: true });

      // 2. clone with header (token not persisted). A shallow clone is
      // enough for branch-tip deploys; rollbacks target an older commit so
      // they need the branch history to check it out.
      const cloneArgs = opts.gitRef
        ? ['clone', '--branch', branch]
        : ['clone', '--depth', '1', '--branch', branch];
      if (opts.cloneHeader) {
        cloneArgs.unshift('-c', `http.extraheader=${opts.cloneHeader}`);
      }
      cloneArgs.push(gitUrl, appDir);
      // Never echo the cloneArgs verbatim — the http.extraheader contains
      // the git provider's bearer token. Log a redacted form.
      const redactedArgs = cloneArgs.map((a) =>
        a.startsWith('http.extraheader=') ? 'http.extraheader=<redacted>' : a,
      );
      log(`> git ${redactedArgs.join(' ')}`);
      await execFileAsync('git', cloneArgs, { timeout: 180_000 });

      if (opts.gitRef) {
        log(`> git checkout --detach ${opts.gitRef}`);
        await execFileAsync(
          'git',
          ['-C', appDir, 'checkout', '--detach', opts.gitRef],
          { timeout: 30_000 },
        );
      }

      // 3. defensive: strip any token from .git/config
      try {
        await execFileAsync(
          'git',
          ['-C', appDir, 'remote', 'set-url', 'origin', gitUrl],
          { timeout: 5_000 },
        );
        await execFileAsync(
          'git',
          ['-C', appDir, 'config', '--unset', 'http.extraheader'],
          { timeout: 5_000 },
        ).catch(() => {});
      } catch {}

      // 4. merge repo .env* files (lowest priority) with user-supplied envVars (highest)
      const repoEnv = this.env.loadRepoEnvFiles(appDir);
      const mergedEnv: Record<string, string> = { ...repoEnv, ...(opts.envVars || {}) };
      if (Object.keys(mergedEnv).length) opts.envVars = mergedEnv;
      let envFile: string | undefined;
      if (opts.envVars && Object.keys(opts.envVars).length) {
        envFile = path.join(appDir, '.dockcontrol.env');
        const serialized = this.env.serializeEnv(opts.envVars);
        fs.writeFileSync(envFile, serialized);
        // Also overwrite the repo's `.env` files with the merged values.
        // Critical for build-time inlining: Next.js / Vite / CRA read `.env`
        // directly from the source tree during `npm run build`, NOT from
        // the compose `env_file:` runtime variables. `docker compose
        // --env-file .dockcontrol.env` only substitutes ${VAR} in the YAML;
        // it never replaces an `env_file: .env` declared INSIDE the
        // compose. So we mirror the merged env into every common .env
        // name the framework might consume. The repo's original .env
        // values are already merged in `mergedEnv` (lowest priority) so
        // we're not losing anything — we're just persisting the result.
        for (const name of ['.env', '.env.local', '.env.production']) {
          const target = path.join(appDir, name);
          // Only overwrite when the file existed in the repo OR the user
          // gave us something — don't create stray files in repos that
          // never had a .env.
          if (fs.existsSync(target) || Object.keys(opts.envVars).length) {
            // Build-time inlining depends on these files (Next/Vite/CRA read
            // them during `npm run build`) — a failed write means the image
            // would bake stale/missing env, so fail the deploy loudly.
            try {
              fs.writeFileSync(target, serialized);
            } catch (err: any) {
              throw new Error(`failed to write env file ${name}: ${err?.message || err}`);
            }
          }
        }
        log(`> merged env (${Object.keys(repoEnv).length} from repo, ${Object.keys(opts.envVars).length} total)`);
        // persist (encrypted) so redeploy keeps the merge
        await this.prisma.application.update({
          where: { id: appId },
          data: { envVars: this.env.encryptEnvVars(opts.envVars) as any },
        });
      }

      // 5. capture commit info
      let commitSha = '';
      let commitMessage = '';
      try {
        commitSha = (await execFileAsync('git', ['-C', appDir, 'rev-parse', 'HEAD'])).stdout.trim();
        commitMessage = (
          await execFileAsync('git', ['-C', appDir, 'log', '-1', '--pretty=%B'])
        ).stdout.trim();
      } catch {}

      // 6. apply optional overrides BEFORE detection
      if (opts.composeOverride) {
        fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), opts.composeOverride);
      }
      if (opts.dockerfileOverride) {
        fs.writeFileSync(path.join(appDir, 'Dockerfile'), opts.dockerfileOverride);
      }

      // Auto-detect the framework and generate a production Dockerfile
      // when the user didn't bring their own. This is the heart of the
      // "no Docker knowledge required" deploy: React/Vite/Next/Vue/Astro
      // /static repos get a clean nginx-or-node image with a fixed
      // internal port that Caddy reaches via container_name. The user
      // never picks a port.
      const composePathInitial = findComposePath(appDir);
      const dockerfilePathInitial = path.join(appDir, 'Dockerfile');
      const hasOwnDockerfile = fs.existsSync(dockerfilePathInitial);
      const hasOwnCompose = !!composePathInitial;
      if (!hasOwnDockerfile && !hasOwnCompose) {
        const stack = detectStack(appDir);
        if (stack) {
          const tpl = FRAMEWORK_DOCKERFILES[stack];
          fs.writeFileSync(dockerfilePathInitial, tpl);
          log(`🪄 No Dockerfile in repo — generated one for detected stack: ${stack}`);
          // Lock the app to the framework's canonical internal port so
          // every later reload picks the same one.
          const internalPort = FRAMEWORK_INTERNAL_PORT[stack];
          await this.prisma.application.update({
            where: { id: appId },
            data: {
              port: internalPort,
              framework: (stack as any),
              // Caddy reaches the app on the shared dockcontrol-apps bridge
              // by container_name:internalPort — no host port publish, no
              // port collision possible.
              containerName: containerName(slug),
              containerPort: internalPort,
            },
          });
          opts.port = internalPort;
        }
      }

      const composePath = findComposePath(appDir);
      const dockerfilePath = path.join(appDir, 'Dockerfile');
      const hasCompose = !!composePath;
      const hasDockerfile = fs.existsSync(dockerfilePath);

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'DEPLOYING' },
      });

      if (hasCompose) {
        // apply remap + env injection on a copy
        let content = fs.readFileSync(composePath!, 'utf-8');
        if (opts.portMapping) content = remapComposePorts(content, opts.portMapping);
        if (opts.envVars) content = injectComposeEnv(content, opts.envVars);

        // Look up whether the app already has a domain attached. When it
        // does, Caddy will reach the container via the shared bridge —
        // so we strip the user's `ports:` blocks (which would otherwise
        // collide with platform services like the dashboard on :3000)
        // and replace them with dockcontrol-apps network membership. The
        // user's intent is "this is internet-facing via a domain"; the
        // raw host port publish is a vestige of their local dev setup.
        const appRowForDomain = await this.prisma.application.findUnique({
          where: { id: appId },
          include: { domains: { select: { id: true } } },
        });
        const hasAttachedDomain = (appRowForDomain?.domains?.length ?? 0) > 0;

        if (hasAttachedDomain) {
          // Capture the original first container_name + target port BEFORE
          // stripping, so Caddy can route to it on the bridge.
          const info = readComposeContainerInfo(content, containerName(slug));
          if (info.containerPort) {
            // We also write `port` so the Caddy renderer's mainLinked
            // check (which gates on app.port being non-null) passes —
            // otherwise the domain stays in "reserved" mode forever and
            // the user sees the 503 placeholder.
            await this.prisma.application.update({
              where: { id: appId },
              data: {
                containerName: info.containerName,
                containerPort: info.containerPort,
                port: info.containerPort,
              },
            });
            log(
              `🛰  Domain attached — Caddy will route to ${info.containerName}:${info.containerPort}.`,
            );
          }
          content = stripComposePorts(content);
          content = attachSharedAppsNetwork(content);
        } else if (opts.hostPort) {
          // No domain → user picked a host port to publish on. Rewrite
          // every service's ports block to <hostPort>:<containerPort>
          // so the app is reachable at http://<serverIp>:<hostPort>.
          // Use the parsed container port from the compose; default to
          // hostPort if no internal target was declared.
          const info = readComposeContainerInfo(content, containerName(slug));
          const containerPort = info.containerPort || opts.hostPort;
          content = remapComposePorts(content, { [String(containerPort)]: opts.hostPort });
          await this.prisma.application.update({
            where: { id: appId },
            data: {
              containerName: info.containerName,
              containerPort,
              port: containerPort,
              hostPort: opts.hostPort,
            },
          });
        } else {
          // No domain AND no user-picked hostPort: keep the repo's host-port
          // publishes EXCEPT any that target a reserved port. A repo that
          // hardcodes `443:443` or `3000:3000` would otherwise collide with
          // Caddy / the dashboard and break the platform. Container ports stay
          // intact — only the offending host binding is neutralized.
          content = stripReservedComposePorts(content);
        }

        if (projectNet) content = attachProjectNetwork(content, projectNet);
        fs.writeFileSync(composePath!, content);

        // `pull` stays best-effort: a missing registry image is fine when the
        // compose builds locally (or the image already exists on the host).
        log('> docker compose pull');
        const r1 = await dockerCompose(appDir, ['pull'], envFile, 600_000).catch((e: any) => ({ stdout: '', stderr: e?.stderr || e?.message || '' }));
        log(r1.stdout + r1.stderr);
        // Rebuild so frameworks that inline env vars at build time (Next.js
        // NEXT_PUBLIC_*, Vite VITE_*) pick up the latest values. A plain
        // `build` is enough: BuildKit's cache is content-addressed — changed
        // source files / .env files invalidate COPY layers, and changed
        // build args invalidate from the first ARG-consuming layer. Deps
        // layers (npm ci) stay cached when the lockfile is unchanged, which
        // is most of the build time. (--no-cache here used to make every
        // redeploy reinstall everything for no correctness gain.)
        //
        // Build happens while the PREVIOUS version is still serving — the
        // old containers are only removed after the image is ready, so a
        // push-triggered redeploy costs seconds of swap, not minutes of
        // build downtime.
        //
        // Unlike `pull`, a BUILD failure is fatal. Swallowing it here used to
        // let `up -d` relaunch a stale pre-existing image and mark the deploy
        // RUNNING with the OLD code — a silent non-deploy.
        log('> docker compose build');
        try {
          const rb = await dockerCompose(appDir, ['build'], envFile, 900_000);
          log(rb.stdout + rb.stderr);
        } catch (e: any) {
          const stderr = (e?.stderr || e?.message || 'compose build failed').toString();
          log(stderr);
          throw new Error(`docker compose build failed: ${stderr}`);
        }
        // Blue-green canary: boot the main service's freshly built image in
        // a throwaway container while the previous version still serves.
        // Crash at startup (missing env, bad import) → abort the deploy with
        // the canary's logs, zero downtime. Only the MAIN service is
        // canaried — sidecars (DBs) are stock images that the old stack is
        // already running.
        const mainService = readComposeContainerInfo(content, containerName(slug));
        const mainImage = await this.resolveBuiltImage(appDir, content, mainService.containerName);
        if (mainImage) {
          const healthy = await this.canaryBoot(mainImage, {
            env: opts.envVars,
            networks: ['dockcontrol-apps', ...(projectNet ? [projectNet] : [])],
            log,
          });
          if (!healthy) {
            throw new Error('Canary failed — new version crashes at startup; previous version left running.');
          }
        }

        // Canary passed — NOW free the explicit container_names the compose
        // claims (the still-running previous version + any failed-deploy
        // leftovers) and bring the new stack up. This rm→up window is the
        // only downtime, bridged by Caddy's lb_try retries.
        await removeCollidingContainers(content, log);
        log('> docker compose up -d --force-recreate');
        const r2 = await dockerCompose(appDir, ['up', '-d', '--force-recreate', '--remove-orphans'], envFile, 900_000);
        log(r2.stdout + r2.stderr);
      } else if (hasDockerfile) {
        const img = imageName(slug);
        const cname = containerName(slug);
        log(`> docker build -t ${img} .`);
        const rb = await execFileAsync('docker', ['build', '-t', img, '.'], { cwd: appDir, timeout: 900_000 });
        log(rb.stdout + rb.stderr);

        // Blue-green canary BEFORE removing the running container — a
        // startup crash aborts the deploy while the old version serves.
        const healthy = await this.canaryBoot(img, {
          env: opts.envVars,
          networks: ['dockcontrol-apps', ...(projectNet ? [projectNet] : [])],
          log,
        });
        if (!healthy) {
          throw new Error('Canary failed — new version crashes at startup; previous version left running.');
        }

        try { await execFileAsync('docker', ['rm', '-f', cname]); } catch {}

        // Resolve the container's internal port (EXPOSE in Dockerfile +
        // opts.port override). This is what Caddy will reverse_proxy to,
        // NOT a host port. The platform reaches the container through
        // the shared `dockcontrol-apps` bridge — host port publish is
        // intentionally skipped so multiple apps can listen on port 80
        // without colliding.
        const exposed = parseDockerfileExposed(fs.readFileSync(dockerfilePath, 'utf-8'));
        const internalPort =
          opts.port ?? (exposed.length > 0 ? exposed[0] : undefined);

        // Build run argv. Attach to:
        //   1. dockcontrol-apps  → Caddy proxies to <containerName>:<internalPort>
        //   2. projectNet      → sibling apps in the same project reach by name
        const runArgs = ['run', '-d', '--name', cname, '--restart', 'unless-stopped'];
        runArgs.push('--network', 'dockcontrol-apps', '--network-alias', slug);
        if (projectNet) {
          runArgs.push('--network', projectNet, '--network-alias', slug);
        }
        if (opts.envVars) {
          for (const [k, v] of Object.entries(opts.envVars)) {
            runArgs.push('-e', `${k}=${v}`);
          }
        }
        // No host -p publish. Caddy reaches us via container_name.
        // If the user explicitly passed a portMapping (advanced flow),
        // we still honour it so they can opt-in to direct host access.
        const portMap: Array<[number, number]> = [];
        if (opts.portMapping) {
          for (const [ct, ht] of Object.entries(opts.portMapping)) {
            portMap.push([Number(ht), Number(ct)]);
          }
        }
        for (const [h, c] of portMap) runArgs.push('-p', `${h}:${c}`);
        runArgs.push(img);
        log(`> docker ${runArgs.join(' ')}`);
        const rr = await execFileAsync('docker', runArgs, { timeout: 120_000 });
        log(rr.stdout + rr.stderr);

        // Record container coordinates so Caddy's reverse_proxy uses
        // the in-network path (containerName:internalPort) on every
        // future regenerate.
        if (internalPort) {
          await this.prisma.application.update({
            where: { id: appId },
            data: { containerName: cname, containerPort: internalPort },
          });
        }

        // Generate the compose mirror so start/stop/logs uses the same
        // network attachment the run command did.
        const portsBlock = portMap.length
          ? `    ports:\n${portMap.map(([h, c]) => `      - "${h}:${c}"`).join('\n')}\n`
          : '';
        const envBlock = opts.envVars && Object.keys(opts.envVars).length
          ? `    environment:\n${Object.entries(opts.envVars).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n')}\n`
          : '';
        const networksBlock = `    networks:\n      - dockcontrol-apps${projectNet ? `\n      - ${projectNet}` : ''}\n`;
        const topLevelNetworks =
          `networks:\n  dockcontrol-apps:\n    external: true${projectNet ? `\n  ${projectNet}:\n    external: true` : ''}\n`;
        const composeContent =
          `services:\n  ${slug}:\n    image: ${img}\n    container_name: ${cname}\n    restart: unless-stopped\n${portsBlock}${envBlock}${networksBlock}\n${topLevelNetworks}`;
        fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), composeContent);

        if (!internalPort) {
          log('⚠ no EXPOSE directive in Dockerfile — Caddy will not be able to reach this app');
        }
      } else {
        // language autodetect — generate minimal compose.
        // user-provided buildCommand/startCommand are passed through `sh -c` so they
        // may contain arbitrary shell. Use YAML's structured representation (no
        // string interpolation) so quotes/backslashes/$() are emitted as data.
        const port = opts.port ?? 3000;
        const buildCmd = opts.buildCommand || 'npm install';
        const startCmd = opts.startCommand || 'npm start';
        const doc: any = {
          services: {
            [slug]: {
              image: 'node:20-alpine',
              container_name: containerName(slug),
              restart: 'unless-stopped',
              working_dir: '/app',
              volumes: ['.:/app'],
              ports: [`${port}:${port}`],
              command: ['sh', '-c', `${buildCmd} && ${startCmd}`],
            },
          },
        };
        if (opts.envVars && Object.keys(opts.envVars).length) {
          doc.services[slug].environment = { ...opts.envVars };
        }
        let composeContent = yaml.dump(doc, { lineWidth: 200 });
        if (projectNet) composeContent = attachProjectNetwork(composeContent, projectNet);
        fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), composeContent);
        await removeCollidingContainers(composeContent, log);
        log('> docker compose up -d --build');
        const r = await dockerCompose(appDir, ['up', '-d', '--build', '--remove-orphans'], envFile, 900_000);
        log(r.stdout + r.stderr);
      }

      // healthcheck: poll docker ps for up to 30s, expect at least one running container
      log('> healthcheck');
      const ok = await this.waitForHealthy(appDir, 30_000);
      if (!ok) throw new Error('Healthcheck failed — no container reached running state within 30s');

      // Deploy succeeded — the snapshot is no longer needed.
      if (hasPrevSnapshot) {
        try { fs.rmSync(prevDir, { recursive: true, force: true }); } catch {}
      }

      await this.prisma.application.update({
        where: { id: appId },
        data: { status: AppStatus.RUNNING },
      });
      // refresh Caddy now that the app is up and its port is canonical
      this.proxy.regenerate().catch(() => {});
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.RUNNING,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          commitSha: commitSha || undefined,
          commitMessage: commitMessage || undefined,
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      this.notifyDeploymentOutcome(deploymentId, name, 'success');
    } catch (err: any) {
      const msg = (err?.stderr || err?.stdout || err?.message || 'deploy failed').toString();
      log(`✖ ${msg}`);

      // attempt rollback: relaunch previous successful deployment's compose state
      const prevOk = await this.prisma.deployment.findFirst({
        where: { applicationId: appId, status: 'RUNNING' as any, id: { not: deploymentId } },
        orderBy: { createdAt: 'desc' },
      });
      let rolledBack = false;
      if (prevOk) {
        try {
          await this.prisma.deployment.update({
            where: { id: deploymentId },
            data: { status: 'ROLLING_BACK' as any },
          });
          // Restore the pre-deploy appDir snapshot FIRST — without the swap
          // we'd `up -d` the broken config the failed deploy just wrote.
          if (hasPrevSnapshot && fs.existsSync(prevDir)) {
            try {
              fs.rmSync(appDir, { recursive: true, force: true });
              fs.renameSync(prevDir, appDir);
              log('↺ restored previous app directory for rollback');
            } catch (swapErr: any) {
              log(`✖ failed to restore previous app directory: ${swapErr?.message || swapErr}`);
            }
          }
          // bring the previous compose back up (volumes/images survived)
          if (fs.existsSync(appDir) && findComposePath(appDir)) {
            await dockerCompose(appDir, ['up', '-d'], undefined, 120_000).catch(() => {});
            const ok = await this.waitForHealthy(appDir, 20_000);
            rolledBack = ok;
            log(rolledBack ? '↺ rollback successful' : '✖ rollback healthcheck failed');
          }
        } catch (rb: any) {
          log(`✖ rollback error: ${rb?.message || rb}`);
        }
      }

      await this.prisma.application.update({
        where: { id: appId },
        data: { status: rolledBack ? AppStatus.RUNNING : AppStatus.ERROR },
      });
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: rolledBack ? ('ROLLED_BACK' as any) : DeploymentStatus.FAILED,
          buildLogs: buildLogs.join('\n').slice(0, 50_000),
          deployLogs: msg.slice(0, 10_000),
          duration: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      // Refresh Caddy so the previous block (if any) reflects the
      // current state — either the rollback is up, or the app is down.
      this.proxy.regenerate().catch(() => {});
      this.notifyDeploymentOutcome(deploymentId, name, 'failed', msg);
    }
  }

  /**
   * Resolve the image the main compose service will run, for canary boot.
   * Priority: the service matching `mainContainerName` (else the first
   * service with a `build:` block, else the first service).
   *
   * Built services without an explicit `image:` get compose's default
   * `<project>-<service>` tag, project = appDir basename (compose lowercases
   * it). Verified via `docker image inspect` — if the tag can't be resolved
   * (older compose naming with underscores, custom project name), we return
   * null and the deploy proceeds WITHOUT a canary rather than failing a
   * healthy deploy on a naming mismatch.
   */
  private async resolveBuiltImage(
    appDir: string,
    composeContent: string,
    mainContainerName: string | null,
  ): Promise<string | null> {
    try {
      const doc: any = yaml.load(composeContent);
      const services = Object.entries<any>(doc?.services || {});
      if (services.length === 0) return null;
      const [svcName, svc] =
        services.find(([, s]) => s?.container_name === mainContainerName) ??
        services.find(([, s]) => s?.build) ??
        services[0];
      if (typeof svc?.image === 'string' && svc.image && !svc.build) return svc.image;
      if (typeof svc?.image === 'string' && svc.image) {
        // build + explicit image tag → compose tags the build result with it
        return svc.image;
      }
      if (!svc?.build) return null;
      const project = path.basename(appDir).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const candidates = [`${project}-${svcName}`, `${project}_${svcName}`];
      for (const tag of candidates) {
        try {
          await execFileAsync('docker', ['image', 'inspect', tag], { timeout: 10_000 });
          return tag;
        } catch {}
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Blue-green canary: boot a throwaway container from the freshly built
   * image BEFORE touching the running stack. Catches the most common bad
   * deploy — code that builds fine but crashes at startup (missing env,
   * bad import, migration explosion) — while the previous version is
   * still serving. Canary fails → deploy aborts → zero downtime.
   *
   * The canary runs with NO published ports and NO volumes (sharing a
   * data volume with the live container risks corruption), under a
   * unique name, attached to the app's networks so DB sidecars and
   * project siblings resolve like in production.
   *
   * Returns true when the container is still running after `holdMs`.
   * On failure the canary's last log lines are appended to the build log
   * so the user sees WHY it crashed without ssh'ing anywhere.
   */
  private async canaryBoot(
    image: string,
    opts: {
      env?: Record<string, string> | null;
      networks?: string[];
      log: (s: string) => void;
      holdMs?: number;
    },
  ): Promise<boolean> {
    const name = `dockcontrol-canary-${crypto.randomBytes(6).toString('hex')}`;
    // Hold window env-tunable: ops can lengthen for slow-boot apps
    // (DOCKCONTROL_CANARY_HOLD_MS=30000) or set 0 to skip the wait entirely.
    const envHold = Number(process.env.DOCKCONTROL_CANARY_HOLD_MS);
    const holdMs = opts.holdMs ?? (Number.isFinite(envHold) ? envHold : 10_000);
    const args = ['run', '-d', '--name', name, '--label', 'dockcontrol.canary=1'];
    const networks = opts.networks?.filter(Boolean) ?? [];
    if (networks.length > 0) args.push('--network', networks[0]);
    for (const [k, v] of Object.entries(opts.env || {})) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(image);
    opts.log(`> canary boot: ${image} (${holdMs / 1000}s hold)`);
    try {
      await execFileAsync('docker', args, { timeout: 60_000 });
      for (const net of networks.slice(1)) {
        await execFileAsync('docker', ['network', 'connect', net, name], { timeout: 10_000 }).catch(() => {});
      }
      const deadline = Date.now() + holdMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1_000));
        const insp = await execFileAsync(
          'docker',
          ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name],
          { timeout: 10_000 },
        );
        const [running, exitCode] = insp.stdout.trim().split(' ');
        if (running !== 'true') {
          const logsOut = await execFileAsync('docker', ['logs', '--tail', '30', name], { timeout: 10_000 })
            .then((r) => (r.stdout + r.stderr).trim())
            .catch(() => '');
          opts.log(`✖ canary exited (code ${exitCode}) — the new version crashes at startup. Previous version keeps serving.`);
          if (logsOut) opts.log(`--- canary logs ---\n${logsOut}\n-------------------`);
          return false;
        }
      }
      opts.log('✓ canary healthy — swapping containers');
      return true;
    } catch (e: any) {
      // `docker run` itself failed (bad entrypoint, missing platform…) —
      // treat as a failed canary, not an infra error: the OLD version is
      // still up and that's the state we want to preserve.
      opts.log(`✖ canary could not start: ${(e?.stderr || e?.message || e).toString().slice(0, 500)}`);
      return false;
    } finally {
      await execFileAsync('docker', ['rm', '-f', name], { timeout: 15_000 }).catch(() => {});
    }
  }

  private async waitForHealthy(appDir: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await dockerCompose(appDir, ['ps', '--format', 'json'], undefined, 5_000);
        if (stdout.trim()) {
          const lines = stdout.split('\n').filter(Boolean);
          const states = lines.map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean) as any[];
          if (states.length === 0) {
            // some docker versions output a single JSON array
            try {
              const arr = JSON.parse(stdout);
              if (Array.isArray(arr)) states.push(...arr);
            } catch {}
          }
          const allHealthyOrUp = states.length > 0 && states.every((s) => {
            const st = (s.State || s.state || '').toLowerCase();
            const h = (s.Health || s.health || '').toLowerCase();
            if (h === 'starting') return false;
            if (h === 'unhealthy') return false;
            return st === 'running';
          });
          if (allHealthyOrUp) return true;
          // any exited / dead → fail fast
          if (states.some((s) => {
            const st = (s.State || s.state || '').toLowerCase();
            return st === 'exited' || st === 'dead' || st === 'oomkilled';
          })) {
            return false;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return false;
  }
}
