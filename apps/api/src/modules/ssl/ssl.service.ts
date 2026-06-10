import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';

/**
 * Expiry-warning window. Rows in ssl_certificates are NOT auto-renewed by
 * the platform: Caddy's auto-renew path only reconciles Domain.sslStatus /
 * sslExpiresAt (reverse-proxy.service) — nothing in the codebase refreshes
 * SSLCertificate.expiresAt. So a cert ≤14 days from expiry genuinely needs
 * operator action, and 14 days is the classic "renew now" lead time.
 * If these rows ever become Caddy-managed, drop this to 7 (renewal happens
 * ~30 days out; <7 days left would then mean renewal is failing).
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

  constructor(
    private prisma: PrismaService,
    // Injected from the @Global NotificationsModule (same as monitoring/backups).
    private notifications: NotificationsService,
    // @Global ReverseProxyModule — Caddy is the actual cert issuer.
    private proxy: ReverseProxyService,
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
   * Daily expiry watchdog: find certs expiring within SSL_EXPIRY_WARN_DAYS
   * that haven't been notified for the CURRENT window, notify admins (pref
   * `sslExpire`) and stamp `expiryNotifiedAt`.
   *
   * Dedupe: a cert is "already notified" only when expiryNotifiedAt falls
   * inside the current warning window (>= expiresAt − warnDays). If the
   * cert is renewed (expiresAt jumps forward), the old stamp lands before
   * the new window start and the alert re-arms automatically — no clearing
   * needed on renewal.
   */
  async sweepExpiringCertificates(): Promise<{ notified: number }> {
    const now = Date.now();
    const horizon = new Date(now + SSL_EXPIRY_WARN_DAYS * 24 * 60 * 60 * 1000);
    const certs = await this.prisma.sSLCertificate.findMany({
      where: { expiresAt: { lte: horizon } },
      include: { domain: { select: { domain: true } } },
    });

    let notified = 0;
    for (const cert of certs) {
      const windowStart = new Date(
        cert.expiresAt.getTime() - SSL_EXPIRY_WARN_DAYS * 24 * 60 * 60 * 1000,
      );
      if (cert.expiryNotifiedAt && cert.expiryNotifiedAt >= windowStart) {
        continue; // already notified for this expiry window
      }
      const daysLeft = Math.ceil(
        (cert.expiresAt.getTime() - now) / (24 * 60 * 60 * 1000),
      );
      // Stamp BEFORE dispatch so a notification path crash can't cause a
      // re-notify loop on every daily tick.
      await this.prisma.sSLCertificate.update({
        where: { id: cert.id },
        data: { expiryNotifiedAt: new Date() },
      });
      this.logger.warn(
        `SSL certificate for ${cert.domain.domain} expires in ${daysLeft} day(s) (${cert.expiresAt.toISOString()}).`,
      );
      // Fire-and-forget — sendSslExpiry never throws.
      await this.notifications.sendSslExpiry({
        domain: cert.domain.domain,
        expiresAt: cert.expiresAt,
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
    await this.proxy.regenerate();

    return { message: 'SSL issuance triggered — certificate is provisioned by the managed reverse proxy' };
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
