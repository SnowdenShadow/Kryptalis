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
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { AgentService } from '../agent/agent.service';
import { DatabasesService } from '../databases/databases.service';
import { ApplicationDeployService } from './application-deploy.service';
import { ApplicationOpsService } from './application-ops.service';
import { ApplicationNetworkService } from './application-network.service';
import { ApplicationEnvService } from './application-env.service';
import {
  execFileAsync,
  slugify,
  remoteAppSlug,
  containerName,
  resolveAppDir,
  projectNetworkName,
  dockerCompose,
  RESERVED_HOST_PORTS,
  resolveAppServer,
  isAppLocal,
} from './applications.helpers';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';

// Re-exported from applications.helpers so existing importers (the spec,
// and the agent-equivalence contract documented there) keep working.
export { slugify } from './applications.helpers';
export type { PortDef } from './applications.helpers';

// ── service ──────────────────────────────────────────────────────────────

/**
 * CRUD facade for applications. Deployment pipeline, runtime ops,
 * networking/ports and env-var handling live in the focused services
 * (ApplicationDeployService, ApplicationOpsService,
 * ApplicationNetworkService, ApplicationEnvService) — this class keeps
 * the create/find/update/remove logic and delegates everything else so
 * the controllers can keep injecting a single service.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    private agent: AgentService,
    private domainAttach: DomainAttachService,
    private encryption: EncryptionService,
    private databases: DatabasesService,
    private deployService: ApplicationDeployService,
    private ops: ApplicationOpsService,
    private network: ApplicationNetworkService,
    private env: ApplicationEnvService,
  ) {}

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
      serverId: dtoServerId,
      ...dbData
    } = dto;

    // Per-app server placement (MULTI mode). Stored only when it differs
    // from the project default — NULL serverId means "inherit", so moving
    // the project later carries inherit-apps along automatically.
    let appServerId: string | null = null;
    if (dtoServerId) {
      const target = await this.prisma.server.findUnique({ where: { id: dtoServerId } });
      if (!target) throw new NotFoundException('Server not found');
      if (target.status !== 'ONLINE') {
        throw new BadRequestException(`Server "${target.name}" is ${target.status} — choose an ONLINE server`);
      }
      const proj = await this.prisma.project.findUnique({
        where: { id: dto.projectId },
        select: { serverId: true },
      });
      if (proj && proj.serverId !== dtoServerId) appServerId = dtoServerId;
    }

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
    // hostPort counts as "user picked a port" too: domain + hostPort from
    // the unified deploy dialog means a port-pinned attach
    // (http://domain:hostPort via DomainPortBinding), NOT the clean-URL
    // :443 slot — same semantics as the marketplace install path.
    const userPickedPort = !!(firstMappedHost || dbData.port || dtoHostPort);

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
          serverId: appServerId,
          status: 'DEPLOYING',
          envVars: this.env.encryptEnvVars(dtoEnvVars) as any,
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
          // Port-pinned attach binds the host-side port the user reaches the
          // app at: hostPort (unified dialog) or the legacy port field.
          port: dtoHostPort ?? app.port ?? 80,
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
      cloneHeader = this.deployService.buildAuthHeader(gp.provider, this.encryption.decrypt(gp.token));
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
      cloneHeader = this.deployService.buildAuthHeader(inferred, gitToken);
    }

    const deployment = await this.prisma.deployment.create({
      data: {
        applicationId: app.id,
        status: 'PENDING',
        triggeredById: userId,
      },
    });

    if (dto.gitUrl) {
      this.deployService.runDeploy(deployment.id, app.id, dto.name, cloneUrl!, dto.gitBranch || 'main', {
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
      this.deployService.runDockerImageDeploy(deployment.id, app.id, dto.name, dto.dockerImage, {
        port: dto.port,
        envVars: dto.envVars,
        hostPort: dtoHostPort,
      }).catch(() => {});
    } else if (composeContent) {
      // Raw compose stack — no clone, no build. The user supplied the
      // entire stack as YAML. Lifecycle is identical to a git-cloned
      // compose project (start/stop/restart/logs all just shell out to
      // `docker compose` in appDir).
      this.deployService.runComposeOnlyDeploy(deployment.id, app.id, dto.name, composeContent, {
        envVars: dto.envVars,
        hostPort: dtoHostPort,
      }).catch(() => {});
    } else if (dockerfileContent) {
      // Raw Dockerfile + optional context files — we build the image
      // locally and run it. Same compose-mirror trick so lifecycle ops
      // keep working.
      this.deployService.runDockerfileOnlyDeploy(deployment.id, app.id, dto.name, dockerfileContent, {
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
        // server.host: the dashboard builds the IP:port fallback URL from it
        // — for apps on a remote server, linking to <platform-host>:<port>
        // would point at the wrong machine. app.server (per-app placement)
        // wins over the project default; the dashboard checks app.server
        // first via appServerHostname().
        server: { select: { id: true, name: true, host: true } },
        project: { select: { id: true, name: true, server: { select: { host: true } } } },
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
    const synced = await Promise.all(apps.map((app) => this.ops.syncStatus(app)));
    return synced.map((a) => this.withDisplayName(a));
  }

  async findOne(userId: string, id: string) {
    const application = await this.prisma.application.findUnique({
      where: { id },
      include: {
        server: { select: { id: true, name: true, host: true } },
        project: { include: { server: { select: { id: true, name: true, host: true } } } },
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
    const server = await resolveAppServer(this.prisma, id);

    if (isAppLocal(server)) {
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
      // slug: per-instance naming (new remote deploys); legacySlug: bare-slug
      // dirs from pre-convention installs. containerName: prefer the STORED
      // name (marketplace stamps kryptalis-<slug>-<id12>, custom installs
      // kryptalis-custom-<id12>) — the kryptalis-<slug> guess only as fallback.
      await this.agent.enqueueTask(server.id, 'REMOVE', {
        slug: remoteAppSlug(app.name, id),
        legacySlug: slug,
        containerName: app.containerName || containerName(slug),
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

  // ── lifecycle (delegated to ApplicationOpsService) ─────────────────

  start(userId: string, id: string) {
    return this.ops.start(userId, id);
  }

  stop(userId: string, id: string) {
    return this.ops.stop(userId, id);
  }

  restart(userId: string, id: string) {
    return this.ops.restart(userId, id);
  }

  redeploy(userId: string, id: string) {
    return this.ops.redeploy(userId, id);
  }

  rollback(userId: string, id: string, deploymentId: string) {
    return this.ops.rollback(userId, id, deploymentId);
  }

  // ── logs / exec (delegated) ────────────────────────────────────────

  getLogs(userId: string, id: string, lines = 100) {
    return this.ops.getLogs(userId, id, lines);
  }

  execCommand(userId: string, id: string, command: string) {
    return this.ops.execCommand(userId, id, command);
  }

  // ── files: compose / Dockerfile (delegated) ────────────────────────

  readComposeFile(userId: string, id: string) {
    return this.ops.readComposeFile(userId, id);
  }

  writeComposeFile(userId: string, id: string, content: string) {
    return this.ops.writeComposeFile(userId, id, content);
  }

  readDockerfile(userId: string, id: string) {
    return this.ops.readDockerfile(userId, id);
  }

  writeDockerfile(userId: string, id: string, content: string) {
    return this.ops.writeDockerfile(userId, id, content);
  }

  // ── ports / URL modes (delegated to ApplicationNetworkService) ─────

  suggestNextFreePort(userId: string, projectId: string) {
    return this.network.suggestNextFreePort(userId, projectId);
  }

  listPorts(userId: string, id: string) {
    return this.network.listPorts(userId, id);
  }

  remapPorts(userId: string, id: string, mapping: Record<string, number>) {
    return this.network.remapPorts(userId, id, mapping);
  }

  setUrlMode(userId: string, id: string, customPort: boolean) {
    return this.network.setUrlMode(userId, id, customPort);
  }

  addPortBinding(userId: string, appId: string, domainId: string, port: number) {
    return this.network.addPortBinding(userId, appId, domainId, port);
  }

  removePortBinding(userId: string, bindingId: string) {
    return this.network.removePortBinding(userId, bindingId);
  }

  // ── env vars (delegated to ApplicationEnvService) ──────────────────

  getEnv(userId: string, id: string) {
    return this.env.getEnv(userId, id);
  }

  setEnv(userId: string, id: string, envVars: Record<string, string>) {
    return this.env.setEnv(userId, id, envVars);
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
}
