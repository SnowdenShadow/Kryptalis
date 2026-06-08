import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { COMPOSE_TEMPLATES, PORT_MAP, renderCustomComposeTemplate } from './templates';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { DomainAttachService } from '../domains/domain-attach.service';
import { DatabasesService } from '../databases/databases.service';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const execAsync = promisify(exec);

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
//     rationale; Kryptalis's own mail server feature is the supported
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

const DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const APPS_DIR = path.join(DATA_DIR, 'apps');

// Webmail apps that bind to a specific Kryptalis mail server. Multi-install
// is allowed (one instance per mail server) — uniqueness is enforced on
// (slug, domainId) instead of (slug, projectId).
// Webmail apps the install wizard auto-wires to a Kryptalis mail server.
// Rainloop was here previously but its compose template never had IMAP/SMTP
// env keys to substitute, so the wiring promise was a lie. Dropped along
// with the app itself.
const WEBMAIL_SLUGS = new Set(['roundcube', 'snappymail']);

@Injectable()
export class MarketplaceService {
  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    private domainAttach: DomainAttachService,
    private databases: DatabasesService,
  ) {
    if (!fs.existsSync(APPS_DIR)) {
      fs.mkdirSync(APPS_DIR, { recursive: true });
    }
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

    // Pin serverId to the project's server, ignore whatever the client passed.
    const project = await this.prisma.project.findUnique({
      where: { id: data.projectId },
      select: { serverId: true },
    });
    if (!project) throw new NotFoundException('Project not found.');
    if (data.serverId && data.serverId !== project.serverId) {
      throw new BadRequestException(
        "serverId must match the project's server. Move the project first if you need to relocate.",
      );
    }
    data.serverId = project.serverId;

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
      let suffix = 2;
      while (suffix < 100) {
        const existing = await this.prisma.application.findFirst({
          where: { name: appName, projectId: data.projectId },
          select: { id: true },
        });
        if (!existing) break;
        appName = `${(data.name && data.name.trim()) || app.name} ${suffix}`;
        isMultiInstall = true;
        suffix++;
      }
    }

    // Convenience: caller passed `newDomain: "app.acme.com"`. Create the
    // Domain row + use its id from here on. The downstream attach() call
    // performs cross-server / cross-project validation.
    if (!data.domainId && data.newDomain) {
      const existing = await this.prisma.domain.findUnique({ where: { domain: data.newDomain } });
      if (existing) {
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
    //   2. Multi-install apps → search upward from the template default.
    //   3. Single-install apps → use the template default; refuse with a
    //      clear error if it's busy (instead of silently changing it).
    // Track whether the user PICKED a port — controls whether Caddy serves
    // https://domain:port (user wants the port visible) or https://domain
    // (clean URL, Caddy proxies on 443).
    const basePort = PORT_MAP[data.appSlug] || app.ports[0];
    let realPort: number;
    const customPort = !!data.port;
    if (data.port) {
      if (!(await this.isPortFree(data.port))) {
        throw new ConflictException(`Port ${data.port} is already in use on the host. Pick another.`);
      }
      realPort = data.port;
    } else if (isWebmail || isMultiInstall) {
      // Multi-install (second WordPress, etc.) → walk upward from the
      // template default until we find a free host port. Caddy still
      // serves https://<domain> cleanly because each instance has its own
      // container_name and domain binding.
      realPort = await this.allocateFreePort(basePort);
    } else {
      if (!(await this.isPortFree(basePort))) {
        throw new ConflictException(
          `Default port ${basePort} for ${app.name} is taken. Provide a custom port in the install form.`,
        );
      }
      realPort = basePort;
    }

    // Pre-compute auto-resolved values for webmail-style apps that need to
    // point at an existing Kryptalis mail server. The compose template is
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

    composeContent = composeContent
      .replace(/__INSTANCE_ID__/g, instanceId)
      .replace(/__HOST_PORT__/g, String(realPort));

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

    // Templates already declare:
    //   - networks: kryptalis-apps (external) at top-level
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
    this.runDockerCompose(data.appSlug, composeContent, application.id, task.id, envOverride, true);

    return {
      message: `Installing ${app.name}...`,
      taskId: task.id,
      applicationId: application.id,
      app,
    };
  }

  async uninstall(appSlug: string) {
    const appDir = path.join(APPS_DIR, appSlug);
    if (fs.existsSync(appDir)) {
      try {
        // --rmi local removes any custom-built image; pulled images
        // (postgres, redis…) are shared and left alone.
        await execAsync('docker compose down -v --rmi local --remove-orphans', { cwd: appDir });
      } catch {}
    }
  }

  /**
   * Compute the container_name a template will pick at install time. Mirrors
   * the `container_name: kryptalis-<slug>-__INSTANCE_ID__` convention used by
   * every template in templates.ts. We need this BEFORE the compose file
   * is written so we can persist it on the Application row — Caddy reads
   * the row to know where to proxy.
   */
  private computeContainerName(slug: string, instanceId: string, _appName: string): string {
    // Match the canonical template names. Slugs like 'uptime-kuma' are kept
    // verbatim; the underlying templates use the same form.
    const stem = slug === 'redis' ? 'redis-app' : slug;
    return `kryptalis-${stem}-${instanceId}`;
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
      select: { serverId: true },
    });
    if (!project) throw new NotFoundException('Project not found.');
    if (data.serverId && data.serverId !== project.serverId) {
      throw new BadRequestException("serverId must match the project's server.");
    }
    data.serverId = project.serverId;
    if (!data.name?.trim()) throw new BadRequestException('Name required');
    if (!data.image?.trim()) throw new BadRequestException('Image required');
    if (!Number.isInteger(data.containerPort) || data.containerPort < 1 || data.containerPort > 65535) {
      throw new BadRequestException('containerPort must be 1-65535');
    }
    // Reject obvious shell injection / whitespace in the image ref.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-\/:@]*$/.test(data.image)) {
      throw new BadRequestException('Invalid image reference');
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
    // colliding with marketplace defaults).
    let hostPort: number;
    if (data.hostPort) {
      if (!(await this.isPortFree(data.hostPort))) {
        throw new ConflictException(`Port ${data.hostPort} is already in use on the host`);
      }
      hostPort = data.hostPort;
    } else {
      hostPort = await this.allocateFreePort(18000);
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
        framework: 'DOCKER_COMPOSE',
        status: 'DEPLOYING',
        port: hostPort,
        customPort: !!data.hostPort,
        containerPort: data.containerPort,
        envVars: (data.envVars || {}) as any,
      },
    });

    const instanceId = application.id.slice(0, 12);
    const containerName = `kryptalis-custom-${instanceId}`;
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
    this.runDockerCompose('custom', composeContent, application.id, task.id, data.envVars || {}, true);

    return {
      message: `Deploying ${data.image}…`,
      taskId: task.id,
      applicationId: application.id,
      hostPort,
    };
  }

  private async runDockerCompose(
    slug: string,
    compose: string,
    applicationId: string,
    taskId: string,
    envOverride: Record<string, string> = {},
    perInstanceDir = false,
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

    // user-supplied envVars → written as .env (picked up by docker compose at runtime)
    if (Object.keys(envOverride).length > 0) {
      const envContent = Object.entries(envOverride)
        .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`)
        .join('\n') + '\n';
      fs.writeFileSync(path.join(appDir, '.env'), envContent);
    }

    try {
      await execAsync('docker compose pull', { cwd: appDir, timeout: 600000 });
      await execAsync('docker compose up -d', { cwd: appDir, timeout: 120000 });

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
          select: { projectId: true, project: { select: { serverId: true } } },
        });
        if (appRow?.project?.serverId) {
          await this.databases.importFromAppCompose({
            applicationId,
            projectId: appRow.projectId,
            serverId: appRow.project.serverId,
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
