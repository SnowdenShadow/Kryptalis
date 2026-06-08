import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { NotificationsService } from '../notifications/notifications.service';
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
import { isLocalHost, DeploymentTargetService } from '../deployment-target/deployment-target.service';
import { detectStack, FRAMEWORK_DOCKERFILES, FRAMEWORK_INTERNAL_PORT } from './dockerfile-templates';
import { DatabasesService } from '../databases/databases.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const APPS_DIR = path.join(DATA_DIR, 'apps');

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
  // Per-instance dir wins always when present.
  if (fs.existsSync(perInstance)) return perInstance;
  // Legacy <slug>-only dir, IF it's already there from a pre-migration
  // install. We DO NOT default to it for a brand-new app — two apps
  // with the same slugged name (e.g. "blog" and "Blog") would clobber
  // each other's compose stack.
  const legacy = path.join(APPS_DIR, slug);
  if (fs.existsSync(legacy)) return legacy;
  // Brand-new app — always create a per-instance dir so the slug
  // alone never has to be unique across the platform.
  return perInstance;
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

/**
 * Defensively ensure the shared kryptalis-apps bridge exists before any
 * `docker run --network kryptalis-apps`. The network is normally created
 * by the root docker-compose.yml, but on remote agents / standalone
 * boots it might be missing. Idempotent — `network create` returns
 * non-zero when it already exists, which we swallow.
 */
async function ensureSharedAppsNetwork(): Promise<void> {
  try {
    await execFileAsync('docker', ['network', 'inspect', 'kryptalis-apps'], { timeout: 5_000 });
  } catch {
    try {
      await execFileAsync('docker', ['network', 'create', 'kryptalis-apps'], { timeout: 10_000 });
    } catch {}
  }
}

/**
 * Attach every service of a compose file to the shared `kryptalis-apps`
 * bridge. Caddy lives on that bridge and reaches each container by
 * `container_name:internal_port`. This is what makes zero-host-port
 * deploys possible — multiple apps can listen on port 80 internally
 * without colliding.
 */
function attachSharedAppsNetwork(content: string): string {
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  for (const val of Object.values<any>(doc.services)) {
    const existing = val.networks;
    if (Array.isArray(existing)) {
      if (!existing.includes('kryptalis_apps')) existing.push('kryptalis_apps');
    } else if (existing && typeof existing === 'object') {
      existing.kryptalis_apps = {};
    } else {
      val.networks = ['kryptalis_apps'];
    }
  }
  doc.networks = {
    ...(doc.networks || {}),
    kryptalis_apps: { external: true, name: 'kryptalis-apps' },
  };
  return yaml.dump(doc, { lineWidth: 200 });
}

/**
 * Strip every `ports:` block from a compose file. Used when the app is
 * reached via Caddy on a domain — no host port publish is needed and
 * keeping one risks colliding with Kryptalis own services (the dashboard
 * on :3000, the API on :4000, postgres on :5432, etc).
 */
function stripComposePorts(content: string): string {
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  for (const val of Object.values<any>(doc.services)) {
    if (val && typeof val === 'object' && 'ports' in val) {
      delete val.ports;
    }
  }
  return yaml.dump(doc, { lineWidth: 200 });
}

/**
 * Pull the first declared container_name + first internal target port
 * from a compose file. Used to wire up Caddy's reverse_proxy target
 * without forcing a host port publish.
 */
