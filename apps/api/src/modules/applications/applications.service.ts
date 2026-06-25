import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  type OnModuleInit,
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
import { DEFAULT_PHP_VERSION } from './php-site.constants';
import { SftpService } from '../sftp/sftp.service';
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
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { assertCloneHostAllowed } from '../git-providers/git-providers.service';
import { appVolumePrefix } from '../agent/volume-naming.util';
import { spawn } from 'child_process';
import * as path from 'path';
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
export class ApplicationsService implements OnModuleInit {
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
    private sftp: SftpService,
  ) {}

  // Register the linked-app refresher so DatabasesService can refresh + redeploy
  // an app after a DB credential change, WITHOUT a hard module cycle (the
  // Databases→Applications direction would otherwise be circular).
  onModuleInit() {
    this.databases.setAppRefresher((userId, appId, databaseId) =>
      this.refreshDatabaseEnv(userId, appId, databaseId),
    );
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
      serverId: dtoServerId,
      restoreVolumes: dtoRestoreVolumes,
      loadImages: dtoLoadImages,
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

    // A PHP_SITE is its OWN deploy source: it has no git/image/compose/
    // dockerfile input, but the platform generates a php:<ver>-apache stack and
    // serves an SFTP-uploaded docroot. So it must count as a real source for
    // the blank-scaffold guards below (a domain + the deploy are exactly the
    // point of the feature), AND be excluded from the mutually-exclusive count.
    const isPhpSite = dto.framework === 'PHP_SITE';

    // 1) Blank scaffold + domain = nonsense. There's no service to
    // route the domain to, ever. A raw compose/Dockerfile (or a PHP site)
    // counts as a real source — only refuse when ALL deploy inputs are absent.
    const isBlankScaffold =
      !dto.gitUrl && !dto.dockerImage && !composeContent && !dockerfileContent && !isPhpSite;
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

    // CRITICAL: before a decrypted provider token (or one-shot PAT) is ever
    // injected into `git clone <gitUrl>`, enforce HTTPS + a host that matches
    // the selected provider. Without this a member could set gitUrl to
    // evil.example.com and exfiltrate the victim's token (token exfil + SSRF).
    // Run during pre-write validation so a bad URL leaves no orphan rows.
    if (dto.gitUrl && gitProviderId) {
      const gp = await this.prisma.gitProvider.findFirst({
        where: { id: gitProviderId, userId },
        select: { provider: true },
      });
      if (!gp) throw new ForbiddenException('Git provider not yours');
      assertCloneHostAllowed(gp.provider, dto.gitUrl);
    } else if (dto.gitUrl && gitToken) {
      // One-shot PAT: no provider host to pin against, but still require
      // HTTPS and reject private/loopback literals.
      assertCloneHostAllowed(null, dto.gitUrl);
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
          `Port ${dtoHostPort} is reserved by DockControl (dashboard/api/proxy/db). Pick another.`,
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
      // The platform domain serves the dashboard — never attachable to apps.
      const sysDomain = await this.prisma.systemSetting
        .findUnique({ where: { key: 'system_domain' } })
        .then((r) => (typeof r?.value === 'string' ? r.value : null))
        .catch(() => null);
      if (sysDomain && dtoDomainString === sysDomain) {
        throw new ConflictException(
          `"${dtoDomainString}" is the platform domain (it serves this dashboard). Use a subdomain like app.${dtoDomainString} instead.`,
        );
      }
      const existing = await this.prisma.domain.findUnique({
        where: { domain: dtoDomainString },
      });
      if (existing && !existing.projectId) {
        // Orphan from a deleted project (FK SetNull) — reclaim the slot.
        await this.prisma.domain.delete({ where: { id: existing.id } });
      } else if (existing) {
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
        // Internal (project-transfer): seed volumes from imported tars before
        // the stack boots so a bundled-DB app restores onto its datadir.
        restoreVolumes: dtoRestoreVolumes,
        // Internal (project-transfer): load the exact bundled images + rewrite
        // the compose to consume them (no pull/rebuild) before the stack boots.
        loadImages: dtoLoadImages,
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
    } else if (isPhpSite) {
      // PHP_SITE: no git/image/compose/dockerfile — the platform generates a
      // php:<ver>-apache stack with a live bind-mounted docroot the user fills
      // over SFTP. phpVersion is DTO-validated against SUPPORTED_PHP_VERSIONS.
      this.deployService.runPhpSiteDeploy(deployment.id, app.id, dto.name, dto.phpVersion || DEFAULT_PHP_VERSION, {
        envVars: dto.envVars,
        hostPort: dtoHostPort,
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
    const existing = await this.assertOwnership(userId, id, 'DEVELOPER');
    // Empty string on displayName means "revert to canonical name".
    const data: any = { ...dto };
    if (dto.displayName !== undefined && dto.displayName.trim() === '') {
      data.displayName = null;
    }
    // envVars carry production secrets (DATABASE_URL, JWT secrets, API keys).
    // A generic `data: { ...dto }` would persist them PLAINTEXT, bypassing the
    // at-rest encryption setEnv() applies. Route them through the SAME
    // encryptEnvVars path so a PATCH stays functional but secrets are encrypted
    // in the { __k: 1, v: <ciphertext> } envelope.
    if (dto.envVars !== undefined) {
      data.envVars = this.env.encryptEnvVars(dto.envVars);
    }
    // Changing a PHP site's version only matters for PHP_SITE apps — it rebuilds
    // the php:<ver>-apache image. Drop it for everything else so it can't write
    // a stray column on a non-PHP app.
    const phpVersionChanged =
      dto.phpVersion !== undefined &&
      existing.framework === 'PHP_SITE' &&
      dto.phpVersion !== existing.phpVersion;
    if (dto.phpVersion !== undefined && existing.framework !== 'PHP_SITE') {
      delete data.phpVersion;
    }
    const result = await this.prisma.application.update({ where: { id }, data });
    // Redeploy to apply: a port change, OR a PHP version change (rebuilds the
    // image with the new ARG PHP_VERSION).
    if (dto.port !== undefined || phpVersionChanged) {
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
      // name (marketplace stamps dockcontrol-<slug>-<id12>, custom installs
      // dockcontrol-custom-<id12>) — the dockcontrol-<slug> guess only as fallback.
      await this.agent.enqueueTask(server.id, 'REMOVE', {
        slug: remoteAppSlug(app.name, id),
        legacySlug: slug,
        containerName: app.containerName || containerName(slug),
        purgeVolumes: true,
      });
    }

    // Deprovision OS-level SFTP accounts BEFORE the app delete. The FK cascade
    // (schema onDelete) drops the SftpAccount ROWS, but the sshd user, chroot,
    // password, and dropin inside the sftp container would otherwise survive as
    // a ghost login pointing at a now-deleted app dir. Best-effort.
    try { await this.sftp.deprovisionForApplication(id); } catch {}

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

  /**
   * Move ONE app to another server (per-app placement). Tears the stack
   * down on the current server (volumes KEPT for recovery), flips
   * Application.serverId (NULL when the target is the project default so
   * the app re-inherits), redeploys on the target, refreshes Caddy.
   *
   * `transferVolumes` (default false) additionally ships the app's docker
   * volumes to the target before redeploying — same VOLUME_EXPORT/IMPORT
   * machinery as the project-level migrate, now wired for ALL three
   * source/target combinations (local→remote, remote→remote, remote→local).
   * The import is AWAITED before the redeploy: the agent runs claimed tasks
   * CONCURRENTLY, so the stack must not come up before the data lands.
   *
   * Volume discovery uses the real names — `docker volume ls` when the
   * source is local, the Phase-1 VOLUME_LIST agent task when the source is
   * remote (guessing prefixes would miss differently-named volumes).
   *
   * Compose/marketplace apps redeploy via ops.redeploy(), which ships
   * app.dockerComposeFile to the agent; we reject up front (before any
   * teardown) when that file is missing and the target is remote.
   */
  async moveServer(userId: string, id: string, targetServerId: string, transferVolumes = false) {
    const app = await this.assertOwnership(userId, id, 'ADMIN');
    const target = await this.prisma.server.findUnique({ where: { id: targetServerId } });
    if (!target) throw new NotFoundException('Target server not found');
    if (target.status !== 'ONLINE') {
      throw new BadRequestException(`Server "${target.name}" is ${target.status} — choose an ONLINE server`);
    }
    const current = await resolveAppServer(this.prisma, id);
    if (current?.id === targetServerId) {
      throw new BadRequestException('App is already on this server');
    }

    const slug = slugify(app.name);
    const currentLocal = isAppLocal(current);
    const targetLocal = isLocalHost(target.host);

    // ── compose/marketplace precondition (BEFORE any teardown) ─────────
    // A compose app on a remote target redeploys by shipping
    // app.dockerComposeFile to the agent (Phase-1 ops.redeploy). Without
    // it there is nothing to bring up — reject NOW so we never tear the
    // app down on the source only to fail on the target.
    const isComposeApp =
      !app.gitUrl && !app.dockerImage && app.framework === 'DOCKER_COMPOSE';
    if (isComposeApp && !targetLocal && !app.dockerComposeFile) {
      throw new BadRequestException(
        `"${app.name}" has no stored compose file — it cannot be redeployed on a remote server. ` +
          `Add its docker-compose.yml (via the compose editor) before moving it.`,
      );
    }

    // ── volume discovery — BEFORE teardown so we read live volumes ─────
    // Local source: real `docker volume ls`. Remote source: the Phase-1
    // VOLUME_LIST agent task (real remote names, not guessed prefixes).
    let volumes: string[] = [];
    let volumeWarning = '';
    if (transferVolumes) {
      const prefix = appVolumePrefix(app.name, id);
      try {
        if (currentLocal) {
          const { stdout } = await execFileAsync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 15_000 });
          volumes = stdout.trim().split('\n').filter(Boolean).filter((v) => v.startsWith(prefix));
        } else if (current) {
          const listTask = await this.agent.enqueueAndWait(
            current.id,
            // VOLUME_LIST is handled by the Phase-1 agent but is not yet a
            // member of the Prisma TaskType enum — cast until the enum is
            // migrated (the agent already dispatches it).
            'VOLUME_LIST' as any,
            { prefixes: [prefix] },
            60_000,
          );
          if (listTask.status === 'FAILED') {
            throw new Error(listTask.error || 'volume discovery failed on the source');
          }
          const r: any = listTask.result;
          volumes = Array.isArray(r?.volumes) ? r.volumes : [];
        }
      } catch (e: any) {
        volumeWarning = ` Volume discovery failed (${e?.message || e}) — continuing with empty volumes.`;
      }
    }

    // ── volume transfer — AWAITED, all three combos ────────────────────
    // The agent claims tasks in batches and runs them CONCURRENTLY, so
    // merely enqueueing import-before-deploy does NOT order them. We block
    // here until the import is COMPLETED, then redeploy below.
    let volumesShipped = false;
    if (transferVolumes && volumes.length > 0) {
      try {
        if (currentLocal && !targetLocal) {
          // local → remote: export here, target imports from our transfers/.
          const transferId = await this.exportLocalVolumesForMove(volumes);
          const importTask = await this.agent.enqueueAndWait(
            targetServerId,
            'VOLUME_IMPORT',
            { volumes, sourceTaskId: transferId },
            15 * 60_000,
          );
          if (importTask.status === 'FAILED') {
            throw new Error(importTask.error || 'volume import failed on the target');
          }
          volumesShipped = true;
        } else if (!currentLocal && current && !targetLocal) {
          // remote → remote: export on source, then import on target
          // threading the export's taskId so it downloads the uploaded tars.
          const exportTask = await this.agent.enqueueAndWait(
            current.id,
            'VOLUME_EXPORT',
            { volumes },
            15 * 60_000,
          );
          if (exportTask.status === 'FAILED') {
            throw new Error(exportTask.error || 'volume export failed on the source');
          }
          const importTask = await this.agent.enqueueAndWait(
            targetServerId,
            'VOLUME_IMPORT',
            { volumes, sourceTaskId: exportTask.id },
            15 * 60_000,
          );
          if (importTask.status === 'FAILED') {
            throw new Error(importTask.error || 'volume import failed on the target');
          }
          volumesShipped = true;
        } else if (!currentLocal && current && targetLocal) {
          // remote → local: export on source (uploads land on THIS host),
          // then untar each into a local docker volume.
          const exportTask = await this.agent.enqueueAndWait(
            current.id,
            'VOLUME_EXPORT',
            { volumes },
            15 * 60_000,
          );
          if (exportTask.status === 'FAILED') {
            throw new Error(exportTask.error || 'volume export failed on the source');
          }
          await this.importVolumesLocally(exportTask.id, volumes);
          volumesShipped = true;
        }
      } catch (e: any) {
        volumeWarning = ` Volume transfer failed (${e?.message || e}) — continuing with empty volumes.`;
      }
    }

    // ── tear down on the CURRENT server, volumes kept ──────────────────
    // For a remote source we AWAIT the REMOVE (purgeVolumes:false) so the
    // old containers are confirmed down before the app comes up on the
    // target — otherwise the same domain could double-run (split brain).
    if (currentLocal) {
      const appDir = resolveAppDir(slug, id);
      if (fs.existsSync(appDir)) {
        try { await dockerCompose(appDir, ['down', '--remove-orphans'], undefined, 90_000); } catch {}
      }
      try { await execFileAsync('docker', ['rm', '-f', app.containerName || containerName(slug)]); } catch {}
    } else if (current) {
      try {
        await this.agent.enqueueAndWait(
          current.id,
          'REMOVE',
          {
            slug: remoteAppSlug(app.name, id),
            legacySlug: slug,
            containerName: app.containerName || containerName(slug),
            purgeVolumes: false,
          },
          5 * 60_000,
        );
      } catch {}
    }

    // ── port re-check on the target ────────────────────────────────────
    // The app's hostPort may already be taken by another app on the target.
    // Reassign a free one (and persist) before the redeploy resolves it.
    let portNote = '';
    if (app.hostPort != null) {
      const neighbours = await this.prisma.application.findMany({
        where: { serverId: targetServerId, id: { not: id }, hostPort: { not: null } },
        select: { hostPort: true },
      });
      const taken = new Set<number>([
        ...RESERVED_HOST_PORTS,
        ...neighbours.map((n) => n.hostPort!).filter((p) => p != null),
      ]);
      if (taken.has(app.hostPort)) {
        let free = app.hostPort;
        while (taken.has(free) && free < 65535) free++;
        await this.prisma.application.update({ where: { id }, data: { hostPort: free } });
        portNote = ` Host port ${app.hostPort} was taken on ${target.name} — reassigned to ${free}.`;
      }
    }

    // Flip placement: NULL = inherit when the target IS the project default.
    const proj = await this.prisma.project.findUnique({
      where: { id: app.projectId },
      select: { serverId: true },
    });
    const inheritOnTarget = proj?.serverId === targetServerId;
    await this.prisma.application.update({
      where: { id },
      data: {
        serverId: inheritOnTarget ? null : targetServerId,
        status: 'DEPLOYING',
      },
    });

    // ── redeploy on the target ─────────────────────────────────────────
    // The app is already torn down on the source. If the redeploy throws,
    // flip back to the source and try to bring it up there so the user is
    // not left with a dead app; if even that fails, mark ERROR with a
    // message that says where the data still lives. Volumes stay KEPT.
    let result: any;
    try {
      result = await this.ops.redeploy(userId, id);
    } catch (err: any) {
      const srcServerId = current?.id ?? null;
      // resolveAppServer returns {id, host} only — fetch the friendly name
      // for the message (fall back to the id, then a generic label).
      const srcServer = srcServerId
        ? await this.prisma.server
            .findUnique({ where: { id: srcServerId }, select: { name: true } })
            .catch(() => null)
        : null;
      const sourceName = srcServer?.name || srcServerId || 'the original server';
      if (srcServerId) {
        const proj2 = await this.prisma.project
          .findUnique({ where: { id: app.projectId }, select: { serverId: true } })
          .catch(() => null);
        await this.prisma.application.update({
          where: { id },
          data: {
            serverId: proj2?.serverId === srcServerId ? null : srcServerId,
            status: 'DEPLOYING',
          },
        }).catch(() => {});
        try {
          await this.ops.redeploy(userId, id);
          this.proxy.regenerate().catch(() => {});
          throw new BadRequestException(
            `Move to ${target.name} failed (${err?.message || err}). The app was restored on ${sourceName} — its data is intact there.`,
          );
        } catch (recoverErr: any) {
          if (recoverErr instanceof BadRequestException) throw recoverErr;
          // recovery deploy itself failed — fall through to ERROR.
        }
      }
      await this.prisma.application
        .update({ where: { id }, data: { status: 'ERROR' } })
        .catch(() => {});
      throw new BadRequestException(
        `Move to ${target.name} failed (${err?.message || err}) and the app could not be restored automatically. ` +
          `It is currently DOWN. Its docker volumes are preserved on ${sourceName}; re-deploy it there to recover.`,
      );
    }

    this.proxy.regenerate().catch(() => {});
    const volumeNote = volumesShipped
      ? ' Docker volumes were transferred — data is on the new server.'
      : ` Volumes were NOT transferred — databases/uploads start empty on the new server (the old server keeps them).${volumeWarning}`;
    return {
      message: `App moving to ${target.name}.${volumeNote}${portNote}`,
      deployment: result,
    };
  }

  /** Import previously-exported volume tars (uploaded under a remote
   *  VOLUME_EXPORT's taskId, landing on THIS host) into local docker
   *  volumes. Used by the remote→local move leg. */
  private async importVolumesLocally(exportTaskId: string, volumes: string[]): Promise<void> {
    const dir = this.agent.transferDir(exportTaskId);
    for (const vol of volumes) {
      const file = path.join(dir, `${path.basename(vol)}.tar.gz`);
      if (!fs.existsSync(file)) {
        throw new Error(`exported tar missing for volume "${vol}"`);
      }
      // Idempotent — succeeds when the volume already exists.
      await execFileAsync('docker', ['volume', 'create', vol], { timeout: 15_000 });
      await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(file);
        const child = spawn('docker', ['run', '--rm', '-i', '-v', `${vol}:/data`, 'busybox', 'tar', '-xzf', '-', '-C', '/data']);
        const timer = setTimeout(() => child.kill('SIGKILL'), 1_800_000);
        input.pipe(child.stdin);
        child.once('error', (err) => { clearTimeout(timer); input.destroy(); reject(err); });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`volume import exited ${code}`));
        });
      });
    }
  }

  /** Export local docker volumes into transfers/<id>/ for a remote import.
   *  Streamed (`docker run busybox tar` → file), never buffered in memory. */
  private async exportLocalVolumesForMove(volumes: string[]): Promise<string> {
    const transferId = this.agent.newLocalTransferId();
    const dir = this.agent.transferDir(transferId);
    await fs.promises.mkdir(dir, { recursive: true });
    for (const vol of volumes) {
      const outPath = path.join(dir, `${path.basename(vol)}.tar.gz`);
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(outPath);
        const child = spawn('docker', ['run', '--rm', '-v', `${vol}:/data:ro`, 'busybox', 'tar', '-czf', '-', '-C', '/data', '.']);
        const timer = setTimeout(() => child.kill('SIGKILL'), 1_800_000);
        child.stdout.pipe(out);
        child.once('error', (err) => { clearTimeout(timer); out.destroy(); reject(err); });
        child.once('close', (code) => {
          clearTimeout(timer);
          out.close(() => (code === 0 ? resolve() : reject(new Error(`volume export exited ${code}`))));
        });
      });
    }
    return transferId;
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

  // ── databases attached to an app ──────────────────────────────────

  /** Managed databases linked to this app (soft applicationId link). */
  async listDatabases(userId: string, id: string) {
    await this.assertOwnership(userId, id, 'VIEWER');
    return this.databases.findAll(userId, { applicationId: id });
  }

  /**
   * Attach a managed database to an app and inject its connection details as
   * env vars (DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD/DATABASE_URL),
   * then redeploy so they reach the container. The DB joins the app's PROJECT
   * network at create time, so DB_HOST (its container_name) is reachable.
   * Idempotent: re-attaching refreshes the env block.
   */
  async attachDatabase(userId: string, id: string, databaseId: string) {
    await this.assertOwnership(userId, id, 'DEVELOPER');
    // Link + get the in-network env vars (access to the DB is checked inside).
    const { envVars: dbEnv, dbName } = await this.databases.linkToApplication(userId, databaseId, id);

    // Merge into the app's existing env (user-set keys preserved; the DB_* keys
    // are owned by this flow and overwritten on each attach).
    const current = this.env.decryptEnvVars(
      (await this.prisma.application.findUnique({ where: { id }, select: { envVars: true } }))?.envVars,
    );
    const merged = { ...current, ...dbEnv };
    await this.prisma.application.update({
      where: { id },
      data: { envVars: this.env.encryptEnvVars(merged) as any },
    });

    // Redeploy so the new environment block takes effect in the container.
    // Surface the REAL outcome: if the redeploy fails, the env is persisted but
    // the running container doesn't have the vars yet — tell the user so they
    // don't believe the site can reach the DB when it can't.
    const redeployed = await this.ops.redeploy(userId, id).then(() => true).catch(() => false);
    return {
      message: redeployed
        ? `Database "${dbName}" attached. Connection details injected as DB_* env vars; the site is redeploying.`
        : `Database "${dbName}" linked and env vars saved, but the redeploy did not start — open the site and redeploy it manually to apply.`,
      redeployed,
      envKeys: Object.keys(dbEnv),
    };
  }

  /**
   * Refresh a linked app's DB_* env from a database's CURRENT credentials and
   * redeploy. Called by DatabasesService after a password / username change so
   * the app never loses its connection. Returns whether the redeploy started.
   * Mirrors attachDatabase's env-merge, but the link already exists.
   */
  async refreshDatabaseEnv(userId: string, appId: string, databaseId: string): Promise<boolean> {
    // Rebuild the in-network DB_* block from the live (post-change) row. Use the
    // by-id builder which reads the RAW encrypted row (findOne returns a
    // decrypted password → buildDbEnvVars would double-decrypt and corrupt it).
    const dbEnv = await this.databases.buildDbEnvVarsById(databaseId);
    const current = this.env.decryptEnvVars(
      (await this.prisma.application.findUnique({ where: { id: appId }, select: { envVars: true } }))?.envVars,
    );
    const merged = { ...current, ...dbEnv };
    await this.prisma.application.update({
      where: { id: appId },
      data: { envVars: this.env.encryptEnvVars(merged) as any },
    });
    return this.ops.redeploy(userId, appId).then(() => true).catch(() => false);
  }

  /** Detach a database: unlink it and strip the injected DB_* env vars, then redeploy. */
  async detachDatabase(userId: string, id: string, databaseId: string) {
    await this.assertOwnership(userId, id, 'DEVELOPER');
    const { dbName } = await this.databases.unlinkFromApplication(userId, databaseId);

    const current = this.env.decryptEnvVars(
      (await this.prisma.application.findUnique({ where: { id }, select: { envVars: true } }))?.envVars,
    );
    // Strip only the keys this flow injects, leave user-set vars intact.
    const stripped: Record<string, string> = {};
    for (const [k, v] of Object.entries(current)) {
      if (!(DatabasesService.DB_ENV_KEYS as readonly string[]).includes(k)) stripped[k] = v;
    }
    await this.prisma.application.update({
      where: { id },
      data: { envVars: this.env.encryptEnvVars(stripped) as any },
    });
    const redeployed = await this.ops.redeploy(userId, id).then(() => true).catch(() => false);
    return { message: `Database "${dbName}" detached.`, redeployed };
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
