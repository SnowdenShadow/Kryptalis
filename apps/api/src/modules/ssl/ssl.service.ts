import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as net from 'net';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { DomainsService } from '../domains/domains.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';

/**
 * Expiry-warning window. The source of truth is Domain.sslExpiresAt /
 * Domain.sslStatus, which the reverse-proxy (Caddy) reconciles — NOT the
 * ssl_certificates table, which nothing in the codebase ever populates. So
 * a domain ≤14 days from expiry genuinely needs operator attention, and 14
 * days is the classic "renew now" lead time. If Caddy auto-renew ever lands,
 * drop this to 7 (renewal happens ~30 days out; <7 days left would then mean
 * renewal is failing).
 */
const SSL_EXPIRY_WARN_DAYS = 14;
/** Daily cadence; first check 5 min after boot so startup isn't blocked. */
const SSL_EXPIRY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SSL_EXPIRY_FIRST_CHECK_MS = 5 * 60 * 1000;

/**
 * SSL operations are project-scoped: only members of the project that owns
 * the domain can issue/renew/list certs for it. Orphan domains (no project)
 * are only touchable by platform admins — handled in the controller.
 *
 * Previously this service threw `new Error(...)` which NestJS surfaces as
 * 500 with no useful body. We now throw `NotFoundException` so the
 * dashboard sees a clean 404 with the original message.
 */
