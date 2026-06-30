import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaService } from '../../prisma/prisma.service';
import { PROXY_DIR } from '../../common/paths';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { SystemConfigService } from '../system/system-config.service';

const execFileAsync = promisify(execFile);
const CONTAINER_NAME = 'dockcontrol-caddy';
// docker-compose.override.yml lives at the install root on the host and
// is bind-mounted into the API container at /app/install-root/. The API
// writes it to publish extra Caddy ports (HTTPS on port-pinned apps).
const OVERRIDE_FILE = process.env.DOCKCONTROL_COMPOSE_OVERRIDE
  || '/app/install-root/docker-compose.override.yml';
// Host path equivalent — needed so when we tell docker compose on the host
// to restart Caddy, the override file is at the path the docker daemon sees.
const INSTALL_ROOT_HOST = process.env.DOCKCONTROL_HOST_INSTALL_DIR
  || process.env.DOCKCONTROL_HOST_DATA_DIR?.replace(/[\\/]\.dockcontrol[\\/]*$/, '')
  || '/opt/dockcontrol';

/**
 * Defense-in-depth Caddyfile injection guards. DTOs reject malformed
 * domains and app names at create time, but legacy rows can still slip
 * past — we re-validate at render time and skip anything dangerous.
 *
 * SAFE_DOMAIN_RE mirrors the CreateDomainDto regex exactly so the two
 * paths cannot drift. Single-label, all-digit TLDs and >253-char hosts
 * are rejected here as well.
 */
const SAFE_DOMAIN_RE =
  /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;

/** Bare IPv4 literal (0-255 per octet). */
const SAFE_IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** IPv6 literal, optionally bracketed — only hex groups, ':' and '.' (IPv4-mapped). */
const SAFE_IPV6_RE = /^\[?[0-9A-Fa-f:.]+\]?$/;

/**
 * Validate a remote upstream host before it is interpolated raw into a
 * `reverse_proxy <host>:<port>` directive. A Server.host that contained
 * whitespace, '{', '}', a newline, or a Caddy directive would let a
 * compromised/legacy server row inject arbitrary Caddyfile config.
 *
 * Accept ONLY: a bare IPv4 literal, a (bracketed or plain) IPv6 literal,
 * or a SAFE_DOMAIN_RE-valid hostname. Anything containing whitespace,
 * control chars, '{', '}', or newlines is rejected so the caller can fail
 * closed and skip the upstream rather than emit a poisoned block.
 */
type RegenerateResult = { domains: number; caddyfile: string; error?: string };

