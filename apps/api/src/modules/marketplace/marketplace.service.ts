import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { COMPOSE_TEMPLATES, PORT_MAP, SIDE_FILES, renderCustomComposeTemplate } from './templates';
import { checkVolumeSafety } from './dto/install-custom.dto';
import { projectNetworkName, listComposeContainerNames, remoteAppSlug } from '../applications/applications.helpers';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { DomainAttachService } from '../domains/domain-attach.service';
import { DatabasesService } from '../databases/databases.service';
import { AgentService } from '../agent/agent.service';
import { ApplicationEnvService } from '../applications/application-env.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface MarketplaceEnvVar {
  key: string;
  defaultValue: string;
  required: boolean;
  description: string;
}

export interface MarketplaceApp {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  icon: string;
  /** Public icon URL (dashboard-icons CDN) for the marketplace UI. */
  iconUrl?: string;
  version: string;
  /** Docker image used by the install template (informational; the real
   *  image is in templates.ts). Surfaced in the marketplace UI. */
  dockerImage?: string;
  /** Default host ports the template publishes. Index 0 is the canonical one. */
  ports: number[];
  /** Internal port the container actually listens on. Caddy proxies here. */
  containerPort: number;
  /** Canonical default host port (mirrors ports[0]) — convenience for UI. */
  defaultPort?: number;
  /** Declared env vars the install wizard surfaces in the UI. */
  envVars?: MarketplaceEnvVar[];
}

// Catalog is loaded from catalog.json at boot. This lets ops edit the
// marketplace (add apps, tweak versions, change defaults) without a code
// change + rebuild. The JSON sits alongside this file so it ships in the
// build artifact (NestJS copies *.json by default via nest-cli assets).
//
// Apps deliberately omitted from the visible marketplace until proper
// packaging exists:
//   - Supabase: standalone studio template is non-functional (needs the
//     full 8-service stack — postgres/kong/gotrue/postgrest/realtime/
//     storage-api/postgres-meta/etc).
//   - Appwrite: same story — single-container `appwrite/appwrite` boots
//     into a crashloop without mariadb/redis/influxdb wired up.
//   - Postal / Mailu / Rainloop: see commit history for the full
//     rationale; DockControl's own mail server feature is the supported
//     mail path.
function loadCatalog(): MarketplaceApp[] {
  // Resolve relative to this compiled file. Works in both `ts-node` (src/)
  // and the built `dist/` output. The dist build maps `__dirname` →
  // `apps/api/dist/modules/marketplace/`; the JSON lives in src/, so we
  // also probe the sibling src/ path. Last-resort: cwd-relative for unit
  // tests run from odd working dirs.
  const distSibling = path.resolve(__dirname, '../../../src/modules/marketplace/catalog.json');
  const candidates = [
    path.join(__dirname, 'catalog.json'),
    distSibling,
    path.join(process.cwd(), 'apps/api/src/modules/marketplace/catalog.json'),
    path.join(process.cwd(), 'src/modules/marketplace/catalog.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as { apps: MarketplaceApp[] };
      return parsed.apps;
    }
  }
  throw new Error(
    `Marketplace catalog.json not found. Looked in:\n  - ${candidates.join('\n  - ')}`,
  );
}

const APPS: MarketplaceApp[] = loadCatalog();

const DATA_DIR = process.env.DOCKCONTROL_DATA_DIR || path.join(process.cwd(), '.dockcontrol');
const APPS_DIR = path.join(DATA_DIR, 'apps');

// Webmail apps that bind to a specific DockControl mail server. Multi-install
// is allowed (one instance per mail server) — uniqueness is enforced on
// (slug, domainId) instead of (slug, projectId).
// Webmail apps the install wizard auto-wires to a DockControl mail server.
// Rainloop was here previously but its compose template never had IMAP/SMTP
// env keys to substitute, so the wiring promise was a lie. Dropped along
// with the app itself.
const WEBMAIL_SLUGS = new Set(['roundcube', 'snappymail']);

