import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { DomainAttachService } from '../domains/domain-attach.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { AppStatus, DeploymentStatus } from '@prisma/client';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { AgentService } from '../agent/agent.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const APPS_DIR = path.join(DATA_DIR, 'apps');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLocalServer(host: string | null | undefined): boolean {
  if (!host) return true;
  return LOCAL_HOSTS.has(host);
}

// ── helpers ──────────────────────────────────────────────────────────────

// Identical to the agent's `sanitize()` — must stay byte-for-byte equivalent.
function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
}

function containerName(slug: string) {
  return `kryptalis-${slug}`;
}

function imageName(slug: string) {
  return `kryptalis/${slug}:latest`;
}

/**
 * Resolve the on-disk compose dir for an application. Marketplace multi-install
 * apps (webmail) use `<slug>-<applicationId.slice(0,12)>`; everything else uses
 * the legacy `<slug>` dir. Picks whichever one actually exists on disk; falls
 * back to the legacy dir when neither exists so the caller can still write a
 * fresh deploy there.
 */
function resolveAppDir(slug: string, applicationId: string): string {
  const perInstance = path.join(APPS_DIR, `${slug}-${applicationId.slice(0, 12)}`);
  if (fs.existsSync(perInstance)) return perInstance;
  return path.join(APPS_DIR, slug);
}

/**
 * Resolve the docker container_name for an application. Marketplace multi-
 * install apps suffix with `-<applicationId.slice(0,12)>` so several instances
 * of the same image can coexist on one host. Detection is based on the on-disk
 * dir layout (which is what the install path actually creates).
 */
function resolveContainerName(slug: string, applicationId: string): string {
  const perInstance = path.join(APPS_DIR, `${slug}-${applicationId.slice(0, 12)}`);
  if (fs.existsSync(perInstance)) return `kryptalis-${slug}-${applicationId.slice(0, 12)}`;
  return `kryptalis-${slug}`;
}

export interface PortDef {
  service: string;
  host: number | null;
  container: number;
  protocol: string;
}

