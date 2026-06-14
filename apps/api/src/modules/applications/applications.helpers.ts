import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

export const execFileAsync = promisify(execFile);
export const DATA_DIR = process.env.DOCKCONTROL_DATA_DIR || path.join(process.cwd(), '.dockcontrol');
export const APPS_DIR = path.join(DATA_DIR, 'apps');

// ── helpers ──────────────────────────────────────────────────────────────

// Identical to the agent's `sanitize()` — must stay byte-for-byte equivalent.
export function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
}

export function containerName(slug: string) {
  return `dockcontrol-${slug}`;
}

/**
 * Canonical slug for an app's compose dir on a REMOTE agent
 * (/opt/dockcontrol/apps/<remoteAppSlug>). Always per-instance — the agent
 * has no resolveAppDir() fallback logic, so every dispatch (deploy, start,
 * stop, restart, remove) must derive the exact same name from the same
 * inputs or lifecycle ops land on the wrong directory.
 */
export function remoteAppSlug(name: string, applicationId: string): string {
  return `${slugify(name)}-${applicationId.slice(0, 12)}`;
}

export function imageName(slug: string) {
  return `dockcontrol/${slug}:latest`;
}

/**
 * Resolve the on-disk compose dir for an application. Marketplace multi-install
 * apps (webmail) use `<slug>-<applicationId.slice(0,12)>`; everything else uses
 * the legacy `<slug>` dir. Picks whichever one actually exists on disk; falls
 * back to the legacy dir when neither exists so the caller can still write a
 * fresh deploy there.
 */