@Injectable()
export class MarketplaceService implements OnModuleInit {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    private domainAttach: DomainAttachService,
    private databases: DatabasesService,
    private agent: AgentService,
    private appEnv: ApplicationEnvService,
  ) {
    if (!fs.existsSync(APPS_DIR)) {
      fs.mkdirSync(APPS_DIR, { recursive: true });
    }
  }

  onModuleInit() {
    // Remote installs (and project-migration redeploys) run as queued DEPLOY
    // tasks the agent executes asynchronously — nothing on the platform host
    // observes the result. This hook flips the Application/Deployment rows
    // when the agent reports back, so the dashboard doesn't show DEPLOYING
    // forever. Local installs never hit it (their task is created RUNNING
    // and completed by runDockerCompose directly).
    this.agent.registerTaskCompletionHandler('DEPLOY', async (task) => {
      const applicationId = (task.payload as any)?.applicationId;
      if (!applicationId) return; // git/agent deploys without an app row marker
      const ok = task.status === 'COMPLETED';
      await this.prisma.application
        .update({
          where: { id: applicationId },
          data: { status: ok ? 'RUNNING' : 'ERROR' },
        })
        .catch(() => {}); // app row may be gone (uninstalled mid-deploy)
      await this.prisma.deployment.updateMany({
        where: { applicationId, status: 'DEPLOYING' },
        data: { status: ok ? 'RUNNING' : 'FAILED', finishedAt: new Date() },
      });
      if (!ok) {
        this.logger.warn(
          `Remote DEPLOY ${task.id} for app ${applicationId} failed: ${task.error ?? 'unknown error'}`,
        );
      }
      // Domain routing may point at the new container — refresh either way
      // (success: start routing; failure: stop routing to a dead target).
      this.proxy.regenerate().catch(() => {});
    });
  }

  listApps() { return APPS; }

  getApp(slug: string) {
    const app = APPS.find((a) => a.slug === slug);
    if (!app) throw new NotFoundException('App not found');
    return app;
  }

  async install(
    data: {
      appSlug: string;
      serverId?: string;
      projectId: string;
      // Custom name (slug). Falls back to the catalog name + suffix.
      name?: string;
      domainId?: string;
      // Convenience: new domain to create + attach atomically.
      newDomain?: string;
      // Host port for direct IP access (no domain case).
      hostPort?: number;
      port?: number;
      envVars?: Record<string, string>;
    },
    userId?: string,
  ) {
    // Cross-tenant app-planting fix: the user must be a member of the
    // project. DEVELOPER is the minimum role to provision an app.
    if (!userId) {
      throw new ForbiddenException('userId is required.');
    }
    await assertProjectAccess(this.prisma, userId, data.projectId, 'DEVELOPER');

    // Per-app server placement: an explicit serverId wins (apps in one
    // project CAN live on different machines); default = project's server.
    const project = await this.prisma.project.findUnique({
      where: { id: data.projectId },
      select: { serverId: true, server: { select: { host: true } } },
    });
    if (!project) throw new NotFoundException('Project not found.');
    let serverHost = project.server?.host ?? null;
    // appServerId is persisted on the Application row ONLY when it differs
    // from the project default (NULL = inherit).
    let appServerId: string | null = null;
    if (data.serverId && data.serverId !== project.serverId) {
      const target = await this.prisma.server.findUnique({ where: { id: data.serverId } });
      if (!target) throw new NotFoundException('Server not found.');
      if (target.status !== 'ONLINE') {
        throw new BadRequestException(`Server "${target.name}" is ${target.status} — choose an ONLINE server.`);
      }
      appServerId = target.id;
      serverHost = target.host;
    } else {
      data.serverId = project.serverId;
    }
    const effectiveServerId = appServerId ?? project.serverId;
    data.serverId = effectiveServerId;
    // Remote target → the compose stack must run on that server, not on the
    // platform host. runDockerCompose() below shells out to the LOCAL docker
    // daemon, so for remote servers we dispatch the rendered compose to the
    // agent instead.
    const isRemoteServer = !isLocalHost(serverHost);

    const app = this.getApp(data.appSlug);
    const template = COMPOSE_TEMPLATES[data.appSlug];
    if (!template) throw new NotFoundException(`No template for ${app.name}`);

    const isWebmail = WEBMAIL_SLUGS.has(data.appSlug);

    // Multi-app per domain rules — checked AFTER port resolution. See below.

    // Webmail (Roundcube/SnappyMail/Rainloop) → multi-install allowed
    //   (one per mail server, dedup is on the domainId check above).
    // Everything else → auto-suffix the name on conflict so the user can
    //   spin up e.g. two WordPress instances in the same project (typically
    //   one per domain). We don't refuse the install — instead we mint a
    //   fresh "<App> 2", "<App> 3", … until we land on something free.
    // Track whether we suffixed (= multi-install): if so, the default host
    // port is almost certainly taken by the previous instance, so we'll
    // auto-allocate a fresh one instead of refusing the install.
    // Custom name from the unified deploy dialog wins. We still check for
    // name collisions inside the project — if the picked name is taken,
    // suffix as usual instead of failing.
    let appName = (data.name && data.name.trim()) || app.name;
    let isMultiInstall = false;
    if (!isWebmail) {
      const baseName = (data.name && data.name.trim()) || app.name;
      let suffix = 2;
      let resolved = false;
      while (suffix < 100) {
        const existing = await this.prisma.application.findFirst({
          where: { name: appName, projectId: data.projectId },
          select: { id: true },
        });
        if (!existing) {
          resolved = true;
          break;
        }
        appName = `${baseName} ${suffix}`;
        isMultiInstall = true;
        suffix++;
      }
      // Exhausted every "<App> 2".."<App> 99" suffix — every candidate is
      // taken. Refuse instead of falling through with a colliding name
      // (mirrors the custom-install 409 path).
      if (!resolved) {
        throw new ConflictException(
          `Too many "${baseName}" apps in this project — pick a different name.`,
        );
      }
    }

    // Convenience: caller passed `newDomain: "app.acme.com"`. Create the
    // Domain row + use its id from here on. The downstream attach() call
    // performs cross-server / cross-project validation.
    if (!data.domainId && data.newDomain) {
      // Platform domain serves the dashboard — never attachable to an app
      // (the Caddyfile renderer would skip it anyway; fail loudly here).
      const sysDomain = await this.prisma.systemSetting
        .findUnique({ where: { key: 'system_domain' } })
        .then((r) => (typeof r?.value === 'string' ? r.value : null))
        .catch(() => null);
      if (sysDomain && data.newDomain === sysDomain) {
        throw new ConflictException(
          `"${data.newDomain}" is the platform domain (it serves this dashboard). Use a subdomain like app.${data.newDomain} instead.`,
        );
      }
      const existing = await this.prisma.domain.findUnique({ where: { domain: data.newDomain } });
      if (existing && !existing.projectId) {
        // Orphan from a deleted project (FK SetNull) — reclaim it.
        await this.prisma.domain.delete({ where: { id: existing.id } });
      }
      if (existing && existing.projectId) {
        if (existing.projectId !== data.projectId) {
          throw new BadRequestException(`Domain "${data.newDomain}" belongs to another project.`);
        }
        data.domainId = existing.id;
      } else {
        const created = await this.prisma.domain.create({
          data: { domain: data.newDomain, projectId: data.projectId },
        });
        data.domainId = created.id;
      }
    }

    // Port resolution:
    //   1. User-supplied port wins (must be free across all apps + host).
    //      Both `port` (legacy field) and `hostPort` (what the unified
    //      deploy dialog actually sends for the "IP + port" choice) are
    //      honored — the dialog's custom port used to be silently dropped
    //      because only `port` was read here.
    //   2. Multi-install apps → search upward from the template default.
    //   3. Single-install apps → use the template default; refuse with a
    //      clear error if it's busy (instead of silently changing it).
    // Track whether the user PICKED a port — controls the attach mode:
    // port-pinned (DomainPortBinding, reachable at http://domain:port via the
    // container's own publish; https://domain 308-redirects there) vs clean
    // URL (https://domain, Caddy terminates TLS on 443 and proxies).
    // NOTE: isPortFree/allocateFreePort probe the LOCAL docker daemon. For a
    // REMOTE project that's the wrong machine — a port busy here may be free
    // there (and vice versa). Skip the local probe for remote installs; a
    // real conflict surfaces as a clear bind error from the agent's
    // `docker compose up` and flips the deploy to ERROR.
    const basePort = PORT_MAP[data.appSlug] || app.ports[0];
    const requestedPort = data.port ?? data.hostPort;
    let realPort: number;
    const customPort = !!requestedPort;
    if (requestedPort) {
      if (!isRemoteServer && !(await this.isPortFree(requestedPort))) {
        throw new ConflictException(`Port ${requestedPort} is already used by another container. Pick another.`);
      }
      realPort = requestedPort;
    } else if (isWebmail || isMultiInstall) {
      // Multi-install (second WordPress, etc.) → walk upward from the
      // template default until we find a free host port. Caddy still
      // serves https://<domain> cleanly because each instance has its own
      // container_name and domain binding.
      realPort = isRemoteServer ? basePort : await this.allocateFreePort(basePort);
    } else {
      if (!isRemoteServer && !(await this.isPortFree(basePort))) {
        throw new ConflictException(
          `Default port ${basePort} for ${app.name} is taken. Provide a custom port in the install form.`,
        );
      }
      realPort = basePort;
    }

    // Pre-compute auto-resolved values for webmail-style apps that need to
    // point at an existing DockControl mail server. The compose template is
    // patched on the fly with these substitutions.
    let composeContent = template.compose;
    if (isWebmail) {
      // Find the target mail server. Priority:
      //   1. domainId from the install request
      //   2. only ONE mail server installed → use it
      let mailServer = null as { imapsPort: number; submissionPort: number; domainId: string } | null;
      let domain = null as { domain: string } | null;
      if (data.domainId) {
        mailServer = await this.prisma.mailServer.findUnique({ where: { domainId: data.domainId } });
        domain = await this.prisma.domain.findUnique({ where: { id: data.domainId }, select: { domain: true } });
      } else {
        const allMs = await this.prisma.mailServer.findMany({
          include: { domain: { select: { domain: true } } },
        });
        if (allMs.length === 1) {
          mailServer = allMs[0];
          domain = allMs[0].domain;
        }
      }

      // Refuse to install a webmail with no mail server in sight — Roundcube
      // would boot with placeholder host.docker.internal credentials and the
      // user would get "connection refused" on every login attempt with no
      // explanation. Tell them to deploy a mail server first.
      if (!mailServer || !domain) {
        const existing = await this.prisma.mailServer.count();
        throw new ConflictException(
          existing === 0
            ? `Deploy a mail server first. ${app.name} is a webmail client — it needs a Postfix/Dovecot stack to connect to. Go to /dashboard/emails, deploy a mail server on your apex domain, then come back here.`
            : `Multiple mail servers exist — pick one explicitly via the "Domain" field so ${app.name} knows which one to connect to.`,
        );
      }

      {
        // CRITICAL: use the public hostname (mail.<domain>) — not host.docker.internal.
        // The mail server's TLS cert is issued for mail.<domain>, so any other
        // hostname would fail the certificate validation. Roundcube must hit
        // the public host:port the mail server actually publishes.
        const mailHost = `mail.${domain.domain}`;
        composeContent = composeContent
          .replace(
            /ROUNDCUBEMAIL_DEFAULT_HOST: tls:\/\/host\.docker\.internal/g,
            `ROUNDCUBEMAIL_DEFAULT_HOST: ssl://${mailHost}`,
          )
          .replace(
            /ROUNDCUBEMAIL_DEFAULT_PORT: "993"/g,
            `ROUNDCUBEMAIL_DEFAULT_PORT: "${mailServer.imapsPort}"`,
          )
          .replace(
            /ROUNDCUBEMAIL_SMTP_SERVER: tls:\/\/host\.docker\.internal/g,
            `ROUNDCUBEMAIL_SMTP_SERVER: tls://${mailHost}`,
          )
          .replace(
            /ROUNDCUBEMAIL_SMTP_PORT: "587"/g,
            `ROUNDCUBEMAIL_SMTP_PORT: "${mailServer.submissionPort}"`,
          );
      }
    }

    // Custom env override from the install request — written as a .env file alongside compose
    const envOverride = data.envVars || {};

    // Keep the app's canonical name ("Roundcube") so slugify() in
    // applications.service produces a stable slug. Per-instance differentiation
    // is carried by the linked domain (UI joins on app.domains[0] to render
    // "Roundcube — mail.foo.com"), and by the applicationId suffix in the
    // container_name/dir below.
    const application = await this.prisma.application.create({
      data: {
        name: appName,
        projectId: data.projectId,
        serverId: appServerId,
        framework: 'DOCKER_COMPOSE',
        status: 'DEPLOYING',
        port: realPort,
        customPort,
        containerPort: app.containerPort,
      },
    });

    const instanceId = application.id.slice(0, 12);
    const containerName = this.computeContainerName(data.appSlug, instanceId, appName);
    await this.prisma.application.update({
      where: { id: application.id },
      data: { containerName },
    });

    // Resolve the HOST path of this install's appDir. When the API runs
    // in a container, the docker daemon sits on the host and resolves
    // bind-mount sources against the HOST filesystem — `./` / relative
    // paths in our generated compose would otherwise point at directories
    // that exist inside the API container but NOT on the host, and the
    // daemon would silently create empty dirs at the mount point.
    //
    // DOCKCONTROL_HOST_DATA_DIR is set in the top-level compose to the
    // operator's actual host path (`${PWD}/.dockcontrol`). Default to the
    // in-container path so single-process dev `pnpm dev` keeps working.
    const hostDataDir = process.env.DOCKCONTROL_HOST_DATA_DIR || path.join(process.cwd(), '.dockcontrol');
    const hostAppDir = path.join(
      hostDataDir,
      'apps',
      `${data.appSlug}-${instanceId}`,
    );

    composeContent = composeContent
      .replace(/__INSTANCE_ID__/g, instanceId)
      .replace(/__HOST_PORT__/g, String(realPort))
      .replace(/__HOST_APP_DIR__/g, hostAppDir);

    // Generate strong random passwords for any __RANDOM_PASSWORD__ /
    // __RANDOM_PASSWORD_2__ / ... placeholders the template declares.
    // Each placeholder gets the SAME value across its occurrences so the
    // app + bundled DB end up with matching credentials. Different
    // numbered placeholders (__RANDOM_PASSWORD_2__) get DIFFERENT values.
    //
    // We stash the generated passwords on the .env file too — that way
    // the auto-import DB rows (databases.service.ts) pick them up via
    // their normal env parsing and the user sees the right creds in
    // /dashboard/databases. The .env file lives inside the appDir, never
    // committed anywhere outside the host.
    const randomPasswords: Record<string, string> = {};
    const placeholderRe = /__RANDOM_PASSWORD(_\d+)?__/g;
    composeContent = composeContent.replace(placeholderRe, (match) => {
      if (!randomPasswords[match]) {
        // 24 bytes → 32 chars base64url. URL-safe so MySQL/Mongo/Postgres
        // connection strings don't choke on `+` or `/`. Strip `=` padding.
        randomPasswords[match] = crypto.randomBytes(24).toString('base64url').replace(/=+$/, '');
      }
      return randomPasswords[match];
    });
    // Merge generated passwords into the env override so they also land
    // in the .env file (the templates that read `${VAR:-default}` will
    // pick the .env value over the placeholder fallback). Keeps the
    // randomization visible to both the compose substitution above AND
    // the runtime container env at the same time.
    Object.assign(envOverride, randomPasswords);

    // Effective env snapshot → persisted (encrypted) on the Application row
    // so the dashboard's "Variables d'environnement" tab shows what the
    // container ACTUALLY got — including auto-generated admin passwords.
    // Without this, marketplace installs showed an empty env tab and the
    // user had no way to learn the generated Grafana/MinIO/… password.
    //
    // Sources, later wins:
    //   1. every `${KEY:-default}` the rendered compose declares (the
    //      default already contains the substituted random password)
    //   2. the user's explicit envVars from the install dialog
    const effectiveEnv: Record<string, string> = {};
    const generatedCredentials: Record<string, string> = {};
    const generatedValues = new Set(Object.values(randomPasswords));
    const defaultRe = /\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}\s]*)\}/g;
    let dm: RegExpExecArray | null;
    while ((dm = defaultRe.exec(composeContent)) !== null) {
      effectiveEnv[dm[1]] = dm[2];
      if (generatedValues.has(dm[2])) generatedCredentials[dm[1]] = dm[2];
    }
    // Hardcoded creds (templates with literal env values, e.g. WordPress's
    // bundled-DB password) — surface the generated ones so the user can
    // find them in the env tab too. Matches both `KEY: value` map form and
    // `- KEY=value` list form.
    const literalRe = /^\s*(?:- )?([A-Za-z_][A-Za-z0-9_]*)[:=]\s*"?([A-Za-z0-9_-]+)"?\s*$/gm;
    while ((dm = literalRe.exec(composeContent)) !== null) {
      if (generatedValues.has(dm[2])) {
        effectiveEnv[dm[1]] = dm[2];
        generatedCredentials[dm[1]] = dm[2];
      }
    }
    for (const [k, v] of Object.entries(data.envVars || {})) {
      if (String(v).trim() === '') continue; // empty input → template default wins (`:-`)
      effectiveEnv[k] = v;
      delete generatedCredentials[k]; // user picked their own value
    }
    await this.prisma.application.update({
      where: { id: application.id },
      data: { envVars: this.appEnv.encryptEnvVars(effectiveEnv) as any },
    });

    // Templates already declare:
    //   - networks: dockcontrol-apps (external) at top-level
    //   - the service joined to that network
    //   - host port publish (so direct IP:port access still works)
    //
    // For port-pinned bindings, Caddy proxies via container_name over the
    // shared network — it does NOT need its own host-side port publish
    // (would conflict with the container's own publish). So we DON'T strip
    // the ports block from the app. Caddy and the app coexist:
    //   - User → https://domain (Caddy :443 → container_name)
    //   - User → http://ip:hostPort (direct container publish, bypass Caddy)
    // No Caddy port publish on the custom port = no port conflict.

    if (data.domainId) {
      await this.domainAttach.attach({
        applicationId: application.id,
        domainId: data.domainId,
        projectId: data.projectId,
        customPort,
        port: realPort,
      });
      // Caddy regen is deferred until runDockerCompose() succeeds (down
      // below) — issuing a reverse_proxy block before the container
      // exists guarantees a ~30s window of 502s + risks tripping the
      // Let's Encrypt issuance against an unreachable host.
    }

    let taskId: string;
    if (isRemoteServer) {
      // The project lives on a remote server — running `docker compose up`
      // here would plant the app on the PLATFORM host while the dashboard
      // says it's on the project's server. Ship the fully-rendered compose
      // to the agent instead; it writes compose/.env/side-files under
      // /opt/dockcontrol/apps/<slug> and brings the stack up there.
      //
      // __HOST_APP_DIR__ (PrestaShop bind mounts) must point at the AGENT's
      // app dir, not the platform host's data dir.
      //
      // Slug convention MUST match what applications.service.remove() and
      // the lifecycle ops (start/stop/restart/logs) later compute:
      // remoteAppSlug(app.name, app.id) = slugify(name)-<id12>. Using the
      // catalog appSlug here would diverge for suffixed installs
      // ("WordPress 2" → wordpress-2-<id12>, not wordpress-<id12>) and the
      // remove would never find the dir.
      const remoteSlug = remoteAppSlug(appName, application.id);
      composeContent = composeContent.replace(
        new RegExp(hostAppDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        `/opt/dockcontrol/apps/${remoteSlug}`,
      );
      const task = await this.agent.enqueueTask(data.serverId, 'DEPLOY', {
        slug: remoteSlug,
        appName,
        applicationId: application.id,
        compose: composeContent,
        envVars: envOverride,
        sideFiles: SIDE_FILES[data.appSlug] || undefined,
        projectNetwork: projectNetworkName(data.projectId),
      });
      taskId = task.id;
    } else {
      const task = await this.prisma.agentTask.create({
        data: {
          serverId: data.serverId,
          type: 'DEPLOY',
          status: 'RUNNING',
          startedAt: new Date(),
          payload: {
            appSlug: app.slug,
            appName,
            applicationId: application.id,
            ports: app.ports,
          },
        },
      });
      taskId = task.id;
    }

    if (userId) {
      await this.prisma.deployment.create({
        data: {
          applicationId: application.id,
          status: 'DEPLOYING',
          commitMessage: `Install ${app.name} v${app.version} from Marketplace`,
          triggeredById: userId,
          startedAt: new Date(),
        },
      });
    }

    // Every template now uses __INSTANCE_ID__ — so EVERY install needs its
    // own dir (no more single-install bucket). This also enables clean
    // multi-install for non-webmail apps the day we lift that restriction.
    // Remote installs skip this — the agent runs the stack on its own host
    // and the DEPLOY completion handler (onRemoteDeployComplete) flips the
    // application status when the agent reports back.
    if (!isRemoteServer) {
      this.runDockerCompose(data.appSlug, composeContent, application.id, taskId, envOverride, true, data.projectId);
    }

    return {
      message: `Installing ${app.name}...`,
      taskId,
      applicationId: application.id,
      app,
      // Auto-generated credentials (admin passwords etc.) the user did NOT
      // pick themselves. Shown ONCE in the post-install dialog; afterwards
      // they're retrievable from the app's env tab (persisted encrypted).
      generatedCredentials,
    };
  }

  async uninstall(appSlug: string, applicationId?: string) {
    // Every install writes into a per-instance dir <slug>-<id12> (see
    // runDockerCompose below) — looking up APPS_DIR/<slug> alone made this
    // a no-op for all current installs. Mirror projects.service.remove's
    // dual-lookup: per-instance dir first (via the application id), then
    // the legacy <slug> dir for pre-migration installs.
    const candidates: string[] = [];
    if (applicationId) {
      candidates.push(path.join(APPS_DIR, `${appSlug}-${applicationId.slice(0, 12)}`));
    }
    candidates.push(path.join(APPS_DIR, appSlug));
    for (const appDir of candidates) {
      if (fs.existsSync(appDir)) {
        try {
          // --rmi local removes any custom-built image; pulled images
          // (postgres, redis…) are shared and left alone.
          await execAsync('docker compose down -v --rmi local --remove-orphans', { cwd: appDir });
        } catch {}
      }
    }
  }

  /**
   * Compute the container_name a template will pick at install time. Mirrors
   * the `container_name: dockcontrol-<slug>-__INSTANCE_ID__` convention used by
   * every template in templates.ts. We need this BEFORE the compose file
   * is written so we can persist it on the Application row — Caddy reads
   * the row to know where to proxy.
   */
  private computeContainerName(slug: string, instanceId: string, _appName: string): string {
    // Match the canonical template names. Slugs like 'uptime-kuma' are kept
    // verbatim; the underlying templates use the same form.
    const stem = slug === 'redis' ? 'redis-app' : slug;
    return `dockcontrol-${stem}-${instanceId}`;
  }

  /** True when no running container holds this host port. */
  private async isPortFree(port: number): Promise<boolean> {
    try {
      const { stdout } = await execAsync('docker ps --format "{{.Ports}}"', { timeout: 5000 });
      const re = /:(\d+)->/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stdout)) !== null) {
        if (parseInt(m[1], 10) === port) return false;
      }
      return true;
    } catch {
      // If we can't probe docker, assume free — installs will surface the
      // real conflict via `docker compose up` failing with a clear bind error.
      return true;
    }
  }

  /**
   * Find a free TCP port at or above `base`, skipping any port currently
   * published by a running docker container. Used for webmail multi-install
   * (8083 → 8093 → 8103 …) so a second Roundcube instance doesn't collide
   * with the first.
   */
  private async allocateFreePort(base: number): Promise<number> {
    const used = new Set<number>();
    try {
      const { stdout } = await execAsync('docker ps --format "{{.Ports}}"', { timeout: 5000 });
      const re = /:(\d+)->/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stdout)) !== null) used.add(parseInt(m[1], 10));
    } catch {}
    let p = base;
    while (used.has(p)) p += 10;
    return p;
  }

  /**
   * Deploy an arbitrary Docker Hub image — no template required. This is
   * the "open marketplace" path: the user types `linuxserver/jellyfin:latest`
   * + a container port + (optionally) env vars / volumes / a domain, and we
   * spin up the same compose pipeline as a marketplace install.
   *
   * Image format is light-validated to block obvious junk (whitespace,
   * shell metas) but we let Docker itself reject pulls that fail — the
   * user gets the docker error verbatim via deployments.lastError.
   */
  async installCustom(
    data: {
      name: string;
      image: string;
      serverId: string;
      projectId: string;
      containerPort: number;
      hostPort?: number;
      domainId?: string;
      envVars?: Record<string, string>;
      volumes?: string[];
      command?: string;
    },
    userId?: string,
  ) {
    if (!userId) throw new ForbiddenException('userId is required.');
    await assertProjectAccess(this.prisma, userId, data.projectId, 'DEVELOPER');
    const project = await this.prisma.project.findUnique({
      where: { id: data.projectId },
      select: { serverId: true, server: { select: { host: true } } },
    });
    if (!project) throw new NotFoundException('Project not found.');
    // Per-app placement, same rules as install(): explicit serverId wins,
    // NULL on the row = inherit the project default.
    let serverHost = project.server?.host ?? null;
    let appServerId: string | null = null;
    if (data.serverId && data.serverId !== project.serverId) {
      const target = await this.prisma.server.findUnique({ where: { id: data.serverId } });
      if (!target) throw new NotFoundException('Server not found.');
      if (target.status !== 'ONLINE') {
        throw new BadRequestException(`Server "${target.name}" is ${target.status} — choose an ONLINE server.`);
      }
      appServerId = target.id;
      serverHost = target.host;
    }
    data.serverId = appServerId ?? project.serverId;
    const isRemoteServer = !isLocalHost(serverHost);
    if (!data.name?.trim()) throw new BadRequestException('Name required');
    if (!data.image?.trim()) throw new BadRequestException('Image required');
    if (!Number.isInteger(data.containerPort) || data.containerPort < 1 || data.containerPort > 65535) {
      throw new BadRequestException('containerPort must be 1-65535');
    }
    // Reject obvious shell injection / whitespace in the image ref.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-\/:@]*$/.test(data.image)) {
      throw new BadRequestException('Invalid image reference');
    }
    // Volume hardening — a DEVELOPER must never bind-mount the host fs
    // (e.g. "/:/host" or "/var/run/docker.sock:...") or inject compose keys
    // via newlines. Only named volumes mapped to absolute container paths
    // are allowed. Enforced HERE (not just in the DTO) so direct service
    // callers / future controllers can't bypass it.
    for (const v of data.volumes ?? []) {
      const err = checkVolumeSafety(v);
      if (err) throw new BadRequestException(err);
    }
    // Reserved host ports are managed by the platform (Caddy 80/443,
    // Postgres 5432, dashboard/API 3000/4000) — refuse to publish onto them.
    const RESERVED_HOST_PORTS = new Set([80, 443, 5432, 3000, 4000]);
    if (data.hostPort !== undefined) {
      if (!Number.isInteger(data.hostPort) || data.hostPort < 1 || data.hostPort > 65535) {
        throw new BadRequestException('hostPort must be 1-65535');
      }
      if (RESERVED_HOST_PORTS.has(data.hostPort)) {
        throw new BadRequestException(`Port ${data.hostPort} is reserved by the platform`);
      }
    }

    // Name dedup within project — same rule as template installs.
    const existing = await this.prisma.application.findFirst({
      where: { name: data.name.trim(), projectId: data.projectId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`An app called "${data.name}" already exists in this project`);
    }

    if (data.domainId) {
      const dup = await this.prisma.application.findFirst({
        where: { domains: { some: { id: data.domainId } } },
        select: { id: true, name: true, projectId: true },
      });
      if (dup) {
        if (dup.projectId === data.projectId) {
          await this.prisma.domain.update({
            where: { id: data.domainId },
            data: { applicationId: null },
          });
        } else {
          throw new ConflictException(
            `Domain is already linked to "${dup.name}" in another project. Detach it from /dashboard/applications/${dup.id} first.`,
          );
        }
      }
    }

    // Port: user-supplied OR find one starting at 18000 (high range to avoid
    // colliding with marketplace defaults). Local-docker probes are skipped
    // for remote projects (wrong machine) — the agent surfaces real binds.
    let hostPort: number;
    if (data.hostPort) {
      if (!isRemoteServer && !(await this.isPortFree(data.hostPort))) {
        throw new ConflictException(`Port ${data.hostPort} is already used by another container`);
      }
      hostPort = data.hostPort;
    } else {
      hostPort = isRemoteServer ? 18000 : await this.allocateFreePort(18000);
    }

    let composeContent = renderCustomComposeTemplate({
      image: data.image,
      containerPort: data.containerPort,
      envVars: data.envVars,
      volumes: data.volumes,
      command: data.command,
    });

    const application = await this.prisma.application.create({
      data: {
        name: data.name.trim(),
        projectId: data.projectId,
        serverId: appServerId,
        framework: 'DOCKER_COMPOSE',
        status: 'DEPLOYING',
        port: hostPort,
        customPort: !!data.hostPort,
        containerPort: data.containerPort,
        // Encrypted like every other path — the env tab's getEnv() decrypts.
        // Plaintext here leaked secrets into DB dumps.
        envVars: this.appEnv.encryptEnvVars(data.envVars || {}) as any,
      },
    });

    const instanceId = application.id.slice(0, 12);
    const containerName = `dockcontrol-custom-${instanceId}`;
    await this.prisma.application.update({
      where: { id: application.id },
      data: { containerName },
    });

    composeContent = composeContent
      .replace(/__INSTANCE_ID__/g, instanceId)
      .replace(/__HOST_PORT__/g, String(hostPort));

    if (data.domainId) {
      await this.domainAttach.attach({
        applicationId: application.id,
        domainId: data.domainId,
        projectId: data.projectId,
        customPort: !!data.hostPort,
        port: hostPort,
      });
      this.proxy.regenerate().catch(() => {});
    }

    let taskId: string;
    if (isRemoteServer) {
      // Same remote-dispatch story as template installs: ship the rendered
      // compose to the agent; the DEPLOY completion handler flips status.
      // Slug = remoteAppSlug(name, id) so remove()/lifecycle find the dir.
      const task = await this.agent.enqueueTask(data.serverId, 'DEPLOY', {
        slug: remoteAppSlug(application.name, application.id),
        appName: application.name,
        applicationId: application.id,
        compose: composeContent,
        envVars: data.envVars || {},
        projectNetwork: projectNetworkName(data.projectId),
      });
      taskId = task.id;
    } else {
      const task = await this.prisma.agentTask.create({
        data: {
          serverId: data.serverId,
          type: 'DEPLOY',
          status: 'RUNNING',
          startedAt: new Date(),
          payload: {
            appSlug: 'custom',
            appName: application.name,
            applicationId: application.id,
            image: data.image,
            hostPort,
          },
        },
      });
      taskId = task.id;
    }
    if (userId) {
      await this.prisma.deployment.create({
        data: {
          applicationId: application.id,
          status: 'DEPLOYING',
          commitMessage: `Install custom image ${data.image}`,
          triggeredById: userId,
          startedAt: new Date(),
        },
      });
    }

    // perInstanceDir = true: custom installs always isolate (slug is "custom"
    // so a shared dir would clobber across installs).
    if (!isRemoteServer) {
      this.runDockerCompose('custom', composeContent, application.id, taskId, data.envVars || {}, true, data.projectId);
    }

    return {
      message: `Deploying ${data.image}…`,
      taskId,
      applicationId: application.id,
      hostPort,
    };
  }

  /**
   * Attach every container the compose stack declares (app + any DB sidecar,
   * e.g. WordPress + its MariaDB) to the project network
   * `dockcontrol_proj_<projectId>`. The service-mesh view
   * (projects.service.getServiceMesh) advertises hostnames reachable on that
   * network — without this connect, sibling apps deployed via the classic
   * deploy path could never resolve a marketplace install by container_name.
   *
   * Mirrors application-deploy.service: `network inspect` → `network create`
   * (idempotent, races swallowed) → `network connect` per container.
   * Best-effort — the install is already RUNNING; a mesh-attach failure must
   * not flip the deploy red.
   */
  private async attachToProjectNetwork(projectId: string, compose: string): Promise<void> {
    const projectNet = projectNetworkName(projectId);
    try {
      await execFileAsync('docker', ['network', 'inspect', projectNet], { timeout: 5000 });
    } catch {
      try { await execFileAsync('docker', ['network', 'create', projectNet], { timeout: 10_000 }); } catch {}
    }
    for (const name of listComposeContainerNames(compose)) {
      // "already connected to network" → non-zero exit; swallowed (idempotent
      // on retry / redeploy).
      try {
        await execFileAsync('docker', ['network', 'connect', projectNet, name], { timeout: 10_000 });
      } catch {}
    }
  }

  private async runDockerCompose(
    slug: string,
    compose: string,
    applicationId: string,
    taskId: string,
    envOverride: Record<string, string> = {},
    perInstanceDir = false,
    projectId?: string,
  ) {
    // perInstanceDir = true for apps that support multi-install (webmail).
    // Single-install apps keep using APPS_DIR/<slug> for back-compat with
    // existing deployments and the uninstall() helper below.
    const appDir = perInstanceDir
      ? path.join(APPS_DIR, `${slug}-${applicationId.slice(0, 12)}`)
      : path.join(APPS_DIR, slug);
    if (!fs.existsSync(appDir)) {
      fs.mkdirSync(appDir, { recursive: true });
    }
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);

    // user-supplied envVars → written as .env (picked up by docker compose at
    // runtime). ALWAYS written, even empty: every template declares
    // `env_file: - .env`, and compose hard-fails on a missing env file.
    const envContent = Object.entries(envOverride)
      .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`)
      .join('\n') + '\n';
    fs.writeFileSync(path.join(appDir, '.env'), envContent);

    // Companion files some templates bind-mount into the container
    // (e.g. PrestaShop's Apache proxy-trust conf). The compose body
    // already references each one by relative path; we just have to
    // drop them next to the compose so the mount target exists.
    const sideFiles = SIDE_FILES[slug];
    if (sideFiles) {
      for (const [name, content] of Object.entries(sideFiles)) {
        fs.writeFileSync(path.join(appDir, name), content);
      }
    }

    try {
      await execAsync('docker compose pull', { cwd: appDir, timeout: 600000 });
      await execAsync('docker compose up -d', { cwd: appDir, timeout: 120000 });

      // Join the project's service-mesh network so siblings (classic deploys,
      // other marketplace apps) can reach this install — and its DB sidecar —
      // by container_name, exactly as getServiceMesh() advertises.
      if (projectId) {
        await this.attachToProjectNetwork(projectId, compose);
      }

      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { status: 'RUNNING' },
      });
      await this.prisma.deployment.updateMany({
        where: { applicationId, status: 'DEPLOYING' },
        data: { status: 'RUNNING', finishedAt: new Date() },
      });
      // Container is up — refresh Caddy so the linked domain (if any) starts
      // routing to it RIGHT NOW. Without this, the user has to wait for the
      // hourly SSL sync or hit "Redeploy" again.
      this.proxy.regenerate().catch(() => {});

      // Auto-import any DB sidecar declared in the template (e.g. PrestaShop +
      // MariaDB, WordPress + MariaDB) so it shows up in /dashboard/databases
      // with the parent app's RBAC inherited via projectId. Errors swallowed
      // — install is already RUNNING and a registry import failure must not
      // flip the deploy red. Idempotent on retry via the @@unique constraint.
      try {
        const appRow = await this.prisma.application.findUnique({
          where: { id: applicationId },
          // serverId: per-app placement wins over the project default.
          select: { projectId: true, serverId: true, project: { select: { serverId: true } } },
        });
        const dbServerId = appRow?.serverId ?? appRow?.project?.serverId;
        if (appRow && dbServerId) {
          await this.databases.importFromAppCompose({
            applicationId,
            projectId: appRow.projectId,
            serverId: dbServerId,
            composeYaml: compose,
          });
        }
      } catch {}
    } catch (err: any) {
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { status: 'FAILED', error: err.message || 'Docker compose failed', completedAt: new Date() },
      });
      await this.prisma.deployment.updateMany({
        where: { applicationId, status: 'DEPLOYING' },
        data: { status: 'FAILED', finishedAt: new Date() },
      });
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { status: 'ERROR' },
      });
      // Refresh Caddy so any stale block from a partially-completed
      // install no longer points at a container that's never coming up.
      this.proxy.regenerate().catch(() => {});
    }
  }
}