@Injectable()
export class SslService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SslService.name);
  private expirySweepInterval: ReturnType<typeof setInterval> | null = null;
  private expiryFirstCheck: ReturnType<typeof setTimeout> | null = null;

  /**
   * In-memory dedupe ledger for the expiry sweep, keyed by domainId. The
   * value is the expiry timestamp (ms) we last notified for. Domain has no
   * persisted `sslExpiryNotifiedAt` column (and we deliberately avoid a
   * migration here), so dedupe lives in-process: re-notify only when the
   * expiry moved forward (cert renewed) or the API restarted. Worst case
   * after a restart is one duplicate warning per still-expiring domain —
   * acceptable for a daily best-effort watchdog.
   */
  private readonly notifiedExpiry = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    // Injected from the @Global NotificationsModule (same as monitoring/backups).
    private notifications: NotificationsService,
    // @Global ReverseProxyModule — Caddy is the actual cert issuer.
    private proxy: ReverseProxyService,
    // For the DNS-health portion of the SSL diagnostics.
    private domains: DomainsService,
  ) {}

  onModuleInit() {
    // Same convention as MonitoringService: no live timers in test runs.
    if (process.env.NODE_ENV === 'test') return;
    this.expiryFirstCheck = setTimeout(
      () => void this.sweepExpiringCertificates().catch((e) =>
        this.logger.error(`SSL expiry sweep crashed: ${(e as Error).message}`),
      ),
      SSL_EXPIRY_FIRST_CHECK_MS,
    );
    this.expiryFirstCheck.unref?.();
    this.expirySweepInterval = setInterval(
      () => void this.sweepExpiringCertificates().catch((e) =>
        this.logger.error(`SSL expiry sweep crashed: ${(e as Error).message}`),
      ),
      SSL_EXPIRY_SWEEP_INTERVAL_MS,
    );
    this.expirySweepInterval.unref?.();
  }

  onModuleDestroy() {
    if (this.expiryFirstCheck) {
      clearTimeout(this.expiryFirstCheck);
      this.expiryFirstCheck = null;
    }
    if (this.expirySweepInterval) {
      clearInterval(this.expirySweepInterval);
      this.expirySweepInterval = null;
    }
  }

  /**
   * Daily expiry watchdog. Reads the REAL source of truth — Domain.sslExpiresAt
   * / Domain.sslStatus, which the reverse-proxy (Caddy) reconciles — and warns
   * admins (pref `sslExpire`) about any domain whose cert expires within
   * SSL_EXPIRY_WARN_DAYS. The old implementation queried the ssl_certificates
   * table, which NOTHING in the codebase ever writes, so the watchdog was inert.
   *
   * Caveat: syncSslStatuses() in reverse-proxy can fabricate sslExpiresAt as
   * now+90d rather than parsing the cert's real notAfter, so the value here is
   * best-effort/approximate — we key the warning off it regardless. Parsing the
   * true notAfter would require reading the Caddy cert files; see deferred.
   *
   * Dedupe is in-memory (see notifiedExpiry) since Domain has no persisted
   * notified-at column and we avoid a migration: a domain is re-notified only
   * if its expiry moved forward (renewal) or the API restarted.
   */
  async sweepExpiringCertificates(): Promise<{ notified: number }> {
    const now = Date.now();
    const horizon = new Date(now + SSL_EXPIRY_WARN_DAYS * 24 * 60 * 60 * 1000);
    const domains = await this.prisma.domain.findMany({
      where: {
        sslExpiresAt: { not: null, lte: horizon },
        // Don't nag about domains that never had SSL provisioned.
        sslStatus: { in: ['ACTIVE', 'EXPIRED'] },
      },
      select: { id: true, domain: true, sslExpiresAt: true },
    });

    let notified = 0;
    for (const d of domains) {
      const expiresAt = d.sslExpiresAt;
      if (!expiresAt) continue; // narrowing; the where-clause already excludes null
      // Already warned for THIS expiry value? (Renewal pushes it forward and
      // re-arms; a stale-or-equal stamp means we've handled this window.)
      const last = this.notifiedExpiry.get(d.id);
      if (last !== undefined && last >= expiresAt.getTime()) {
        continue;
      }
      const daysLeft = Math.ceil(
        (expiresAt.getTime() - now) / (24 * 60 * 60 * 1000),
      );
      // Stamp BEFORE dispatch so a notification-path crash can't cause a
      // re-notify loop on every daily tick.
      this.notifiedExpiry.set(d.id, expiresAt.getTime());
      this.logger.warn(
        `SSL certificate for ${d.domain} expires in ${daysLeft} day(s) (${expiresAt.toISOString()}).`,
      );
      // Fire-and-forget — sendSslExpiry never throws.
      await this.notifications.sendSslExpiry({
        domain: d.domain,
        expiresAt,
        daysLeft,
      });
      notified++;
    }
    return { notified };
  }

  /**
   * Issue (or re-issue) a certificate for a domain.
   *
   * Certificates are issued by the managed reverse proxy (Caddy) running on
   * the platform host — it terminates TLS for every domain, including apps
   * deployed on remote agent servers (Caddy proxies to them). So "issue SSL"
   * means: make sure the domain has a Caddyfile block and let Caddy run the
   * ACME flow, then let the periodic syncSslStatuses() reconcile
   * Domain.sslStatus once the cert lands.
   *
   * Historical note: this used to enqueue an SSL_ISSUE AgentTask when the
   * domain's app lived on a remote server. The Go agent never implemented it
   * (it answered `not_implemented` … with status COMPLETED, so the task
   * silently "succeeded" while no cert was issued anywhere). Remote servers
   * have no managed reverse proxy to install a cert into — issuance has
   * always happened on the platform host's Caddy. The dead enqueue is gone;
   * the agent now rejects SSL_ISSUE/SSL_RENEW with an explicit FAILED.
   */
  async issue(userId: string, domainId: string) {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');

    // Orphan domains (no project) are touchable only by platform admins.
    // Previously the service silently let any JWT bearer through, which
    // let them queue SSL_ISSUE tasks against arbitrary domains.
    if (!domain.projectId) {
      await this.assertPlatformAdmin(userId);
    } else {
      await assertProjectAccess(this.prisma, userId, domain.projectId, 'DEVELOPER');
    }

    // *.local & friends are served plain-HTTP by Caddy (no ACME possible).
    if (this.isLocalOnlyDomain(domain.domain)) {
      throw new BadRequestException(
        `'${domain.domain}' is a local hostname — Let's Encrypt cannot issue certificates for it.`,
      );
    }

    await this.prisma.domain.update({
      where: { id: domainId },
      data: { sslStatus: 'PENDING' },
    });

    // Rebuild the Caddyfile and reload Caddy: ensures the domain has a block
    // (ACME kicks off immediately) and, for renewals, forces a config-load
    // pass where Caddy re-checks cert lifetimes. regenerate() also schedules
    // delayed syncSslStatuses() passes that flip sslStatus → ACTIVE once the
    // cert is on disk.
    //
    // Debounced (scheduleReload, 1.5 s) instead of an inline regenerate():
    // a burst of issue() calls (bulk re-issue from the dashboard) used to
    // fire one full Caddyfile rewrite + `docker exec caddy reload` (or
    // restart fallback) EACH — now they collapse into a single reload.
    // ACME is async anyway and the periodic syncSslStatuses() reconciles
    // sslStatus afterwards, so nothing needs the reload to be synchronous.
    this.proxy.scheduleReload();

    return { message: 'SSL issuance triggered — certificate is provisioned by the managed reverse proxy' };
  }

  /**
   * Load a domain + enforce the same RBAC `issue()` uses (DEVELOPER on the
   * project, or platform ADMIN for an orphan domain). Returns the domain row.
   */
  private async assertDomainSslAccess(userId: string, domainId: string) {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');
    if (!domain.projectId) await this.assertPlatformAdmin(userId);
    else await assertProjectAccess(this.prisma, userId, domain.projectId, 'DEVELOPER');
    return domain;
  }

  /**
   * Explain WHY a domain's certificate is (or isn't) issued. Aggregates the
   * existing DNS health check, whether Caddy holds the cert, whether ports
   * 80/443 are reachable, and the local-hostname case. Read-only.
   */
  async diagnose(userId: string, domainId: string) {
    const domain = await this.assertDomainSslAccess(userId, domainId);
    const host = domain.domain;
    const checks: { key: string; status: 'OK' | 'WARN' | 'FAIL'; message: string }[] = [];

    // Local hostname → ACME impossible, short-circuit.
    if (this.isLocalOnlyDomain(host)) {
      checks.push({ key: 'local', status: 'FAIL', message: `'${host}' is a local hostname — Let's Encrypt cannot issue a certificate. Use a real public domain.` });
      return { domain: host, sslStatus: domain.sslStatus, checkedAt: new Date().toISOString(), checks };
    }

    // 1) DNS — reuse the domains health check's A-record verdict.
    try {
      const health: any = await this.domains.getDnsHealth(userId, domainId);
      const a = health?.checks?.a;
      if (a) checks.push({ key: 'dns', status: a.status === 'OK' ? 'OK' : a.status === 'WARN' ? 'WARN' : 'FAIL', message: a.message });
    } catch (e: any) {
      checks.push({ key: 'dns', status: 'WARN', message: `Could not run the DNS check: ${e?.message || e}` });
    }

    // 2) Ports 80/443 reachable on the public IP (HTTP-01 needs 80; TLS needs 443).
    const expectedIp = this.resolveServerIp();
    if (expectedIp) {
      for (const port of [80, 443]) {
        const open = await this.isPortOpen(expectedIp, port);
        checks.push(open
          ? { key: `port${port}`, status: 'OK', message: `Port ${port} reachable on ${expectedIp}.` }
          : { key: `port${port}`, status: 'FAIL', message: `Port ${port} not reachable on ${expectedIp} — open it in your firewall/security group (Let's Encrypt needs ${port === 80 ? 'HTTP-01 on 80' : 'HTTPS on 443'}).` });
      }
    } else {
      checks.push({ key: 'ports', status: 'WARN', message: 'Server public IP not configured (PUBLIC_API_URL) — cannot test ports 80/443.' });
    }

    // 3) Cert on disk?
    const hasCert = await this.proxy.certExists(host);
    checks.push(hasCert
      ? { key: 'cert', status: 'OK', message: 'Caddy holds a certificate for this domain.' }
      : { key: 'cert', status: domain.sslStatus === 'ACTIVE' ? 'WARN' : 'FAIL', message: 'No certificate on disk yet. After DNS + ports are green, click “Re-issue certificate” and wait ~10-60s.' });

    return { domain: host, sslStatus: domain.sslStatus, checkedAt: new Date().toISOString(), checks };
  }

  /** Recent Caddy/ACME log lines for a domain (the real issuance error). */
  async getLogs(userId: string, domainId: string, lines = 200) {
    const domain = await this.assertDomainSslAccess(userId, domainId);
    const logLines = await this.proxy.getAcmeLogsForDomain(domain.domain, lines);
    return { domain: domain.domain, lines: logLines };
  }

  /** The server's public IPv4 from PUBLIC_API_URL, or null. */
  private resolveServerIp(): string | null {
    const m = (process.env.PUBLIC_API_URL || '').match(/^https?:\/\/([^:/]+)/);
    return m && /^\d+\.\d+\.\d+\.\d+$/.test(m[1]) ? m[1] : null;
  }

  /** Best-effort TCP connect to host:port with a short timeout. */
  private isPortOpen(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let settled = false;
      const done = (ok: boolean) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
      sock.setTimeout(3000);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
      sock.connect(port, host);
    });
  }

  /** Hostnames Caddy serves without TLS — mirrors reverse-proxy.service's
   *  private isLocalHostname() heuristic exactly (plus the LOCAL_HOSTS set). */
  private isLocalOnlyDomain(host: string): boolean {
    const h = host.toLowerCase();
    return (
      h === 'localhost' ||
      h.endsWith('.local') ||
      h.endsWith('.localhost') ||
      h.endsWith('.test') ||
      h.endsWith('.invalid') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(h) ||
      isLocalHost(h)
    );
  }

  async renew(userId: string, certificateId: string) {
    const cert = await this.prisma.sSLCertificate.findUnique({
      where: { id: certificateId },
      include: { domain: true },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return this.issue(userId, cert.domainId);
  }

  async getCertificates(userId: string, domainId?: string) {
    if (domainId) {
      const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
      if (!domain) throw new NotFoundException('Domain not found');
      if (!domain.projectId) {
        await this.assertPlatformAdmin(userId);
      } else {
        await assertProjectAccess(this.prisma, userId, domain.projectId, 'VIEWER');
      }
      return this.prisma.sSLCertificate.findMany({
        where: { domainId },
        include: { domain: { select: { id: true, domain: true } } },
      });
    }
    // No domainId → scope to certs whose domain belongs to a project the
    // caller can access.
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    return this.prisma.sSLCertificate.findMany({
      where: { domain: { projectId: { in: projectIds } } },
      include: { domain: { select: { id: true, domain: true } } },
    });
  }

  private async assertPlatformAdmin(userId: string) {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (me?.role !== 'ADMIN' && me?.role !== 'SUPERADMIN') {
      throw new ForbiddenException('Orphan-domain SSL operations require platform ADMIN.');
    }
  }
}