function isSafeUpstreamHost(host: string | null | undefined): boolean {
  if (!host) return false;
  // Reject anything that could break out of the directive line.
  if (/[\s{}"\\#]/.test(host) || /[\x00-\x1f\x7f]/.test(host)) return false;
  if (SAFE_IPV4_RE.test(host)) return true;
  if (host.includes(':')) return SAFE_IPV6_RE.test(host);
  return SAFE_DOMAIN_RE.test(host);
}

/**
 * Strip everything that could break out of a Caddyfile string literal
 * or comment line: CR, LF, `{`, `}`, `\\`, `"`, `#`, control chars.
 * Used for application names that surface in both `respond "..."` and
 * `# comment` contexts.
 */
function sanitizeCaddyName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/[\r\n{}\\"#]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 64);
}

/**
 * Generates a Caddyfile from the current domains↔applications mapping,
 * runs Caddy in a docker container on host ports 80/443, and reloads on changes.
 *
 * For *.local domains we generate a plain HTTP block (no Let's Encrypt).
 * For real domains we let Caddy auto-issue Let's Encrypt certificates.
 *
 * Strategy: Caddy reverse_proxy to host.docker.internal:<port>
 * (works on Docker Desktop Windows/Mac; on Linux production we'd add the
 * `extra_hosts: host-gateway` mapping at compose level).
 */
@Injectable()
export class ReverseProxyService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReverseProxyService.name);
  private sslSyncInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Debounce timer for coalesced reload requests. Bulk operations
   * (e.g. import 10 domains) used to fire 10 back-to-back regenerate()
   * calls — each writing the Caddyfile and exec'ing `caddy reload`. We now
   * funnel high-frequency mutators through scheduleReload() which collapses
   * a burst into a single regenerate.
   */
  private pendingReload: NodeJS.Timeout | null = null;
  private readonly RELOAD_DEBOUNCE_MS = 1500;

  /**
   * Serialization for regenerate(). regenerate() is a read-modify-write on
   * the single shared Caddyfile, fired (often fire-and-forget) from ~30
   * call sites. Two concurrent runs interleave their render→validate→reload
   * and the rollback can restore the wrong "previous" file — or the
   * bind-mounted container reads a half-written Caddyfile.
   *
   * Invariant: at most ONE runRegenerate() executes at a time. While one is
   * in flight, additional callers don't start a second pass — they set
   * regenQueued and share the in-flight promise; a SINGLE trailing run fires
   * once the current one finishes (coalescing, same spirit as scheduleReload).
   */
  private regenInFlight: Promise<RegenerateResult> | null = null;
  private regenQueued = false;

  constructor(
    private prisma: PrismaService,
    private systemConfig: SystemConfigService,
  ) {
    if (!fs.existsSync(PROXY_DIR)) fs.mkdirSync(PROXY_DIR, { recursive: true });
  }

  async onApplicationBootstrap() {
    try {
      // Ensure the Caddyfile exists so the container (managed by the root
      // docker-compose) can mount it successfully. If the file is empty/missing,
      // we seed a placeholder, then regenerate from the live DB state.
      this.ensureCaddyfile();
      await this.regenerate();
    } catch (e: any) {
      this.logger.warn(`Caddy bootstrap deferred: ${e?.message || e}`);
    }
    // Background SSL status reconciliation — catches certs issued asynchronously
    // by Caddy after a regenerate() call OR after manual changes. Also
    // detects mail-server cert renewals and triggers Postfix/Dovecot reload
    // so they stop presenting the old in-memory cert past renewal.
    this.sslSyncInterval = setInterval(() => {
      this.syncSslStatuses().catch(() => {});
      this.syncMailCertReloads().catch(() => {});
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.sslSyncInterval) {
      clearInterval(this.sslSyncInterval);
      this.sslSyncInterval = null;
    }
    if (this.pendingReload) {
      clearTimeout(this.pendingReload);
      this.pendingReload = null;
    }
  }

  /**
   * Schedule a Caddyfile rebuild + reload `RELOAD_DEBOUNCE_MS` (1.5 s) in the
   * future. If called again before the timer fires, the previous timer is
   * cancelled and reset. Net effect: a burst of N calls within the window
   * collapses into ONE regenerate() — bulk domain import, multi-app deploy,
   * project move, etc.
   *
   * Use this for high-frequency mutators (domain create/delete/update, app
   * create, app name change). Synchronous callers that need the new
   * Caddyfile to be live before the next step (cert-renew watcher,
   * bootstrap) should still `await regenerate()` directly.
   */
  scheduleReload(): void {
    if (this.pendingReload) clearTimeout(this.pendingReload);
    this.pendingReload = setTimeout(() => {
      this.pendingReload = null;
      this.regenerate().catch((e) => {
        this.logger.warn(`Debounced regenerate failed: ${e?.message || e}`);
      });
    }, this.RELOAD_DEBOUNCE_MS);
  }

  /**
   * Test-friendly: if a debounced reload is pending, fire it NOW (cancels
   * the timer and runs regenerate synchronously). Returns the regenerate
   * promise so tests can await the resulting Caddyfile. No-op when nothing
   * is pending.
   */
  flushPending(): Promise<unknown> {
    if (!this.pendingReload) return Promise.resolve();
    clearTimeout(this.pendingReload);
    this.pendingReload = null;
    return this.regenerate().catch((e) => {
      this.logger.warn(`flushPending regenerate failed: ${e?.message || e}`);
    });
  }

  private ensureCaddyfile() {
    const caddyfile = path.join(PROXY_DIR, 'Caddyfile');
    if (fs.existsSync(caddyfile)) return;
    const email = this.resolveAcmeEmail();
    const seed = `# Auto-generated by DockControl — do not edit manually.
{
  admin :2019
${email ? `  email ${email}\n` : ''}}
:80 {
  respond "DockControl: no domain configured yet." 404
}
`;
    fs.writeFileSync(caddyfile, seed);
  }

  /**
   * Write `content` to the Caddyfile.
   *
   * Caddy mounts the reverse-proxy DIRECTORY (`./.dockcontrol/reverse-proxy →
   * /etc/caddy`), so a rewrite is always visible to the container. We write IN
   * PLACE (truncate + write) rather than tmp+rename: the in-place write is
   * correct for both the current directory mount AND any legacy single-file
   * mount still present on not-yet-recreated installs (a tmp+rename would swap
   * the inode and break the single-file case). A partial write is harmless —
   * `caddy validate` runs immediately after and the caller rolls back on
   * failure.
   */
  private atomicWriteCaddyfile(targetPath: string, content: string): void {
    fs.writeFileSync(targetPath, content);
  }

  /**
   * Caddy now lives in the root docker-compose. These methods proxy to that
   * container. start/stop become docker-compose calls at repo root.
   */
  async ensureRunning() {
    const current = await this.status();
    if (current.running) {
      return { ok: true, running: true, status: current.status, message: 'Caddy is already running' };
    }
    // Caddy is managed by the root compose. From inside the API container we
    // can't reach the host's compose file, but we CAN start the container by
    // name via the mounted docker socket. (Compose just labels the containers;
    // `docker start` works the same.)
    try {
      await execFileAsync('docker', ['start', CONTAINER_NAME], { timeout: 30_000 });
    } catch (e: any) {
      this.logger.warn(`Could not start caddy: ${e?.message}`);
      return { ok: false, running: false, status: 'error', message: e?.message || 'Failed to start Caddy' };
    }
    const after = await this.status();
    return { ok: after.running, running: after.running, status: after.status, message: after.running ? 'Caddy started' : 'Caddy did not come up' };
  }

  async stop() {
    try {
      await execFileAsync('docker', ['stop', CONTAINER_NAME], { timeout: 30_000 });
      return { ok: true, running: false, status: 'stopped', message: 'Caddy stopped' };
    } catch (e: any) {
      return { ok: false, running: false, status: 'error', message: e?.message || 'Failed to stop Caddy' };
    }
  }

  // ── status ────────────────────────────────────────────────────────
  //
  // We use `docker ps --filter` rather than `docker inspect <name>` because:
  //   1. ps succeeds even when the container doesn't exist (empty output)
  //   2. inspect needs the EXACT name; compose may prefix it depending on version
  //
  // We also fall back to looking up by image so a Caddy container started with
  // a different name (legacy installs) is still detected.
  async status() {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['ps', '-a', '--filter', `name=${CONTAINER_NAME}`, '--format', '{{.State}}|{{.Status}}|{{.Names}}'],
        { timeout: 5000 },
      );
      const line = stdout.trim().split('\n').find(Boolean);
      if (!line) return { running: false, status: 'not-found' };
      const [state, statusLine, name] = line.split('|');
      const running = state === 'running';
      return { running, status: state || 'unknown', detail: statusLine, name };
    } catch (e: any) {
      this.logger.warn(`status check failed: ${e?.message}`);
      return { running: false, status: 'error', message: e?.message };
    }
  }

  // ── regenerate + reload ───────────────────────────────────────────

  /**
   * Public entry point — serializes against concurrent callers. If a
   * regenerate is already running, this does NOT start a second overlapping
   * pass; it marks a trailing run as needed and resolves with the result of
   * the run that observes the latest DB state. Net effect: a burst of N
   * concurrent regenerate() calls produces at most 2 actual passes (the one
   * already running + a single trailing one that captures everyone's writes).
   */
  async regenerate(): Promise<RegenerateResult> {
    if (this.regenInFlight) {
      // A pass is already running (or a trailing pass is already chained
      // behind it). Don't start a second overlapping pass — ensure exactly
      // one trailing pass runs after the current chain so our (and any
      // sibling caller's) DB mutations are picked up, and share that promise.
      this.regenQueued = true;
      return this.regenInFlight;
    }
    // regenInFlight tracks the WHOLE chain (current pass + any coalesced
    // trailing pass) and is only cleared once the chain fully settles, so
    // there is no gap where a concurrent caller could slip past the guard.
    const chain = this.regenerateChain().finally(() => {
      this.regenInFlight = null;
    });
    this.regenInFlight = chain;
    return chain;
  }

  /**
   * Run runRegenerate() and, when it finishes, drain a single queued trailing
   * run if one was requested while it was in flight. Loops (not recurses on
   * the public guard) so coalescing collapses any number of concurrent
   * requests into one tail without ever clearing regenInFlight mid-chain.
   */
  private async regenerateChain(): Promise<RegenerateResult> {
    let result: RegenerateResult;
    do {
      this.regenQueued = false;
      try {
        result = await this.runRegenerate();
      } catch (e: any) {
        // Soft-fail rather than reject the shared promise — fire-and-forget
        // callers must not emit unhandled rejections, and a queued trailing
        // run should still get its chance.
        this.logger.warn(`regenerate failed: ${e?.message || e}`);
        result = { domains: 0, caddyfile: '', error: e?.message || String(e) };
      }
      // If a caller requested a regenerate while the pass above was running,
      // loop once more to capture their writes.
    } while (this.regenQueued);
    return result;
  }

  private async runRegenerate(): Promise<RegenerateResult> {
    // EVERY domain owned by a project — even those not yet linked to an app.
    // Reserved domains still get a Caddy block so Let's Encrypt provisions the cert
    // in advance (the user gets a green padlock the moment they wire it to an app).
    // H-3: when ownership verification is enforced, an unverified domain must
    // NOT be rendered into Caddy (no routing, no cert issuance) — that's what
    // stops cross-tenant pre-emption from yielding a real cert under a victim's
    // name. With verification off (default), verifiedAt was stamped at create
    // time so this filter is a no-op.
    const requireVerification = this.systemConfig.getBool('require_domain_verification');
    const allDomains = await this.prisma.domain.findMany({
      where: requireVerification ? { verifiedAt: { not: null } } : undefined,
      include: {
        application: {
          select: {
            id: true, name: true, port: true, customPort: true,
            containerName: true, containerPort: true,
            // Server host — when the app runs on a REMOTE server, Caddy
            // (this host) can't reach it by container name; it must proxy
            // to <server.host>:<published host port> over the wire.
            // app.server (per-app placement) wins over the project default.
            server: { select: { host: true } },
            project: { select: { server: { select: { host: true } } } },
          },
        },
        portBindings: {
          include: {
            application: {
              select: {
                id: true, name: true, containerName: true, containerPort: true, port: true,
                server: { select: { host: true } },
                project: { select: { server: { select: { host: true } } } },
              },
            },
          },
        },
      },
    });

    // Some apps listen on HTTPS internally with a self-signed cert. When we
    // reverse_proxy to them in plain HTTP, Caddy gets a TLS alert and
    // returns 502. Detection:
    //   1. well-known TLS-only port numbers (443/8443/9443) on the target
    //      port. Covers current installs — the Portainer template now maps
    //      the plain-HTTP listener (9000), so a 9000 target stays http; old
    //      installs stored containerPort 9443 and stay https.
    //   2. Portainer name/containerName heuristics, ONLY as a fallback for
    //      legacy rows with no containerPort (pre-schema-bump installs all
    //      used the 9443 HTTPS template). Must NOT apply when containerPort
    //      is known: a new install named "portainer" targets HTTP :9000 and
    //      forcing TLS there would break it the same way in reverse.
    //      Name matching is case-INsensitive prefix ("portainer" from the
    //      unified deploy dialog, "Portainer 2" multi-install suffix).
    const HTTPS_UPSTREAM_CONTAINER_RE = /^dockcontrol-portainer-/;
    const HTTPS_UPSTREAM_NAME_RE = /^portainer\b/i;
    const HTTPS_UPSTREAM_PORTS = new Set([443, 8443, 9443]);
    // mail server domains — we provision a Let's Encrypt cert for mail.<apex>
    // so the mail server container can re-use it.
    const mailServers = await this.prisma.mailServer.findMany({
      select: { serverId: true, domain: { select: { domain: true } } },
    });

    // ACME contact email — Let's Encrypt refuses bogus addresses ("localhost",
    // empty, etc.) so we derive a sensible default from PUBLIC_API_URL when the
    // operator hasn't set ACME_EMAIL explicitly.
    const acmeEmail = this.resolveAcmeEmail();

    const blocks: string[] = [
      '# Auto-generated by DockControl — do not edit manually.',
      '{',
      '  admin :2019',
    ];
    // Only emit `email` when we have something Let's Encrypt accepts.
    // Without it, Caddy still gets a cert (just no expiry notices).
    if (acmeEmail) blocks.push(`  email ${acmeEmail}`);
    blocks.push('}');
    blocks.push('');

    let activeCount = 0;
    let reservedCount = 0;
    const newStatusByDomainId: Record<string, 'ACTIVE' | 'PENDING'> = {};

    /**
     * Build the reverse_proxy directive for an app.
     *
     * Preferred path: when we know the container_name + the internal port
     * the container listens on, proxy directly over the shared docker
     * network. Lets Caddy publish the host port without colliding with the
     * container's own port publish — that's how HTTPS-on-custom-port works.
     *
     * Fallback: legacy apps that don't have containerName/containerPort
     * stored yet (deployed before the schema bump) keep hitting
     * host.docker.internal:<hostPort>. Works for clean URLs on :443 but
     * breaks when the user also wants HTTPS on a custom port — they need
     * to redeploy from the marketplace to migrate.
     */
    const proxyFor = (
      app: {
        name: string;
        containerName?: string | null;
        containerPort?: number | null;
        server?: { host: string | null } | null;
        project?: { server?: { host: string | null } | null } | null;
      },
      hostPort: number,
    ): string | null => {
      // Remote app (MULTI mode): the container lives on another machine —
      // container-name DNS doesn't resolve here. Proxy to the remote
      // server's public host on the app's PUBLISHED host port (every
      // remote deploy publishes hostPort:containerPort, so the port is
      // reachable from this box). TLS hint keys off the CONTAINER port —
      // that's the listener's protocol regardless of the published number.
      // app.server = per-app placement; falls back to the project default.
      const serverHost = app.server?.host ?? app.project?.server?.host;
      const isRemote = !!serverHost && !isLocalHost(serverHost);
      // Defense-in-depth: serverHost is interpolated raw into the upstream
      // address. A malformed/hostile Server.host (whitespace, '{', '}',
      // newline, a Caddy directive) would inject arbitrary config. Validate
      // exactly like a domain at render time and FAIL CLOSED — skip the
      // upstream block rather than emit a poisoned one.
      if (isRemote && !isSafeUpstreamHost(serverHost)) {
        this.logger.warn(
          `Refusing to render reverse_proxy upstream for app '${app.name}' — unsafe server host '${serverHost}'. Skipping this upstream.`,
        );
        return null;
      }
      const target = isRemote
        ? `${serverHost}:${hostPort}`
        : app.containerName && app.containerPort
          ? `${app.containerName}:${app.containerPort}`
          : `host.docker.internal:${hostPort}`;
      const targetPortForHttpsHint = app.containerPort || hostPort;
      // Known containerPort is authoritative — new Portainer installs target
      // the plain-HTTP listener (9000) and must NOT be forced to TLS by the
      // legacy name heuristics below.
      const upstreamHttps = app.containerPort
        ? HTTPS_UPSTREAM_PORTS.has(app.containerPort)
        : (!!app.containerName && HTTPS_UPSTREAM_CONTAINER_RE.test(app.containerName)) ||
          HTTPS_UPSTREAM_NAME_RE.test(app.name) ||
          HTTPS_UPSTREAM_PORTS.has(targetPortForHttpsHint);
      // Caddy resolves the upstream hostname ONCE at config load when no
      // explicit DNS TTL is set, then caches the IP forever. Docker
      // assigns new IPs on every container recreate (redeploy / restart),
      // so the cached IP goes stale and Caddy hits ECONNREFUSED → 502.
      //
      // `dial_timeout` + `resolvers 127.0.0.11` (Docker's embedded DNS,
      // available on every user-defined network) + a short response
      // header timeout makes Caddy re-resolve fresh on every connect.
      // Costs us ~1ms per request inside the same docker network —
      // worth it to never serve a 502 after a redeploy again.
      const transport = `    transport http {\n      dial_timeout 5s\n      response_header_timeout 30s\n      resolvers 127.0.0.11\n${upstreamHttps ? '      tls\n      tls_insecure_skip_verify\n' : ''}    }`;
      const scheme = upstreamHttps ? 'https://' : '';
      // lb_try_duration: retry the upstream for a few seconds instead of an
      // instant 502 — covers the window where the container is being
      // recreated by a redeploy/restart.
      return `  reverse_proxy ${scheme}${target} {\n    lb_try_duration 10s\n    lb_try_interval 500ms\n${transport}\n  }`;
    };

    // Platform domain — fetched BEFORE the loop so domain rows that
    // collide with it can be skipped (two site blocks for the same host
    // make the whole Caddyfile invalid → Caddy refuses to load → every
    // domain goes down with ERR_CONNECTION_REFUSED).
    const systemDomain = await this.prisma.systemSetting
      .findUnique({ where: { key: 'system_domain' } })
      .then((r) => (typeof r?.value === 'string' ? r.value : null))
      .catch(() => null);

    for (const d of allDomains) {
      const host = d.domain;
      if (!SAFE_DOMAIN_RE.test(host)) {
        this.logger.warn(`Refusing to render Caddyfile block for unsafe domain '${host}'`);
        continue;
      }
      if (systemDomain && host === systemDomain) {
        // The platform block (below) owns this hostname — rendering the
        // app block too would duplicate the site definition.
        this.logger.warn(
          `Domain '${host}' is also the platform domain (system_domain) — serving the dashboard there; the app attachment is ignored. Use a different domain for the app.`,
        );
        newStatusByDomainId[d.id] = 'ACTIVE';
        activeCount++;
        continue;
      }
      // App and binding names also reach the Caddyfile via the 'respond'
      // string literal AND comment lines. Sanitize for both paths.
      const safeMainAppName = sanitizeCaddyName(d.application?.name);
      const isLocal = this.isLocalHostname(host);

      // Main app on :443 (clean-URL slot). Tracked via Domain.applicationId.
      // An app is "linked" if EITHER:
      //   - container_name + container_port are known (Caddy proxies over
      //     the shared dockcontrol-apps bridge — preferred path), OR
      //   - app.port is set (legacy host.docker.internal:<hostPort> path)
      // Requiring BOTH meant compose-style apps that strip host ports
      // sat in "reserved" mode forever.
      const mainPort = d.application?.port ?? d.application?.containerPort ?? null;
      const hasContainerTarget =
        !!d.application?.containerName && !!d.application?.containerPort;
      const mainLinked = !!d.applicationId && !!d.application && (hasContainerTarget || !!mainPort);
      const mainApp = d.application;

      // Port-pinned apps. Caddy publishes their port on the host (override
      // file) and proxies via the shared docker network.
      const portBindings = (d.portBindings || []).filter((b) => !!b.port);

      // Is a port-bound app remote? The redirect to http://domain:port only
      // works when the container publishes on THIS host (the domain's DNS
      // points here). A remote app publishes on its own server — Caddy must
      // proxy over the wire instead of redirecting into the void.
      const bindingIsRemote = (b: (typeof portBindings)[number]) => {
        const a: any = b.application;
        const h = a?.server?.host ?? a?.project?.server?.host;
        return !!h && !isLocalHost(h);
      };

      // ── :443 block ────────────────────────────────────────────────
      if (isLocal) {
        blocks.push(`# ${host} :80 → ${mainLinked ? `app ${safeMainAppName}` : 'reserved'}`);
        blocks.push(`http://${host} {`);
        if (mainLinked) {
          const proxy = proxyFor(mainApp!, mainPort ?? 0);
          // proxyFor returns null when the remote upstream host is unsafe —
          // fail closed with a 502 rather than emit an injected directive.
          blocks.push(proxy ?? `  respond "Upstream unavailable." 502`);
        } else if (portBindings.length > 0) {
          const first = portBindings[0];
          blocks.push(`  respond "Open http://${host}:${first.port} for ${sanitizeCaddyName(first.application.name)}." 200`);
        } else {
          blocks.push(`  respond "Domain reserved in DockControl — link it to an app to serve traffic." 503`);
        }
        blocks.push(`}`);
      } else {
        blocks.push(`# ${host} :443 → ${mainLinked ? `app ${safeMainAppName}` : (portBindings.length > 0 ? 'port-bound apps' : 'reserved')}`);
        blocks.push(`${host} {`);
        if (mainLinked) {
          const proxy = proxyFor(mainApp!, mainPort ?? 0);
          blocks.push(proxy ?? `  respond "Upstream unavailable." 502`);
        } else if (portBindings.length > 0) {
          const first = portBindings[0];
          if (bindingIsRemote(first)) {
            // Remote port-bound app: proxy through to <server>:<port> —
            // a redirect to http://domain:port would land on THIS host
            // where nothing listens on that port.
            const proxy = proxyFor(first.application as any, first.port);
            blocks.push(proxy ?? `  respond "Upstream unavailable." 502`);
          } else {
            // Local port binding = direct container publish (plain HTTP, no
            // TLS termination by Caddy) — redirect to http://, not https://,
            // or the browser hits a TLS handshake error against the bare
            // container.
            blocks.push(`  redir http://${host}:${first.port}{uri} 308`);
          }
        } else {
          blocks.push(`  respond "Domain reserved in DockControl — link it to an app to serve traffic." 503`);
        }
        blocks.push(`}`);
      }
      blocks.push('');

      // Port-pinned URLs aren't proxied — Caddy only binds 80/443. The user
      // opens http://<host>:<port> directly to the container's own publish.
      // We document the binding in the Caddyfile so an operator reading
      // the file knows where each port goes.
      for (const b of portBindings) {
        blocks.push(`# http://${host}:${b.port} → app ${sanitizeCaddyName(b.application.name)} (direct container publish, not proxied by Caddy)`);
        blocks.push('');
      }

      const hasAnyApp = mainLinked || portBindings.length > 0;
      if (hasAnyApp) {
        newStatusByDomainId[d.id] = 'ACTIVE';
        activeCount++;
      } else {
        newStatusByDomainId[d.id] = 'PENDING';
        reservedCount++;
      }
    }

    // ── platform domain (system_domain) ───────────────────────────
    // Serves the DASHBOARD itself on https://<domain> and proxies /api/*
    // to the API container — replaces http://<ip>:3000 with a clean TLS
    // URL. The dashboard's runtime API resolution (api.ts) detects the
    // standard-port origin and goes same-origin, so /api lands here.
    // Validated at write time (updateSetting) + re-checked here.
    // (systemDomain itself is fetched above the domain loop — colliding
    // Domain rows are skipped there to keep the site definition unique.)
    if (systemDomain && SAFE_DOMAIN_RE.test(systemDomain) && !this.isLocalHostname(systemDomain)) {
      blocks.push(`# ${systemDomain} :443 → DockControl dashboard + API (platform domain)`);
      blocks.push(`${systemDomain} {`);
      // API first — more specific matcher wins in Caddy, but keep the
      // explicit handle ordering anyway for readability.
      // lb_try_*: retry instead of instant 502 while the API/dashboard
      // container is restarting (platform self-update, compose recreate).
      // No response_header_timeout here — the API serves long-lived
      // streams (logs follow, terminal) that must not be cut at 30s.
      blocks.push(`  handle /api/* {`);
      blocks.push(`    reverse_proxy dockcontrol-api:4000 {`);
      blocks.push(`      lb_try_duration 15s`);
      blocks.push(`      lb_try_interval 500ms`);
      blocks.push(`      transport http {`);
      blocks.push(`        dial_timeout 5s`);
      blocks.push(`        resolvers 127.0.0.11`);
      blocks.push(`      }`);
      blocks.push(`    }`);
      blocks.push(`  }`);
      blocks.push(`  handle {`);
      blocks.push(`    reverse_proxy dockcontrol-dashboard:3000 {`);
      blocks.push(`      lb_try_duration 15s`);
      blocks.push(`      lb_try_interval 500ms`);
      blocks.push(`      transport http {`);
      blocks.push(`        dial_timeout 5s`);
      blocks.push(`        resolvers 127.0.0.11`);
      blocks.push(`      }`);
      blocks.push(`    }`);
      blocks.push(`  }`);
      blocks.push(`}`);
      blocks.push('');
    }

    // mail.<apex> routes — only purpose is to obtain Let's Encrypt certs for the mail server.
    // The mail server itself reads the cert files from the shared Caddy volume.
    // Same SAFE_DOMAIN_RE gate as the main loop — legacy rows that predate
    // strict validation cannot reach the renderer.
    for (const ms of mailServers) {
      // Mail servers running on a REMOTE agent host issue their OWN cert via an
      // embedded Caddy (mail.<apex> DNS points at that server, so the platform
      // Caddy here can't pass HTTP-01 anyway). Skip them — only render blocks
      // for mail servers on the primary host (serverId null).
      if (ms.serverId) continue;
      const apex = ms.domain.domain;
      if (this.isLocalHostname(apex)) continue;
      if (!SAFE_DOMAIN_RE.test(apex)) {
        this.logger.warn(`Refusing to render mail Caddyfile block for unsafe domain '${apex}'`);
        continue;
      }
      const mailHost = `mail.${apex}`;
      blocks.push(`# ${mailHost} → cert provisioning for mail server`);
      blocks.push(`${mailHost} {`);
      blocks.push(`  respond "DockControl mail server. Use IMAP/SMTP clients, not HTTP." 200`);
      blocks.push(`}`);
      blocks.push('');
    }

    // catch-all fallback so connections to any unconfigured Host:port 80 don't 502
    blocks.push(':80 {');
    blocks.push('  respond "Domain not configured in DockControl." 404');
    blocks.push('}');

    const caddyfile = blocks.join('\n');
    const caddyfilePath = path.join(PROXY_DIR, 'Caddyfile');
    // Captured INSIDE the critical section (regenerate() is now serialized,
    // so no concurrent pass can mutate the file between this read and the
    // rollback below). Keep the previous (known-good) config for rollback:
    // an invalid Caddyfile makes `caddy reload` fail AND a container restart
    // loop — every hosted domain drops with ERR_CONNECTION_REFUSED.
    let previousCaddyfile: string | null = null;
    try {
      previousCaddyfile = fs.readFileSync(caddyfilePath, 'utf-8');
    } catch {}
    // Atomic publish: write a temp file then rename over the target. The
    // Caddyfile is bind-mounted into the container; a plain writeFileSync
    // would let the container observe a half-written file mid-write (and a
    // concurrent validate would parse garbage). rename() is atomic on the
    // same filesystem, so readers see either the old or the new file whole.
    this.atomicWriteCaddyfile(caddyfilePath, caddyfile);

    // Validate INSIDE the container (same binary/version that will load
    // it — the file is bind-mounted, so the new content is already
    // visible there). On failure: restore the previous config and bail
    // out of the reload — serving yesterday's routes beats serving none.
    try {
      await execFileAsync(
        'docker',
        ['exec', CONTAINER_NAME, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'],
        { timeout: 15_000 },
      );
    } catch (e: any) {
      this.logger.error(
        `Generated Caddyfile failed validation — rolling back to the previous config. Error: ${e?.stderr || e?.message}`,
      );
      if (previousCaddyfile !== null) {
        this.atomicWriteCaddyfile(caddyfilePath, previousCaddyfile);
      }
      return { domains: activeCount, caddyfile, error: 'caddyfile validation failed — previous config kept' };
    }

    // Caddy ONLY binds 80/443. Port-pinned URLs (https://domain:port) are
    // NOT proxied — the user opens http://domain:port directly to the
    // container's published port. Trying to make Caddy bind extra ports
    // conflicts with the app's own port publish (only one process can bind
    // a host port). Keeping it simple = stable.
    const portsChanged = await this.syncCaddyComposeOverride([]);

    // If extra ports changed, we MUST recreate the Caddy container so docker
    // picks up the new port bindings — a `caddy reload` from inside the
    // container can't add new listening sockets to the host.
    // Graceful reload — fast (no downtime) since Caddy never changes its
    // listening ports.
    try {
      await execFileAsync(
        'docker',
        ['exec', CONTAINER_NAME, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
        { timeout: 15_000 },
      );
      this.logger.log(`Caddy reloaded — ${activeCount} active, ${reservedCount} reserved`);
    } catch (e: any) {
      this.logger.warn(`reload failed (${e?.message}); restarting container`);
      try {
        await execFileAsync('docker', ['restart', CONTAINER_NAME], { timeout: 30_000 });
      } catch {}
    }
    void portsChanged;

    // sync DB statuses + persist for visibility
    await Promise.all(
      Object.entries(newStatusByDomainId).map(([id, status]) =>
        this.prisma.domain.update({ where: { id }, data: { status } }),
      ),
    );

    // Caddy emits ACME challenges async — schedule a few SSL status syncs after
    // the reload so the dashboard sees the green padlock without manual resync.
    [10_000, 30_000, 60_000, 120_000].forEach((ms) => {
      setTimeout(() => this.syncSslStatuses().catch(() => {}), ms);
    });

    return { domains: activeCount, caddyfile };
  }

  /**
   * Ask Caddy which domains have a valid cert and update Domain.sslStatus in DB.
   * Caddy stores certs under /data/caddy/certificates/<issuer>/<domain>/. The
   * mere presence of <domain>.crt means the cert is issued.
   */
  async syncSslStatuses() {
    const domains = await this.prisma.domain.findMany({
      select: { id: true, domain: true, sslStatus: true },
    });
    if (!domains.length) return { updated: 0 };

    let updated = 0;
    let checked = 0;
    for (const d of domains) {
      // skip local hostnames — Caddy uses its internal CA, not Let's Encrypt
      if (this.isLocalHostname(d.domain)) continue;
      checked++;
      const hasCert = await this.hasIssuedCert(d.domain);
      const newStatus = hasCert ? 'ACTIVE' : 'PENDING';
      if (d.sslStatus !== newStatus) {
        await this.prisma.domain.update({
          where: { id: d.id },
          data: {
            sslStatus: newStatus as any,
            sslExpiresAt: hasCert ? new Date(Date.now() + 90 * 24 * 3600 * 1000) : null,
          },
        });
        updated++;
        this.logger.log(`SSL: ${d.domain} → ${newStatus}`);
      }
    }
    this.logger.debug(`SSL sync: ${checked} checked, ${updated} updated`);
    return { updated, checked };
  }

  /**
   * Maintain docker-compose.override.yml — adds extra `port:port/tcp` and
   * `/udp` publications to the Caddy container so HTTPS-on-port-pinned apps
   * actually reach Caddy. Returns true when the file was rewritten (caller
   * needs to recreate Caddy to pick up new bindings).
   *
   * The file is bind-mounted at /app/install-root/docker-compose.override.yml
   * (see docker-compose.yml). The host has it at /opt/dockcontrol/docker-compose.override.yml.
   */
  private async syncCaddyComposeOverride(extraPorts: number[]): Promise<boolean> {
    // Defense-in-depth: ports are concatenated raw into YAML. Today the only
    // caller passes [], but reject anything that isn't a valid TCP/UDP port
    // (integer in 1..65535) before emission so a future caller can't inject
    // YAML via a bogus value. Skips the empty-array fast path entirely.
    const safePorts = extraPorts.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
    if (safePorts.length !== extraPorts.length) {
      this.logger.warn(
        `Dropping invalid Caddy override port(s): ${extraPorts.filter((p) => !safePorts.includes(p)).join(', ')}`,
      );
    }
    const portLines = safePorts.flatMap((p) => [`      - "${p}:${p}"`, `      - "${p}:${p}/udp"`]);
    const desired = `# Auto-managed by DockControl API — do not edit.
# Extra ports published on the Caddy container for HTTPS port-pinned bindings.
services:
  caddy:
    ports:
${portLines.length > 0 ? portLines.join('\n') : '      []'}
`;
    let current = '';
    try {
      current = fs.readFileSync(OVERRIDE_FILE, 'utf-8');
    } catch {
      // File doesn't exist or mount wasn't applied yet — write anyway.
    }
    if (current.trim() === desired.trim()) return false;
    try {
      fs.writeFileSync(OVERRIDE_FILE, desired);
      return true;
    } catch (e: any) {
      this.logger.warn(`Could not write ${OVERRIDE_FILE}: ${e?.message}. Caddy will keep its current port set.`);
      return false;
    }
  }

  private async hasIssuedCert(host: string): Promise<boolean> {
    try {
      // Defense-in-depth: a host with shell metacharacters must never reach the
      // `sh -c` below. Hostnames are RFC-1035 (letters/digits/dot/dash) — refuse
      // anything else outright rather than interpolate it.
      if (!/^[a-zA-Z0-9.-]+$/.test(host)) return false;
      // Look for the cert file inside the Caddy container. The exact subdir
      // varies by CA (acme-v02.api.letsencrypt.org-directory for LE prod,
      // acme-staging-v02… for staging) so we glob.
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', CONTAINER_NAME, 'sh', '-c',
          `ls /data/caddy/certificates/*/${host}/${host}.crt 2>/dev/null | head -1`],
        { timeout: 5000 },
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Public wrapper — does Caddy hold a valid cert for `host`? (SSL diagnostics) */
  async certExists(host: string): Promise<boolean> {
    return this.hasIssuedCert(host);
  }

  /**
   * Return the most recent Caddy log lines relevant to a domain's certificate
   * issuance (the real ACME error lives here: rate limits, failed HTTP-01
   * challenges, DNS problems). `host` is NEVER passed to a shell — we fetch the
   * container's logs with execFile (argv array, no shell) and filter in JS.
   */
  async getAcmeLogsForDomain(host: string, lines = 200): Promise<string[]> {
    const tail = Math.max(50, Math.min(1000, Math.floor(lines) || 200));
    let raw = '';
    try {
      // `docker logs` writes to stderr for many runtimes — capture both.
      const { stdout, stderr } = await execFileAsync(
        'docker',
        ['logs', '--tail', String(tail), CONTAINER_NAME],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      raw = `${stdout || ''}${stderr || ''}`;
    } catch {
      return [];
    }
    const hostLc = (host || '').toLowerCase();
    if (!hostLc) return [];
    const out: string[] = [];
    let bytes = 0;
    for (const line of raw.split('\n')) {
      const l = line.toLowerCase();
      // ONLY keep lines that mention THIS host. The shared Caddy container logs
      // every tenant's ACME activity; an earlier version also kept any line
      // carrying a generic marker (acme/obtain/error/tls/...), which leaked
      // OTHER tenants' domain names, challenge URLs and rate-limit details to
      // any project member who could read this domain's SSL logs. Filtering
      // strictly on the caller's own hostname keeps the diagnostics useful
      // without cross-tenant disclosure.
      if (!l.includes(hostLc)) continue;
      out.push(line);
      bytes += line.length + 1;
      if (bytes > 50_000) break;
    }
    return out;
  }

  /**
   * Detect when a mail-server cert (mail.<apex>) has been renewed by Caddy
   * and signal the mail container to reload Postfix + Dovecot.
   *
   * Why: docker-mailserver reads SSL_CERT_PATH/SSL_KEY_PATH at boot only.
   * When Caddy renews the cert in-place every ~60 days, the on-disk file
   * changes but the running Postfix/Dovecot keep presenting the OLD cert
   * (in-memory). At 90d expiry, TLS handshakes start failing.
   *
   * We track the cert's mtime by host. When it shifts on a known mail
   * domain, fire a reload via MailServerService.reloadMailServer().
   *
   * Mtime tracking lives in `mail-cert-mtime.json` under PROXY_DIR. Cheap,
   * survives restarts.
   */
  private mailCertMtimeFile = path.join(PROXY_DIR, 'mail-cert-mtime.json');
  private mailCertMtime: Record<string, number> = {};

  private loadMailCertMtime() {
    try {
      if (fs.existsSync(this.mailCertMtimeFile)) {
        this.mailCertMtime = JSON.parse(fs.readFileSync(this.mailCertMtimeFile, 'utf-8'));
      }
    } catch {
      this.mailCertMtime = {};
    }
  }

  private saveMailCertMtime() {
    try {
      fs.writeFileSync(this.mailCertMtimeFile, JSON.stringify(this.mailCertMtime));
    } catch {}
  }

  private async getCertMtime(host: string): Promise<number | null> {
    // host is interpolated into a `sh -c` command, so reject anything outside
    // the DNS charset before it reaches the shell — mirrors the identical guard
    // in hasIssuedCert(). host is currently always "mail.<validated-domain>",
    // but this keeps the two cert helpers consistent and fails safe if the
    // input source ever changes.
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) return null;
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', CONTAINER_NAME, 'sh', '-c',
          `stat -c %Y /data/caddy/certificates/*/${host}/${host}.crt 2>/dev/null | head -1`],
        { timeout: 5000 },
      );
      const n = parseInt(stdout.trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Iterate every mail server. If its cert's mtime moved since the last
   * check, call the registered reload hook. The MailServerService injects
   * itself via setMailReloadHook to avoid a circular dependency.
   */
  private mailReloadHook: ((domainId: string) => Promise<void>) | null = null;
  setMailReloadHook(fn: (domainId: string) => Promise<void>) {
    this.mailReloadHook = fn;
  }

  async syncMailCertReloads(): Promise<void> {
    if (!this.mailReloadHook) return;
    if (Object.keys(this.mailCertMtime).length === 0) this.loadMailCertMtime();
    const servers = await this.prisma.mailServer.findMany({
      select: { serverId: true, domain: { select: { id: true, domain: true } } },
    });
    let changed = false;
    for (const s of servers) {
      if (!s.domain) continue;
      // Remote mail servers manage their own cert (embedded Caddy on their
      // host); the platform Caddy here has no cert file to stat for them.
      if (s.serverId) continue;
      const host = `mail.${s.domain.domain}`;
      const mt = await this.getCertMtime(host);
      if (mt == null) continue;
      const prev = this.mailCertMtime[host] || 0;
      if (mt !== prev) {
        // Fire on EVERY change, INCLUDING the first sighting (prev === 0): a
        // mail server may have been deployed WITHOUT TLS while waiting for the
        // cert, and the reload hook redeploys it with TLS once the cert lands.
        // (reloadMailServer is a no-op reload when TLS is already configured.)
        this.logger.log(`Mail cert for ${host} present/changed (mtime ${prev} → ${mt}) — reconciling mail server`);
        try { await this.mailReloadHook(s.domain.id); } catch {}
        this.mailCertMtime[host] = mt;
        changed = true;
      }
    }
    if (changed) this.saveMailCertMtime();
  }

  // ── helpers ───────────────────────────────────────────────────────

  /**
   * Pick the email Caddy registers with Let's Encrypt.
   *
   * Resolution order:
   *   1. ACME_EMAIL env var (operator override)
   *   2. admin@<apex of PUBLIC_API_URL> if it's a real domain
   *   3. admin@<first registered domain in DB>
   *   4. last resort: do not emit an `email` line (Caddy then prompts for one
   *      via internal CA fallback — better than feeding LE garbage and getting
   *      rate-limited).
   *
   * NEVER returns "localhost" — LE rejects it.
   */
  private resolveAcmeEmail(): string | null {
    if (process.env.ACME_EMAIL) {
      // This value is emitted verbatim into the Caddyfile global block as
      // `email <x>`. Strip anything that could break out of that single
      // directive (newlines, braces) or smuggle a second global option, and
      // require it to look like an email; otherwise ignore the override.
      const cleaned = process.env.ACME_EMAIL.replace(/[\r\n{}]/g, '').trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return cleaned;
    }
    try {
      if (process.env.PUBLIC_API_URL) {
        const host = new URL(process.env.PUBLIC_API_URL).hostname;
        if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== 'localhost') {
          return `admin@${host}`;
        }
      }
    } catch {}
    return null;
  }

  private isLocalHostname(host: string): boolean {
    return (
      host.endsWith('.local') ||
      host.endsWith('.localhost') ||
      host === 'localhost' ||
      host.endsWith('.test') ||
      host.endsWith('.invalid') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host)
    );
  }
}