function readComposeContainerInfo(
  content: string,
  fallbackContainerName: string,
): { containerName: string; containerPort: number | null } {
  try {
    const doc: any = yaml.load(content);
    if (!doc?.services) return { containerName: fallbackContainerName, containerPort: null };
    for (const [svc, val] of Object.entries<any>(doc.services)) {
      const cname = val?.container_name || `${fallbackContainerName}-${svc}`;
      let target: number | null = null;
      if (Array.isArray(val?.ports) && val.ports.length > 0) {
        const p = val.ports[0];
        if (typeof p === 'string') {
          const parts = p.split('/')[0].split(':');
          // forms: "8080" | "8080:80" | "127.0.0.1:8080:80"
          target = Number(parts[parts.length - 1]);
        } else if (typeof p === 'object' && p?.target != null) {
          target = Number(p.target);
        }
      }
      return {
        containerName: cname,
        containerPort: Number.isFinite(target as number) ? (target as number) : null,
      };
    }
  } catch {}
  return { containerName: fallbackContainerName, containerPort: null };
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

/**
 * Host ports reserved by Kryptalis itself + common system ports. Any
 * attempt to publish an app here is refused with a clear error so the
 * user doesn't break their own dashboard / API / DB connection.
 */
const RESERVED_HOST_PORTS = new Set<number>([
  22,    // ssh
  80, 443, // caddy
  3000,  // kryptalis-dashboard
  4000,  // kryptalis-api
  5432,  // postgres
  6379,  // redis
  2019,  // caddy admin API
  53,    // dns
  25, 465, 587, 993, 995, 110, 143, // mail
]);

// ── service ──────────────────────────────────────────────────────────────

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    private agent: AgentService,
    private domainAttach: DomainAttachService,
    private encryption: EncryptionService,
    private notifications: NotificationsService,
    private deploymentTarget: DeploymentTargetService,
    private databases: DatabasesService,
  ) {}

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
    return isLocalHost(server.host);
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
      composeContent,
      dockerfileContent,
      contextFiles,
      portMapping,
      domainId: dtoDomainId,
      domain: dtoDomainString,
      envVars: dtoEnvVars,
      hostPort: dtoHostPort,
      ...dbData
    } = dto;

    // ── PRE-WRITE VALIDATION ───────────────────────────────────────
    // Every validation rule runs BEFORE any DB mutation. A failure
    // here leaves no orphan rows. The actual create + domain attach
    // happen inside a single Prisma $transaction so either both
    // succeed or neither does.

    // 1) Blank scaffold + domain = nonsense. There's no service to
    // route the domain to, ever. A raw compose/Dockerfile counts as a
    // real source — only refuse when ALL deploy inputs are absent.
    const isBlankScaffold =
      !dto.gitUrl && !dto.dockerImage && !composeContent && !dockerfileContent;
    if (isBlankScaffold && (dtoDomainId || dtoDomainString)) {
      throw new BadRequestException(
        'Cannot attach a domain to a blank app — add a Git URL, Docker image, Compose file, or Dockerfile first.',
      );
    }
    // 2) Blank scaffold + hostPort = also nonsense: no container is
    // ever published. Refuse to reserve the port.
    if (isBlankScaffold && dtoHostPort) {
      throw new BadRequestException(
        'Cannot reserve a host port on a blank app — add a Git URL, Docker image, Compose file, or Dockerfile first.',
      );
    }

    // Mutually exclusive: only one source-of-truth wins. Refuse early
    // so we don't have to guess which path the user meant.
    const sourcesPicked = [
      !!dto.gitUrl,
      !!dto.dockerImage,
      !!composeContent,
      !!dockerfileContent,
    ].filter(Boolean).length;
    if (sourcesPicked > 1) {
      throw new BadRequestException(
        'Pick one source: Git URL, Docker image, raw Compose, or raw Dockerfile.',
      );
    }

    // Compose YAML must parse — defense against typos and YAML injection.
    if (composeContent) {
      try {
        const parsed: any = yaml.load(composeContent);
        if (!parsed || typeof parsed !== 'object' || !parsed.services || typeof parsed.services !== 'object') {
          throw new Error('compose must have a top-level "services:" map');
        }
      } catch (err: any) {
        throw new BadRequestException(`Invalid docker-compose.yml: ${err?.message || 'parse error'}`);
      }
    }
    if (dockerfileContent && !/^\s*FROM\s+\S+/im.test(dockerfileContent)) {
      throw new BadRequestException('Dockerfile must contain a FROM instruction.');
    }
    if (contextFiles) {
      for (const rel of Object.keys(contextFiles)) {
        // Defense against path traversal — context files land in appDir.
        if (rel.startsWith('/') || rel.includes('..') || /[\0]/.test(rel) || rel.length > 256) {
          throw new BadRequestException(`Invalid context file path: ${rel}`);
        }
      }
    }

    // 3) Host-port reserved + collision check.
    if (dtoHostPort) {
      if (RESERVED_HOST_PORTS.has(dtoHostPort)) {
        throw new ConflictException(
          `Port ${dtoHostPort} is reserved by Kryptalis (dashboard/api/proxy/db). Pick another.`,
        );
      }
      const project = await this.prisma.project.findUnique({
        where: { id: dbData.projectId },
        select: { serverId: true },
      });
      const otherUsed = await this.prisma.application.findFirst({
        where: {
          hostPort: dtoHostPort,
          project: { serverId: project?.serverId },
        },
        select: { id: true, name: true },
      });
      if (otherUsed) {
        throw new ConflictException(
          `Port ${dtoHostPort} is already used by "${otherUsed.name}" on this server.`,
        );
      }
    }

    // 4) Existing-domain ownership check (when dtoDomainString points
    // at an already-stored hostname). The new-domain create branch
    // happens inside the transaction below.
    let existingDomainId: string | null = null;
    if (!dtoDomainId && dtoDomainString) {
      const existing = await this.prisma.domain.findUnique({
        where: { domain: dtoDomainString },
      });
      if (existing) {
        if (existing.projectId !== dto.projectId) {
          throw new BadRequestException(
            `Domain "${dtoDomainString}" already belongs to another project.`,
          );
        }
        existingDomainId = existing.id;
      }
    }

    // canonical port = first host port in mapping (used by the dashboard URL)
    const firstMappedHost = portMapping
      ? Object.values(portMapping).find((n) => Number.isFinite(n))
      : undefined;
    const userPickedPort = !!(firstMappedHost || dbData.port);

    // 5) Up-front port collision check for legacy port/portMapping
    // (advanced wizard path). Done BEFORE the transaction.
    const portToCheck = (firstMappedHost as number | undefined) ?? dbData.port;
    if (portToCheck && typeof portToCheck === 'number') {
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

    // ── ATOMIC WRITE ───────────────────────────────────────────────
    // Domain create-or-find + Application.create + Domain.applicationId
    // attach run together. Any failure rolls back everything; the user
    // never sees an orphan app row in ERROR state or a stale Domain row
    // bound to a non-existent app.
    // Phase 1 — create Domain row + Application row in a transaction.
    // We DO NOT call domainAttach.attach() inside the transaction because
    // that service uses this.prisma (not the tx), so the brand-new
    // Application row isn't visible to it yet and the FK update throws.
    const { app, domainId, createdDomainId } = await this.prisma.$transaction(async (tx) => {
      let domainId: string | null = dtoDomainId ?? existingDomainId;
      let createdDomainId: string | null = null;
      if (!domainId && dtoDomainString) {
        const created = await tx.domain.create({
          data: { domain: dtoDomainString, projectId: dto.projectId },
        });
        domainId = created.id;
        createdDomainId = created.id;
      }

      const newApp = await tx.application.create({
        data: {
          ...dbData,
          gitProviderId: gitProviderId || null,
          portMapping: portMapping || undefined,
          port: firstMappedHost ?? dbData.port,
          hostPort: dtoHostPort,
          customPort: userPickedPort,
          status: 'DEPLOYING',
          envVars: this.encryptEnvVars(dtoEnvVars) as any,
          webhookSecret: this.encryption.encrypt(crypto.randomBytes(24).toString('hex')),
        } as any,
      });

      return { app: newApp, domainId, createdDomainId };
    });

    // Phase 2 — attach the (now committed) Application to the Domain.
    // Done OUTSIDE the transaction so DomainAttachService sees the row.
    // If it throws (cross-project conflict, etc.), we manually roll back
    // both the App row and the newly-created Domain (if any) so the
    // user doesn't end up with orphan rows. Caddy regen still deferred.
    if (domainId) {
      try {
        await this.domainAttach.attach({
          applicationId: app.id,
          domainId,
          projectId: dto.projectId,
          customPort: userPickedPort,
          port: app.port ?? 80,
        });
      } catch (err) {
        await this.prisma.application.delete({ where: { id: app.id } }).catch(() => undefined);
        if (createdDomainId) {
          await this.prisma.domain.delete({ where: { id: createdDomainId } }).catch(() => undefined);
        }
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
      // One-shot PAT — detect the host so we pick the right scheme:
      //   - GitHub HTTPS clones need Basic x-access-token:<token>, NOT
      //     Bearer (returns 'token expired' otherwise even with a valid PAT).
      //   - GitLab accepts Bearer.
      //   - Bitbucket needs Basic x-token-auth:<token>.
      // Falls back to a generic Basic for everything else.
      const lc = (dto.gitUrl || '').toLowerCase();
      const inferred =
        lc.includes('github.com') ? 'GITHUB' :
        lc.includes('gitlab') ? 'GITLAB' :
        lc.includes('bitbucket') ? 'BITBUCKET' : 'OTHER';
      cloneHeader = this.buildAuthHeader(inferred, gitToken);
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
        hostPort: dtoHostPort,
      }).catch(() => {});
    } else if (dto.dockerImage) {
      // Docker-image-only deploy: synthesize a minimal docker-compose.yml so
      // the rest of the lifecycle (start/stop/restart/logs/redeploy) is
      // identical to a git-deploy app. No clone, no build.
      this.runDockerImageDeploy(deployment.id, app.id, dto.name, dto.dockerImage, {
        port: dto.port,
        envVars: dto.envVars,
        hostPort: dtoHostPort,
      }).catch(() => {});
    } else if (composeContent) {
      // Raw compose stack — no clone, no build. The user supplied the
      // entire stack as YAML. Lifecycle is identical to a git-cloned
      // compose project (start/stop/restart/logs all just shell out to
      // `docker compose` in appDir).
      this.runComposeOnlyDeploy(deployment.id, app.id, dto.name, composeContent, {
        envVars: dto.envVars,
        hostPort: dtoHostPort,
      }).catch(() => {});
    } else if (dockerfileContent) {
      // Raw Dockerfile + optional context files — we build the image
      // locally and run it. Same compose-mirror trick so lifecycle ops
      // keep working.
      this.runDockerfileOnlyDeploy(deployment.id, app.id, dto.name, dockerfileContent, {
        port: dto.port,
        envVars: dto.envVars,
        hostPort: dtoHostPort,
        contextFiles,
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
    opts: { port?: number; envVars?: Record<string, string>; hostPort?: number },
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
      const envBlock = Object.keys(env).length
        ? `    environment:\n${Object.entries(env).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n')}\n`
        : '';
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
      // shared kryptalis-apps bridge (so Caddy can resolve us by name
      // for HTTPS routing). Missing the second one → Caddy hits ENOTFOUND
      // on every request → 502. Same pattern as the compose-only and
      // marketplace install paths.
      const networks = ['kryptalis_apps'];
      if (projectNet) networks.unshift('kryptalis_project');
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
          ...(projectNet ? { kryptalis_project: { external: true, name: projectNet } } : {}),
          kryptalis_apps: { external: true, name: 'kryptalis-apps' },
        },
      };
      const compose = yaml.dump(composeDoc, { lineWidth: 200 });
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
      log('> wrote docker-compose.yml');

      log(`> docker compose pull`);
      await dockerCompose(appDir, ['pull'], undefined, 300_000);
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
  private async runComposeOnlyDeploy(
    deploymentId: string,
    appId: string,
    name: string,
    composeYaml: string,
    opts: { envVars?: Record<string, string> | null; hostPort?: number },
  ) {
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

      // Persist + write .env so secrets aren't inlined in the compose.
      let envFile: string | undefined;
      if (opts.envVars && Object.keys(opts.envVars).length) {
        envFile = path.join(appDir, '.kryptalis.env');
        fs.writeFileSync(envFile, this.serializeEnv(opts.envVars));
      }

      log('> docker compose pull');
      try { await dockerCompose(appDir, ['pull'], envFile, 300_000); } catch {}
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
          select: { projectId: true, project: { select: { serverId: true } } },
        });
        if (appRowForImport?.project?.serverId) {
          await this.databases.importFromAppCompose({
            applicationId: appId,
            projectId: appRowForImport.projectId,
            serverId: appRowForImport.project.serverId,
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
  private async runDockerfileOnlyDeploy(
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
            ...(projectNet ? { networks: ['kryptalis_project', 'kryptalis_apps'] } : { networks: ['kryptalis_apps'] }),
          },
        },
        networks: {
          ...(projectNet ? { kryptalis_project: { external: true, name: projectNet } } : {}),
          kryptalis_apps: { external: true, name: 'kryptalis-apps' },
        },
      };
      fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), yaml.dump(composeDoc, { lineWidth: 200 }));
      log('> wrote docker-compose.yml');

      log('> docker compose build');
      await dockerCompose(appDir, ['build'], undefined, 900_000);
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
      hostPort?: number;
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
      select: {
        projectId: true,
        project: { select: { server: { select: { id: true, host: true } } } },
      },
    });
    const remoteServer = appRow?.project?.server && !isLocalHost(appRow.project.server.host)
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

    try {
      // 1. clean previous stack BEFORE wiping. `down` without -v keeps
      // user volumes (DB, uploads) intact across redeploys. The remove
      // path elsewhere uses -v + --rmi to actually purge.
      if (fs.existsSync(appDir)) {
        try {
          await dockerCompose(appDir, ['down', '--remove-orphans'], undefined, 60_000);
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

      // Auto-detect the framework and generate a production Dockerfile
      // when the user didn't bring their own. This is the heart of the
      // "no Docker knowledge required" deploy: React/Vite/Next/Vue/Astro
      // /static repos get a clean nginx-or-node image with a fixed
      // internal port that Caddy reaches via container_name. The user
      // never picks a port.
      const composePathInitial = this.findComposePath(appDir);
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
              // Caddy reaches the app on the shared kryptalis-apps bridge
              // by container_name:internalPort — no host port publish, no
              // port collision possible.
              containerName: containerName(slug),
              containerPort: internalPort,
            },
          });
          opts.port = internalPort;
        }
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

        // Look up whether the app already has a domain attached. When it
        // does, Caddy will reach the container via the shared bridge —
        // so we strip the user's `ports:` blocks (which would otherwise
        // collide with platform services like the dashboard on :3000)
        // and replace them with kryptalis-apps network membership. The
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
        }

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

        // Resolve the container's internal port (EXPOSE in Dockerfile +
        // opts.port override). This is what Caddy will reverse_proxy to,
        // NOT a host port. The platform reaches the container through
        // the shared `kryptalis-apps` bridge — host port publish is
        // intentionally skipped so multiple apps can listen on port 80
        // without colliding.
        const exposed = parseDockerfileExposed(fs.readFileSync(dockerfilePath, 'utf-8'));
        const internalPort =
          opts.port ?? (exposed.length > 0 ? exposed[0] : undefined);

        // Build run argv. Attach to:
        //   1. kryptalis-apps  → Caddy proxies to <containerName>:<internalPort>
        //   2. projectNet      → sibling apps in the same project reach by name
        const runArgs = ['run', '-d', '--name', cname, '--restart', 'unless-stopped'];
        runArgs.push('--network', 'kryptalis-apps', '--network-alias', slug);
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
        const networksBlock = `    networks:\n      - kryptalis-apps${projectNet ? `\n      - ${projectNet}` : ''}\n`;
        const topLevelNetworks =
          `networks:\n  kryptalis-apps:\n    external: true${projectNet ? `\n  ${projectNet}:\n    external: true` : ''}\n`;
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
      // Refresh Caddy so the previous block (if any) reflects the
      // current state — either the rollback is up, or the app is down.
      this.proxy.regenerate().catch(() => {});
      this.notifyDeploymentOutcome(deploymentId, name, 'failed', msg);
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

  /**
   * Suggest the next free host port for a project's server. Walks
   * upward from 8080, skipping reserved system ports + any hostPort
   * already used by another app on the same server. Caps at 9999 so
   * we never return a port too close to the 65535 ceiling.
   */
  async suggestNextFreePort(userId: string, projectId: string): Promise<{ port: number }> {
    await this.assertProjectOwnership(userId, projectId);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { serverId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const taken = await this.prisma.application.findMany({
      where: {
        hostPort: { not: null },
        project: { serverId: project.serverId },
      },
      select: { hostPort: true },
    });
    const used = new Set<number>(taken.map((a) => a.hostPort!).filter((n) => !!n));
    for (let p = 8080; p <= 9999; p++) {
      if (RESERVED_HOST_PORTS.has(p)) continue;
      if (used.has(p)) continue;
      return { port: p };
    }
    throw new ConflictException('No free host port available in 8080-9999.');
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
          // Full purge: `down -v --rmi local` removes named volumes AND
          // the locally-built image. Without --rmi we'd leave dozens of
          // dangling `<slug>-<id>-web:latest` images per app rebuilt;
          // with it the docker volume list stays clean too. Skips
          // pulled images (postgres:16-alpine etc) — those are shared.
          await dockerCompose(appDir, ['down', '-v', '--rmi', 'local', '--remove-orphans'], undefined, 90_000);
        } catch {}
        try { fs.rmSync(appDir, { recursive: true, force: true }); } catch {}
      }
      // belt + suspenders: kill orphan containers for both naming schemes
      // (compose `down` may have missed them on a crashed install).
      try { await execFileAsync('docker', ['rm', '-f', containerName(slug)]); } catch {}
      try { await execFileAsync('docker', ['rm', '-f', `${containerName(slug)}-${id.slice(0, 12)}`]); } catch {}
      // Drop the per-project network if this app was the last in its
      // project — leaves shared networks alone.
      try {
        const otherApps = await this.prisma.application.count({
          where: { projectId: app.projectId, NOT: { id } },
        });
        if (otherApps === 0) {
          const projectNet = projectNetworkName(app.projectId);
          try { await execFileAsync('docker', ['network', 'rm', projectNet], { timeout: 10_000 }); } catch {}
        }
      } catch {}
    } else if (server) {
      // User-initiated delete → purge volumes (databases + uploads). The agent
      // defaults to keeping volumes (safe for migration); flip it on here.
      await this.agent.enqueueTask(server.id, 'REMOVE', {
        slug,
        containerName: containerName(slug),
        purgeVolumes: true,
      });
    }

    // Purge auto-imported Database rows BEFORE the app delete. The
    // schema uses SetNull cascade for application → database (so manual
    // DBs survive), so without this step the auto-imported registry
    // rows would linger and confuse the /databases dashboard.
    try { await this.databases.deleteAutoImportedForApp(id); } catch {}

    await this.prisma.application.delete({ where: { id } });
    this.proxy.regenerate().catch(() => {});
    return { message: 'Application deleted' };
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async start(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await this.resolveAppServer(id);
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
    const app = await this.assertOwnership(userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await this.resolveAppServer(id);
    const appDir = resolveAppDir(slug, id);
    if (!this.deploymentTarget.isLocal(server) || fs.existsSync(appDir)) {
      await this.deploymentTarget.composeStop(server, appDir);
    }
    return this.refreshAndReturn(id);
  }

  async restart(userId: string, id: string) {
    const app = await this.assertOwnership(userId, id, 'DEVELOPER');
    const slug = slugify(app.name);
    const server = await this.resolveAppServer(id);
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