function parseComposePorts(content: string): PortDef[] {
  try {
    const doc: any = yaml.load(content);
    if (!doc?.services) return [];
    const out: PortDef[] = [];
    for (const [svc, val] of Object.entries<any>(doc.services)) {
      const ports = val?.ports;
      if (!Array.isArray(ports)) continue;
      for (const p of ports) {
        if (typeof p === 'string') {
          // forms: "8080", "8080:80", "127.0.0.1:8080:80", "8080:80/tcp"
          const [spec, proto] = p.split('/');
          const parts = spec.split(':');
          let host: number | null = null;
          let container: number;
          if (parts.length === 1) {
            container = Number(parts[0]);
          } else if (parts.length === 2) {
            host = Number(parts[0]);
            container = Number(parts[1]);
          } else {
            host = Number(parts[1]);
            container = Number(parts[2]);
          }
          if (Number.isFinite(container)) {
            out.push({ service: svc, host, container, protocol: proto || 'tcp' });
          }
        } else if (typeof p === 'object' && p !== null) {
          out.push({
            service: svc,
            host: p.published != null ? Number(p.published) : null,
            container: Number(p.target),
            protocol: p.protocol || 'tcp',
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parseDockerfileExposed(content: string): number[] {
  const out: number[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*EXPOSE\s+(.+)$/i);
    if (m) {
      for (const tok of m[1].split(/\s+/)) {
        const n = Number(tok.split('/')[0]);
        if (Number.isFinite(n)) out.push(n);
      }
    }
  }
  return out;
}

function remapComposePorts(content: string, mapping: Record<string, number>): string {
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  for (const val of Object.values<any>(doc.services)) {
    if (!Array.isArray(val?.ports)) continue;
    val.ports = val.ports.map((p: any) => {
      if (typeof p === 'string') {
        const [spec, proto] = p.split('/');
        const parts = spec.split(':');
        let host: number | null = null;
        let container: number;
        let bindIp = '';
        if (parts.length === 1) {
          container = Number(parts[0]);
        } else if (parts.length === 2) {
          host = Number(parts[0]);
          container = Number(parts[1]);
        } else {
          bindIp = parts[0];
          host = Number(parts[1]);
          container = Number(parts[2]);
        }
        const newHost = mapping[String(container)] ?? host ?? container;
        const base = bindIp
          ? `${bindIp}:${newHost}:${container}`
          : `${newHost}:${container}`;
        return proto ? `${base}/${proto}` : base;
      }
      if (typeof p === 'object' && p?.target != null) {
        const tgt = Number(p.target);
        const newHost = mapping[String(tgt)] ?? p.published ?? tgt;
        return { ...p, published: newHost, target: tgt };
      }
      return p;
    });
  }
  return yaml.dump(doc, { lineWidth: 200 });
}

function injectComposeEnv(content: string, env: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return content;
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  for (const val of Object.values<any>(doc.services)) {
    val.environment = { ...(val.environment || {}), ...env };
  }
  return yaml.dump(doc, { lineWidth: 200 });
}

/**
 * Attach every service in the compose file to a shared external network so apps
 * of the same project can reach each other by service name.
 */
function attachProjectNetwork(content: string, networkName: string): string {
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  for (const val of Object.values<any>(doc.services)) {
    const existing = val.networks;
    if (Array.isArray(existing)) {
      if (!existing.includes('kryptalis_project')) existing.push('kryptalis_project');
    } else if (existing && typeof existing === 'object') {
      existing.kryptalis_project = {};
    } else {
      val.networks = ['kryptalis_project'];
    }
  }
  doc.networks = {
    ...(doc.networks || {}),
    kryptalis_project: { external: true, name: networkName },
  };
  return yaml.dump(doc, { lineWidth: 200 });
}

function projectNetworkName(projectId: string) {
  return `kryptalis_proj_${projectId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
}

// command argv builder, no shell interpolation
async function dockerCompose(
  appDir: string,
  args: string[],
  envFile?: string,
  timeoutMs = 300_000,
) {
  const argv = ['compose'];
  if (envFile) argv.push('--env-file', envFile);
  argv.push(...args);
  return execFileAsync('docker', argv, { cwd: appDir, timeout: timeoutMs });
}

// ── service ──────────────────────────────────────────────────────────────

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    private agent: AgentService,
    private domainAttach: DomainAttachService,
    private encryption: EncryptionService,
  ) {}

  /**
   * Resolve the server an app runs on. Loads { id, host } off project.serverId,
   * caches nothing — calls are cheap and we want fresh status.
   */
  private async resolveAppServer(appId: string) {
    const app = await this.prisma.application.findUnique({
      where: { id: appId },
      select: {
        project: { select: { server: { select: { id: true, host: true } } } },
      },
    });
    return app?.project?.server ?? null;
  }

  private isAppLocal(server: { host: string } | null): boolean {
    if (!server) return true;
    return isLocalServer(server.host);
  }

  // ── access control (RBAC via ProjectMember) ───────────────────────

  private async assertOwnership(
    userId: string,
    appId: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'DEVELOPER',
  ) {
    const app = await this.prisma.application.findUnique({
      where: { id: appId },
    });
    if (!app) throw new NotFoundException('Application not found');
    await assertProjectAccess(this.prisma, userId, app.projectId, minRole);
    return app;
  }

  private async assertProjectOwnership(
    userId: string,
    projectId: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'DEVELOPER',
  ) {
    await assertProjectAccess(this.prisma, userId, projectId, minRole);
  }

  // ── create / deploy ────────────────────────────────────────────────

  async create(userId: string, dto: CreateApplicationDto) {
    await this.assertProjectOwnership(userId, dto.projectId);

    const {
      gitProviderId,
      gitToken,
      composeOverride,
      dockerfileOverride,
      portMapping,
      domainId,
      envVars: dtoEnvVars,
      ...dbData
    } = dto;

    // canonical port = first host port in mapping (used by the dashboard URL)
    const firstMappedHost = portMapping
      ? Object.values(portMapping).find((n) => Number.isFinite(n))
      : undefined;

    // If the user explicitly provided a port (or a port mapping) at create
    // time, mark customPort=true so the URL displayed (and the Caddy block)
    // includes the port. Git-deploy apps that ship a compose with hardcoded
    // ports also count — the user knows that port belongs in the URL.
    const userPickedPort = !!(firstMappedHost || dbData.port);

    // Up-front port collision check so the user gets a clear error in the
    // create dialog instead of a cryptic "docker compose up failed" 30s
    // into the deploy. Only applies when the user actually picked a host
    // port (mapping or dbData.port). Marketplace already does this; do it
    // here for manual create too.
    const portToCheck = (firstMappedHost as number | undefined) ?? dbData.port;
    if (portToCheck && typeof portToCheck === 'number') {
      // Scope the port-conflict check to the target SERVER, not globally.
      // Two apps on different hosts can share the same host port — they
      // never collide on a single Docker daemon.
      const targetProject = await this.prisma.project.findUnique({
        where: { id: dbData.projectId },
        select: { serverId: true },
      });
      const otherUsed = await this.prisma.application.findFirst({
        where: {
          port: portToCheck,
          project: { serverId: targetProject?.serverId },
        },
        select: { id: true, name: true, projectId: true },
      });
      if (otherUsed) {
        const sameProject = otherUsed.projectId === dbData.projectId;
        throw new ConflictException(
          sameProject
            ? `Port ${portToCheck} is already used by "${otherUsed.name}" in this project. Pick another host port.`
            : `Port ${portToCheck} is already in use on this server. Pick another host port.`,
        );
      }
    }

    const app = await this.prisma.application.create({
      data: {
        ...dbData,
        gitProviderId: gitProviderId || null,
        portMapping: portMapping || undefined,
        port: firstMappedHost ?? dbData.port,
        customPort: userPickedPort,
        status: 'DEPLOYING',
        envVars: this.encryptEnvVars(dtoEnvVars) as any,
        webhookSecret: this.encryption.encrypt(crypto.randomBytes(24).toString('hex')),
      },
    });

    // Hook the new app into a domain if one was picked. Same rules as the
    // marketplace flow: clean-URL apps grab the :443 slot, port-pinned apps
    // register a port binding, conflicts surface uniformly.
    if (domainId) {
      try {
        await this.domainAttach.attach({
          applicationId: app.id,
          domainId,
          projectId: dto.projectId,
          customPort: userPickedPort,
          port: app.port ?? 80,
        });
        this.proxy.regenerate().catch(() => {});
      } catch (err: any) {
        // Domain attach failed (conflict, etc.) — the app is created anyway,
        // and the deploy continues. The error surfaces in the deploy logs so
        // the user can fix it from the app's Settings tab.
        await this.prisma.application.update({
          where: { id: app.id },
          data: { status: 'ERROR' },
        });
        throw err;
      }
    }

    // resolve auth url WITHOUT persisting token in url
    let cloneUrl: string | undefined = dto.gitUrl || undefined;
    let cloneHeader: string | undefined;
    if (dto.gitUrl && gitProviderId) {
      const gp = await this.prisma.gitProvider.findFirst({
        where: { id: gitProviderId, userId },
      });
      if (!gp) throw new ForbiddenException('Git provider not yours');
      cloneHeader = this.buildAuthHeader(gp.provider, this.encryption.decrypt(gp.token));
    } else if (dto.gitUrl && gitToken) {
      // one-shot token: still inject via http header, never written to .git/config
      cloneHeader = `Authorization: Bearer ${gitToken}`;
    }

    const deployment = await this.prisma.deployment.create({
      data: {
        applicationId: app.id,
        status: 'PENDING',
        triggeredById: userId,
      },
    });

    if (dto.gitUrl) {
      this.runDeploy(deployment.id, app.id, dto.name, cloneUrl!, dto.gitBranch || 'main', {
        port: dto.port,
        envVars: dto.envVars,
        buildCommand: dto.buildCommand,
        startCommand: dto.startCommand,
        cloneHeader,
        composeOverride,
        dockerfileOverride,
        portMapping,
      }).catch(() => {});
    } else if (dto.dockerImage) {
      // Docker-image-only deploy: synthesize a minimal docker-compose.yml so
      // the rest of the lifecycle (start/stop/restart/logs/redeploy) is
      // identical to a git-deploy app. No clone, no build.
      this.runDockerImageDeploy(deployment.id, app.id, dto.name, dto.dockerImage, {
        port: dto.port,
        envVars: dto.envVars,
      }).catch(() => {});
    } else {
      await this.prisma.application.update({ where: { id: app.id }, data: { status: 'STOPPED' } });
      await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
    }

    return app;
  }

  /**
   * Pull-and-run path for "I just want this Docker image" deploys. Writes a
   * synthesized docker-compose.yml into the app dir so the agent + dashboard
   * treat it like any other compose stack — start/stop/restart all keep
   * working, and a redeploy means "re-pull + recreate".
   */
  private async runDockerImageDeploy(
    deploymentId: string,
    appId: string,
    name: string,
    image: string,
    opts: { port?: number; envVars?: Record<string, string> },
  ) {
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
        try { await dockerCompose(appDir, ['down', '-v', '--remove-orphans'], undefined, 60_000); } catch {}
        fs.rmSync(appDir, { recursive: true, force: true });
      }
      fs.mkdirSync(appDir, { recursive: true });

      const env = opts.envVars || {};
      const envBlock = Object.keys(env).length
        ? `    environment:\n${Object.entries(env).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n')}\n`
        : '';
      const portsBlock = opts.port ? `    ports:\n      - "${opts.port}:${opts.port}"\n` : '';
      const networksBlock = projectNet
        ? `    networks:\n      - kryptalis_project\nnetworks:\n  kryptalis_project:\n    external: true\n    name: ${projectNet}\n`
        : '';

      const compose = `services:
  app:
    image: ${image}
    container_name: ${containerNm}
    restart: unless-stopped
${envBlock}${portsBlock}    pull_policy: always
${networksBlock}`;
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
      log('> wrote docker-compose.yml');

      log(`> docker compose pull`);
      await dockerCompose(appDir, ['pull'], undefined, 300_000);
      log(`> docker compose up -d`);
      await dockerCompose(appDir, ['up', '-d', '--remove-orphans'], undefined, 180_000);

      await this.prisma.application.update({
        where: { id: appId },
        data: {
          status: AppStatus.RUNNING,
          containerName: containerNm,
          containerPort: opts.port ?? null,
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
    }
  }

  private buildAuthHeader(provider: string, token: string): string {
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

  private async runDeploy(
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

    // Resolve the project scope so we can attach this app to the per-project
    // docker network — enables service-name DNS between apps of the same project.
    const appRow = await this.prisma.application.findUnique({
      where: { id: appId },
      select: {
        projectId: true,
        project: { select: { server: { select: { id: true, host: true } } } },
      },
    });
    const remoteServer = appRow?.project?.server && !isLocalServer(appRow.project.server.host)
      ? appRow.project.server
      : null;

    // Remote server → delegate the entire deploy to the agent.
    if (remoteServer) {
      try {
        log(`> dispatching deploy to remote server ${remoteServer.host}`);
        const task = await this.agent.enqueueAndWait(
          remoteServer.id,
          'DEPLOY',
          {
            slug,
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

    try {
      // 1. clean previous stack BEFORE wiping
      if (fs.existsSync(appDir)) {
        try {
          await dockerCompose(appDir, ['down', '-v', '--remove-orphans'], undefined, 60_000);
        } catch {}
        fs.rmSync(appDir, { recursive: true, force: true });
      }
      fs.mkdirSync(appDir, { recursive: true });

      // 2. clone with header (token not persisted)
      const cloneArgs = ['clone', '--depth', '1', '--branch', branch];
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
      const repoEnv = this.loadRepoEnvFiles(appDir);
      const mergedEnv: Record<string, string> = { ...repoEnv, ...(opts.envVars || {}) };
      if (Object.keys(mergedEnv).length) opts.envVars = mergedEnv;
      let envFile: string | undefined;
      if (opts.envVars && Object.keys(opts.envVars).length) {
        envFile = path.join(appDir, '.kryptalis.env');
        fs.writeFileSync(envFile, this.serializeEnv(opts.envVars));
        log(`> merged env (${Object.keys(repoEnv).length} from repo, ${Object.keys(opts.envVars).length} total)`);
        // persist (encrypted) so redeploy keeps the merge
        await this.prisma.application.update({
          where: { id: appId },
          data: { envVars: this.encryptEnvVars(opts.envVars) as any },
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

      const composePath = this.findComposePath(appDir);
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
        if (projectNet) content = attachProjectNetwork(content, projectNet);
        fs.writeFileSync(composePath!, content);

        log('> docker compose pull');
        const r1 = await dockerCompose(appDir, ['pull'], envFile, 600_000).catch((e: any) => ({ stdout: '', stderr: e?.stderr || e?.message || '' }));
        log(r1.stdout + r1.stderr);
        log('> docker compose up -d --build');
        const r2 = await dockerCompose(appDir, ['up', '-d', '--build'], envFile, 900_000);
        log(r2.stdout + r2.stderr);
      } else if (hasDockerfile) {
        const img = imageName(slug);
        const cname = containerName(slug);
        log(`> docker build -t ${img} .`);
        const rb = await execFileAsync('docker', ['build', '-t', img, '.'], { cwd: appDir, timeout: 900_000 });
        log(rb.stdout + rb.stderr);
        try { await execFileAsync('docker', ['rm', '-f', cname]); } catch {}
        // build run argv
        const runArgs = ['run', '-d', '--name', cname, '--restart', 'unless-stopped'];
        if (projectNet) {
          runArgs.push('--network', projectNet, '--network-alias', slug);
        }
        // env
        if (opts.envVars) {
          for (const [k, v] of Object.entries(opts.envVars)) {
            runArgs.push('-e', `${k}=${v}`);
          }
        }
        // ports — prefer EXPOSE detection if no explicit
        const exposed = parseDockerfileExposed(fs.readFileSync(dockerfilePath, 'utf-8'));
        const portMap: Array<[number, number]> = [];
        if (opts.portMapping) {
          for (const [ct, ht] of Object.entries(opts.portMapping)) {
            portMap.push([Number(ht), Number(ct)]);
          }
        } else if (opts.port) {
          portMap.push([opts.port, opts.port]);
        } else if (exposed.length) {
          for (const e of exposed) portMap.push([e, e]);
        }
        for (const [h, c] of portMap) runArgs.push('-p', `${h}:${c}`);
        runArgs.push(img);
        log(`> docker ${runArgs.join(' ')}`);
        const rr = await execFileAsync('docker', runArgs, { timeout: 120_000 });
        log(rr.stdout + rr.stderr);

        // generate compose mirror so start/stop/logs work uniformly
        const portsBlock = portMap.length
          ? `    ports:\n${portMap.map(([h, c]) => `      - "${h}:${c}"`).join('\n')}\n`
          : '';
        const envBlock = opts.envVars && Object.keys(opts.envVars).length
          ? `    environment:\n${Object.entries(opts.envVars).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n')}\n`
          : '';
        let composeContent = `services:\n  ${slug}:\n    image: ${img}\n    container_name: ${cname}\n    restart: unless-stopped\n${portsBlock}${envBlock}`;
        if (projectNet) composeContent = attachProjectNetwork(composeContent, projectNet);
        fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), composeContent);

        if (portMap.length === 0) {
          log('⚠ no port exposed — container started but not reachable from host');
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
        log('> docker compose up -d --build');
        const r = await dockerCompose(appDir, ['up', '-d', '--build'], envFile, 900_000);
        log(r.stdout + r.stderr);
      }

      // healthcheck: poll docker ps for up to 30s, expect at least one running container
      log('> healthcheck');
      const ok = await this.waitForHealthy(appDir, 30_000);
      if (!ok) throw new Error('Healthcheck failed — no container reached running state within 30s');

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
          // try to bring the existing compose back up (volumes/images survived)
          if (fs.existsSync(appDir) && this.findComposePath(appDir)) {
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
    }
  }

  private serializeEnv(env: Record<string, string>) {
    return Object.entries(env)
      .map(([k, v]) => {
        const safe = String(v).replace(/\n/g, '\\n');
        return `${k}=${safe}`;
      })
      .join('\n');
  }

  private findComposePath(dir: string): string | null {
    for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  // ── read / list ────────────────────────────────────────────────────

  /**
   * Map an Application row so the API surface exposes the user-friendly
   * name. `displayName` (when set) overrides `name` in the response, while
   * the original `name` (which drives slug/container/dir) is stashed in
   * `slugName` for advanced UI that needs both. The dashboard treats
   * `app.name` as the display name — no client-side changes required.
   */
  private withDisplayName<T extends { name: string; displayName?: string | null }>(
    app: T,
  ): T & { slugName: string } {
    const displayName = app.displayName || app.name;
    return { ...app, name: displayName, slugName: app.name };
  }

  async findAll(userId: string) {
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    if (projectIds.length === 0) return [];
    const apps = await this.prisma.application.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: 'desc' },
      include: {
        project: { select: { id: true, name: true } },
        // Both the clean-URL domain (apps.domains) AND port-pinned bindings
        // (apps.portBindings) are surfaced — the dashboard shows one URL per
        // entry. An app that owns Domain.applicationId AND has port bindings
        // on other domains shows multiple URLs in the same card.
        domains: { select: { id: true, domain: true, sslStatus: true } },
        portBindings: {
          select: {
            id: true,
            port: true,
            domain: { select: { id: true, domain: true, sslStatus: true } },
          },
        },
      },
    });
    const synced = await Promise.all(apps.map((app) => this.syncStatus(app)));
    return synced.map((a) => this.withDisplayName(a));
  }

  async findOne(userId: string, id: string) {
    const application = await this.prisma.application.findUnique({
      where: { id },
      include: {
        project: { include: { server: { select: { id: true, name: true } } } },
        domains: { select: { id: true, domain: true, sslStatus: true, status: true } },
        portBindings: {
          select: {
            id: true,
            port: true,
            domain: { select: { id: true, domain: true, sslStatus: true, status: true } },
          },
        },
      },
    });
    if (!application) throw new NotFoundException('Application not found');
    await assertProjectAccess(this.prisma, userId, application.projectId, 'VIEWER');
    return this.withDisplayName(application);
  }

  async update(userId: string, id: string, dto: UpdateApplicationDto) {
    await this.assertOwnership(userId, id, 'DEVELOPER');
    // Empty string on displayName means "revert to canonical name".
    const data: any = { ...dto };
    if (dto.displayName !== undefined && dto.displayName.trim() === '') {
      data.displayName = null;
    }
    const result = await this.prisma.application.update({ where: { id }, data });
    // if port changed and app is running, redeploy to apply
    if (dto.port !== undefined) {
      this.redeploy(userId, id).catch(() => {});
    }
    return this.withDisplayName(result);
  }

  async remove(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id, 'ADMIN');
    const slug = slugify(app.name);
    const server = await this.resolveAppServer(id);

    if (this.isAppLocal(server)) {
      const appDir = resolveAppDir(slug, id);
      if (fs.existsSync(appDir)) {
        try {
          await dockerCompose(appDir, ['down', '-v', '--remove-orphans'], undefined, 60_000);
        } catch {}
        try { fs.rmSync(appDir, { recursive: true, force: true }); } catch {}
      }
      // belt + suspenders: kill orphan containers for both naming schemes
      // (compose `down` may have missed them on a crashed install).
      try { await execFileAsync('docker', ['rm', '-f', containerName(slug)]); } catch {}
      try { await execFileAsync('docker', ['rm', '-f', `${containerName(slug)}-${id.slice(0, 12)}`]); } catch {}
    } else if (server) {
      // User-initiated delete → purge volumes (databases + uploads). The agent
      // defaults to keeping volumes (safe for migration); flip it on here.
      await this.agent.enqueueTask(server.id, 'REMOVE', {
        slug,
        containerName: containerName(slug),
        purgeVolumes: true,
      });
    }

    await this.prisma.application.delete({ where: { id } });
    this.proxy.regenerate().catch(() => {});
    return { message: 'Application deleted' };
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async start(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await this.resolveAppServer(id);
    if (this.isAppLocal(server)) {
      const appDir = resolveAppDir(slug, id);
      if (fs.existsSync(appDir)) {
        await dockerCompose(appDir, ['up', '-d'], undefined, 60_000);
      }
    } else if (server) {
      await this.agent.enqueueTask(server.id, 'START', { slug });
    }
    // Don't blindly flip the DB to RUNNING — the docker compose call returned
    // 0, but the container might still be crashlooping. syncStatus reads the
    // real docker ps state.
    return this.refreshAndReturn(id);
  }

  async stop(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await this.resolveAppServer(id);
    if (this.isAppLocal(server)) {
      const appDir = resolveAppDir(slug, id);
      if (fs.existsSync(appDir)) {
        await dockerCompose(appDir, ['stop'], undefined, 60_000);
      }
    } else if (server) {
      await this.agent.enqueueTask(server.id, 'STOP', { slug });
    }
    return this.refreshAndReturn(id);
  }

  async restart(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await this.resolveAppServer(id);
    if (this.isAppLocal(server)) {
      const appDir = resolveAppDir(slug, id);
      if (fs.existsSync(appDir)) {
        await dockerCompose(appDir, ['restart'], undefined, 60_000);
      }
    } else if (server) {
      await this.agent.enqueueTask(server.id, 'RESTART', { slug });
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
    const app = await this.assertOwnership(userId, id, 'DEVELOPER');

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
      await this.runDockerImageDeploy(deployment.id, app.id, app.name, app.dockerImage, {
        port: app.port ?? undefined,
        envVars: this.decryptEnvVars(app.envVars),
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
      if (gp) cloneHeader = this.buildAuthHeader(gp.provider, this.encryption.decrypt(gp.token));
    }

    const deployment = await this.prisma.deployment.create({
      data: { applicationId: id, status: 'PENDING', triggeredById: userId },
    });
    await this.prisma.application.update({
      where: { id },
      data: { status: AppStatus.DEPLOYING },
    });
    this.runDeploy(deployment.id, id, app.name, app.gitUrl, app.gitBranch || 'main', {
      port: app.port,
      envVars: this.decryptEnvVars(app.envVars),
      buildCommand: app.buildCommand,
      startCommand: app.startCommand,
      cloneHeader,
      portMapping: (app.portMapping as Record<string, number>) || undefined,
    }).catch(() => {});
    return { message: 'Redeploy triggered', deploymentId: deployment.id };
  }

  // ── logs / exec ────────────────────────────────────────────────────

  async getLogs(userId: string, id: string, lines = 100) {
    const app = await this.assertOwnership(userId, id);
    const slug = slugify(app.name);
    const server = await this.resolveAppServer(id);
    if (!this.isAppLocal(server) && server) {
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
    const app = await this.assertOwnership(userId, id);
    const slug = slugify(app.name);
    const cname = resolveContainerName(slug, id);
    const server = await this.resolveAppServer(id);

    if (!this.isAppLocal(server) && server) {
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
    const app = await this.assertOwnership(userId, id);
    const appDir = resolveAppDir(slugify(app.name), id);
    const p = this.findComposePath(appDir);
    if (!p) return { exists: false, content: '', path: null };
    return {
      exists: true,
      content: fs.readFileSync(p, 'utf-8'),
      path: path.basename(p),
    };
  }

  async writeComposeFile(userId: string, id: string, content: string) {
    const app = await this.assertOwnership(userId, id);
    if (typeof content !== 'string') throw new BadRequestException('content required');
    // validate yaml
    try { yaml.load(content); } catch (e: any) {
      throw new BadRequestException(`Invalid YAML: ${e?.message || e}`);
    }
    const appDir = resolveAppDir(slugify(app.name), id);
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
    const target = this.findComposePath(appDir) || path.join(appDir, 'docker-compose.yml');
    fs.writeFileSync(target, content);
    return { message: 'Compose updated', path: path.basename(target) };
  }

  async readDockerfile(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id);
    const appDir = resolveAppDir(slugify(app.name), id);
    const p = path.join(appDir, 'Dockerfile');
    if (!fs.existsSync(p)) return { exists: false, content: '' };
    return { exists: true, content: fs.readFileSync(p, 'utf-8') };
  }

  async writeDockerfile(userId: string, id: string, content: string) {
    const app = await this.assertOwnership(userId, id);
    if (typeof content !== 'string') throw new BadRequestException('content required');
    const appDir = resolveAppDir(slugify(app.name), id);
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Dockerfile'), content);
    return { message: 'Dockerfile updated' };
  }

  // ── ports ──────────────────────────────────────────────────────────

  async listPorts(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id);
    const appDir = resolveAppDir(slugify(app.name), id);
    const composePath = this.findComposePath(appDir);
    const fromCompose = composePath
      ? parseComposePorts(fs.readFileSync(composePath, 'utf-8'))
      : [];
    const dockerfilePath = path.join(appDir, 'Dockerfile');
    const exposed = fs.existsSync(dockerfilePath)
      ? parseDockerfileExposed(fs.readFileSync(dockerfilePath, 'utf-8'))
      : [];
    return { compose: fromCompose, dockerfileExposed: exposed, appPort: app.port };
  }

  async remapPorts(userId: string, id: string, mapping: Record<string, number>) {
    const app = await this.assertOwnership(userId, id);
    if (!mapping || typeof mapping !== 'object') {
      throw new BadRequestException('mapping required');
    }
    // detect host port conflict across other apps — a host port is a shared host resource.
    // Compare against BOTH the canonical app.port AND every value of portMapping (which can
    // expose several ports per app).
    const wanted = new Set<number>(
      Object.values(mapping).filter((n): n is number => Number.isFinite(n)),
    );
    const otherApps = await this.prisma.application.findMany({
      where: { id: { not: id } },
      select: { name: true, port: true, portMapping: true },
    });
    for (const o of otherApps) {
      const usedByOther: number[] = [];
      if (o.port) usedByOther.push(o.port);
      if (o.portMapping && typeof o.portMapping === 'object') {
        for (const v of Object.values(o.portMapping as Record<string, number>)) {
          if (Number.isFinite(v)) usedByOther.push(Number(v));
        }
      }
      for (const p of usedByOther) {
        if (wanted.has(p)) {
          throw new BadRequestException(`Port ${p} already used by ${o.name}`);
        }
      }
    }
    const appDir = resolveAppDir(slugify(app.name), id);
    const composePath = this.findComposePath(appDir);
    if (!composePath) throw new BadRequestException('No compose file');
    const content = fs.readFileSync(composePath, 'utf-8');
    const updated = remapComposePorts(content, mapping);
    fs.writeFileSync(composePath, updated);
    // canonical app port = first remapped host port (used by the dashboard URL)
    // Any explicit remap means the user is picking a port → customPort=true.
    const firstHost = wanted.values().next().value;
    await this.prisma.application.update({
      where: { id },
      data: {
        portMapping: mapping,
        ...(firstHost && firstHost !== app.port ? { port: firstHost } : {}),
        customPort: true,
      },
    });
    // Recreate the container so the new port binding takes effect. Compose's
    // `up -d` is idempotent — it stops/recreates ONLY services whose config
    // changed (i.e. the port-mapped one) and leaves the rest alone. Without
    // this the file is rewritten but the running container keeps the old
    // port until the next manual restart, which is the "ça fait rien" UX.
    try {
      await execFileAsync('docker', ['compose', 'up', '-d', '--remove-orphans'], {
        cwd: appDir,
        timeout: 120_000,
      });
    } catch (err: any) {
      // Surface the failure but don't roll back the DB — the file is correct
      // on disk; the user can hit "Redeploy" to retry.
      throw new BadRequestException(
        `Ports written but docker compose up failed: ${err?.stderr || err?.message || 'unknown'}`,
      );
    }
    this.proxy.regenerate().catch(() => {});
    return { message: 'Ports remapped and container restarted', mapping };
  }

  /**
   * Toggle how the app's URL is exposed:
   *   - customPort=false → Caddy serves https://<domain> on :443 (clean URL)
   *   - customPort=true  → 308-redirect to https://<domain>:<port> (port-pinned)
   * Updates the DB row and asks Caddy to regenerate so the change takes effect
   * within seconds. The user can flip back and forth without touching the
   * compose file.
   */
  async setUrlMode(userId: string, id: string, customPort: boolean) {
    await this.assertOwnership(userId, id);
    const updated = await this.prisma.application.update({
      where: { id },
      data: { customPort: !!customPort },
      select: { id: true, customPort: true, port: true },
    });
    this.proxy.regenerate().catch(() => {});
    return updated;
  }

  /**
   * Add a (domain, port) → this app binding. Lets the user co-host this app
   * on a domain that already serves another app on a different port. Delegates
   * to DomainAttachService so the conflict rules stay consistent with what
   * the marketplace / git-deploy use.
   */
  async addPortBinding(userId: string, appId: string, domainId: string, port: number) {
    const app = await this.assertOwnership(userId, appId);
    await this.domainAttach.attach({
      applicationId: appId,
      domainId,
      projectId: app.projectId,
      customPort: true,
      port,
    });
    this.proxy.regenerate().catch(() => {});
    return this.prisma.domainPortBinding.findUnique({
      where: { domainId_port: { domainId, port } },
    });
  }

  /** Remove one port binding. Ownership check goes through the bound app. */
  async removePortBinding(userId: string, bindingId: string) {
    const binding = await this.prisma.domainPortBinding.findUnique({
      where: { id: bindingId },
    });
    if (!binding) throw new NotFoundException('Binding not found');
    await this.assertOwnership(userId, binding.applicationId);
    await this.prisma.domainPortBinding.delete({ where: { id: bindingId } });
    this.proxy.regenerate().catch(() => {});
    return { message: 'Binding removed' };
  }

  // ── env vars ───────────────────────────────────────────────────────

  async getEnv(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id);
    return { envVars: this.decryptEnvVars(app.envVars) };
  }

  async setEnv(userId: string, id: string, envVars: Record<string, string>) {
    await this.assertOwnership(userId, id);
    if (!envVars || typeof envVars !== 'object') {
      throw new BadRequestException('envVars required');
    }
    return this.prisma.application.update({
      where: { id },
      data: { envVars: this.encryptEnvVars(envVars) as any },
    });
  }

  // ── envVars at-rest encryption ────────────────────────────────────
  //
  // App env vars routinely carry production secrets (DATABASE_URL, JWT
  // SECRETs, third-party API keys, etc.). We persist the JSON blob as
  // `{ __k: 1, v: '<encrypted-utf8>' }` so the read path can detect the
  // wrapper and decrypt, while legacy plaintext rows are still readable
  // (they don't have __k).
  private encryptEnvVars(envVars: Record<string, string> | null | undefined): any {
    if (!envVars || Object.keys(envVars).length === 0) return envVars;
    return { __k: 1, v: this.encryption.encrypt(JSON.stringify(envVars)) };
  }

  private decryptEnvVars(raw: any): Record<string, string> {
    if (!raw) return {};
    if (typeof raw === 'object' && (raw as any).__k === 1 && typeof (raw as any).v === 'string') {
      try {
        return JSON.parse(this.encryption.decrypt((raw as any).v));
      } catch {
        return {};
      }
    }
    // Legacy plaintext shape: { KEY: VALUE, ... }
    return raw as Record<string, string>;
  }

  // ── webhooks ──────────────────────────────────────────────────────

  async getWebhook(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id);
    const base = process.env.PUBLIC_API_URL || process.env.API_URL || '';
    return {
      url: `${base.replace(/\/$/, '')}/api/webhooks/applications/${id}`,
      // Decrypted on the way out so the user can copy it into their
      // GitHub/GitLab webhook config.
      secret: app.webhookSecret ? this.encryption.decrypt(app.webhookSecret) : null,
      autoDeploy: app.autoDeploy,
      contentType: 'application/json',
    };
  }

  async rotateWebhookSecret(userId: string, id: string) {
    await this.assertOwnership(userId, id, 'ADMIN');
    const secret = crypto.randomBytes(24).toString('hex');
    await this.prisma.application.update({
      where: { id },
      data: { webhookSecret: this.encryption.encrypt(secret) },
    });
    return { secret };
  }

  async setAutoDeploy(userId: string, id: string, enabled: boolean) {
    await this.assertOwnership(userId, id);
    return this.prisma.application.update({
      where: { id },
      data: { autoDeploy: !!enabled },
      select: { id: true, autoDeploy: true },
    });
  }

  async listDeployments(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.deployment.findMany({
      where: { applicationId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getDeployment(userId: string, appId: string, depId: string) {
    await this.assertOwnership(userId, appId);
    const dep = await this.prisma.deployment.findFirst({
      where: { id: depId, applicationId: appId },
    });
    if (!dep) throw new NotFoundException('Deployment not found');
    return dep;
  }

  // ── status sync ────────────────────────────────────────────────────

  // priority (lowest → highest): .env.example → .env.production → .env → .env.local
  // user-supplied envVars wins over everything (merged by the caller).
  private loadRepoEnvFiles(appDir: string): Record<string, string> {
    const ordered = ['.env.example', '.env.local.example', '.env.production', '.env', '.env.local'];
    const out: Record<string, string> = {};
    for (const name of ordered) {
      const p = path.join(appDir, name);
      if (!fs.existsSync(p)) continue;
      try {
        const text = fs.readFileSync(p, 'utf-8');
        for (const raw of text.split('\n')) {
          const line = raw.replace(/\r$/, '');
          if (!line || line.startsWith('#')) continue;
          const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (!m) continue;
          let val = m[2].trim();
          // strip surrounding quotes
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          // strip trailing inline comment for unquoted values
          if (!m[2].startsWith('"') && !m[2].startsWith("'")) {
            const hash = val.indexOf(' #');
            if (hash !== -1) val = val.slice(0, hash).trimEnd();
          }
          // unescape \n only for double-quoted (already stripped) — best effort
          val = val.replace(/\\n/g, '\n');
          out[m[1]] = val;
        }
      } catch {}
    }
    return out;
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

  private async syncStatus(app: any) {
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