export function resolveAppDir(slug: string, applicationId: string): string {
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
export function resolveContainerName(slug: string, applicationId: string): string {
  const perInstance = path.join(APPS_DIR, `${slug}-${applicationId.slice(0, 12)}`);
  if (fs.existsSync(perInstance)) return `dockcontrol-${slug}-${applicationId.slice(0, 12)}`;
  return `dockcontrol-${slug}`;
}

export interface PortDef {
  service: string;
  host: number | null;
  container: number;
  protocol: string;
}

export function parseComposePorts(content: string): PortDef[] {
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

export function parseDockerfileExposed(content: string): number[] {
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

export function remapComposePorts(content: string, mapping: Record<string, number>): string {
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

/**
 * Build-arg allowlist prefixes. Only env vars whose key starts with one of
 * these framework "public" prefixes are injected into `build.args`. Build
 * args land in the image history (`docker history`) in plaintext, so copying
 * the ENTIRE env map there would leak runtime secrets (DATABASE_URL,
 * JWT_SECRET, third-party API keys). These prefixes are the vars frameworks
 * are *designed* to inline at build time — they're already shipped to the
 * client bundle, so exposing them in image history is not a new leak.
 */
export const BUILD_ARG_PUBLIC_PREFIXES = [
  'NEXT_PUBLIC_',
  'VITE_',
  'REACT_APP_',
  'PUBLIC_',
  'NUXT_PUBLIC_',
  'GATSBY_',
  'EXPO_PUBLIC_',
];

export function isBuildPublicEnvKey(key: string): boolean {
  return BUILD_ARG_PUBLIC_PREFIXES.some((p) => key.startsWith(p));
}

export function injectComposeEnv(content: string, env: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return content;
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  // Build args end up in image history in plaintext — only inject the
  // framework build-time-public vars (NEXT_PUBLIC_*, VITE_*, …), NEVER
  // arbitrary secrets. Runtime env (environment:) below is unaffected.
  const buildEnv = Object.fromEntries(
    Object.entries(env).filter(([k]) => isBuildPublicEnvKey(k)),
  );
  for (const val of Object.values<any>(doc.services)) {
    val.environment = { ...(val.environment || {}), ...env };
    // Services built from source also get the public env as build args —
    // frameworks that inline at build time (Next NEXT_PUBLIC_*, Vite VITE_*)
    // read process.env during `npm run build`, which a Dockerfile maps from
    // ARG. Without this, args hardcoded in the repo's compose win over the
    // dashboard's env tab and "save then redeploy" silently keeps old values.
    if (val.build && Object.keys(buildEnv).length > 0) {
      if (typeof val.build === 'string') val.build = { context: val.build };
      const args = val.build.args;
      if (Array.isArray(args)) {
        // list form: ["KEY=value", ...] — replace overridden keys, append new
        const kept = args.filter((a: any) => {
          const key = String(a).split('=')[0];
          return !(key in buildEnv);
        });
        val.build.args = [...kept, ...Object.entries(buildEnv).map(([k, v]) => `${k}=${v}`)];
      } else {
        val.build.args = { ...(args || {}), ...buildEnv };
      }
    }
  }
  return yaml.dump(doc, { lineWidth: 200 });
}

/**
 * Attach every service in the compose file to a shared external network so apps
 * of the same project can reach each other by service name.
 */
export function attachProjectNetwork(content: string, networkName: string): string {
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  for (const val of Object.values<any>(doc.services)) {
    const existing = val.networks;
    if (Array.isArray(existing)) {
      if (!existing.includes('dockcontrol_project')) existing.push('dockcontrol_project');
    } else if (existing && typeof existing === 'object') {
      existing.dockcontrol_project = {};
    } else {
      val.networks = ['dockcontrol_project'];
    }
  }
  doc.networks = {
    ...(doc.networks || {}),
    dockcontrol_project: { external: true, name: networkName },
  };
  return yaml.dump(doc, { lineWidth: 200 });
}

export function projectNetworkName(projectId: string) {
  return `dockcontrol_proj_${projectId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
}

/**
 * Defensively ensure the shared dockcontrol-apps bridge exists before any
 * `docker run --network dockcontrol-apps`. The network is normally created
 * by the root docker-compose.yml, but on remote agents / standalone
 * boots it might be missing. Idempotent — `network create` returns
 * non-zero when it already exists, which we swallow.
 */
export async function ensureSharedAppsNetwork(): Promise<void> {
  try {
    await execFileAsync('docker', ['network', 'inspect', 'dockcontrol-apps'], { timeout: 5_000 });
  } catch {
    try {
      await execFileAsync('docker', ['network', 'create', 'dockcontrol-apps'], { timeout: 10_000 });
    } catch {}
  }
}

/**
 * Attach every service of a compose file to the shared `dockcontrol-apps`
 * bridge. Caddy lives on that bridge and reaches each container by
 * `container_name:internal_port`. This is what makes zero-host-port
 * deploys possible — multiple apps can listen on port 80 internally
 * without colliding.
 */
export function attachSharedAppsNetwork(content: string): string {
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  for (const val of Object.values<any>(doc.services)) {
    const existing = val.networks;
    if (Array.isArray(existing)) {
      if (!existing.includes('dockcontrol_apps')) existing.push('dockcontrol_apps');
    } else if (existing && typeof existing === 'object') {
      existing.dockcontrol_apps = {};
    } else {
      val.networks = ['dockcontrol_apps'];
    }
  }
  doc.networks = {
    ...(doc.networks || {}),
    dockcontrol_apps: { external: true, name: 'dockcontrol-apps' },
  };
  return yaml.dump(doc, { lineWidth: 200 });
}

/**
 * Strip every `ports:` block from a compose file. Used when the app is
 * reached via Caddy on a domain — no host port publish is needed and
 * keeping one risks colliding with DockControl own services (the dashboard
 * on :3000, the API on :4000, postgres on :5432, etc).
 */
export function stripComposePorts(content: string): string {
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
 * Drop ONLY the host-port publishes whose host side targets a reserved port
 * (Caddy's 80/443, the dashboard on 3000, postgres on 5432, etc). Used for
 * domainless deploys with no user-picked hostPort: a repo's hardcoded
 * `443:443` would otherwise collide with Caddy and break the platform. The
 * container ports are kept — we only remove the offending host binding so the
 * service still publishes its non-reserved ports normally.
 */
export function stripReservedComposePorts(content: string): string {
  const doc: any = yaml.load(content);
  if (!doc?.services) return content;
  for (const val of Object.values<any>(doc.services)) {
    if (!val || typeof val !== 'object' || !Array.isArray(val.ports)) continue;
    val.ports = val.ports.filter((p: any) => {
      let host: number | null = null;
      if (typeof p === 'string') {
        const parts = p.split('/')[0].split(':');
        // forms: "8080" | "8080:80" | "127.0.0.1:8080:80"
        if (parts.length === 2) host = Number(parts[0]);
        else if (parts.length >= 3) host = Number(parts[1]);
        // length 1 ("80") = container-only, no host publish — keep.
      } else if (p && typeof p === 'object' && p.published != null) {
        host = Number(p.published);
      }
      // Keep the publish unless its host side is a reserved port.
      return !(host != null && Number.isFinite(host) && RESERVED_HOST_PORTS.has(host));
    });
    if (val.ports.length === 0) delete val.ports;
  }
  return yaml.dump(doc, { lineWidth: 200 });
}

/**
 * Pull the first declared container_name + first internal target port
 * from a compose file. Used to wire up Caddy's reverse_proxy target
 * without forcing a host port publish.
 */
/**
 * Pull every explicit `container_name` declared in the compose YAML.
 * Used to defensively `docker rm -f` any pre-existing container by the
 * same name BEFORE `compose up -d --build` — otherwise the user's hard-
 * coded names collide with leftovers from a previous failed deploy or
 * another stack using the same names, and compose hard-errors with
 * "container name already in use".
 *
 * Returns the list of names. Services without an explicit container_name
 * are omitted (compose auto-generates safe project-prefixed names for
 * those, no collisions possible).
 */
export function listComposeContainerNames(content: string): string[] {
  try {
    const doc: any = yaml.load(content);
    if (!doc?.services || typeof doc.services !== 'object') return [];
    const names: string[] = [];
    for (const val of Object.values<any>(doc.services)) {
      if (typeof val?.container_name === 'string' && val.container_name.trim()) {
        names.push(val.container_name.trim());
      }
    }
    return names;
  } catch {
    return [];
  }
}

export function readComposeContainerInfo(
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
export async function dockerCompose(
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
 * Pre-flight cleanup: remove any container that already holds one of the
 * explicit `container_name` values the compose file is about to claim.
 *
 * Two scenarios this covers:
 *   1. Previous failed deploy left a stopped container with the same name.
 *   2. Operator manually started a container with this name out-of-band.
 *
 * Best-effort — if `docker rm` fails for any reason, we still try the
 * compose up below; the real error is surfaced from there. Logging into
 * `log` lets the user see exactly what we removed.
 */
export async function removeCollidingContainers(
  composeContent: string,
  log: (line: string) => void,
): Promise<void> {
  const names = listComposeContainerNames(composeContent);
  if (names.length === 0) return;
  for (const name of names) {
    try {
      // `docker ps -a -q -f name=^<name>$` returns IDs of containers with
      // an EXACT name match. The anchors are critical — without them,
      // "enopya-web" would also match "enopya-web-backup" etc.
      const { stdout } = await execFileAsync(
        'docker',
        ['ps', '-a', '-q', '-f', `name=^${name}$`],
        { timeout: 5_000 },
      );
      const id = stdout.trim();
      if (!id) continue;
      log(`> docker rm -f ${name}  (collision with existing container ${id.slice(0, 12)})`);
      await execFileAsync('docker', ['rm', '-f', name], { timeout: 30_000 });
    } catch (e: any) {
      log(`(could not remove ${name}: ${e?.stderr || e?.message || 'unknown'} — continuing)`);
    }
  }
}

/**
 * Host ports reserved by DockControl itself + common system ports. Any
 * attempt to publish an app here is refused with a clear error so the
 * user doesn't break their own dashboard / API / DB connection.
 */
export const RESERVED_HOST_PORTS = new Set<number>([
  22,    // ssh
  80, 443, // caddy
  3000,  // dockcontrol-dashboard
  4000,  // dockcontrol-api
  5432,  // postgres
  6379,  // redis
  2019,  // caddy admin API
  53,    // dns
  25, 465, 587, 993, 995, 110, 143, // mail
]);

export function findComposePath(dir: string): string | null {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── shared cross-service helpers ─────────────────────────────────────────

/**
 * Resolve the server an app runs on: the app's OWN serverId when set
 * (per-app placement — apps in one project can live on different machines),
 * else the project's server (the default placement). Caches nothing —
 * calls are cheap and we want fresh status.
 */
export async function resolveAppServer(prisma: PrismaService, appId: string) {
  const app = await prisma.application.findUnique({
    where: { id: appId },
    select: {
      server: { select: { id: true, host: true } },
      project: { select: { server: { select: { id: true, host: true } } } },
    },
  });
  return app?.server ?? app?.project?.server ?? null;
}

export function isAppLocal(server: { host: string } | null): boolean {
  if (!server) return true;
  return isLocalHost(server.host);
}

// ── access control (RBAC via ProjectMember) ───────────────────────

export async function assertAppOwnership(
  prisma: PrismaService,
  userId: string,
  appId: string,
  minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'DEVELOPER',
) {
  const app = await prisma.application.findUnique({
    where: { id: appId },
  });
  if (!app) throw new NotFoundException('Application not found');
  await assertProjectAccess(prisma, userId, app.projectId, minRole);
  return app;
}
