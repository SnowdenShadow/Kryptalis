import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlertRule } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemConfigService } from '../system/system-config.service';
import { renderEmail, escapeHtml } from './email-templates';

/**
 * Shape of User.notificationPrefs (Json column) — written by
 * UsersService.updateNotificationPrefs against the event/channel
 * whitelists (deployOk/deployFail/serverOff/sslExpire/backupOk/backupFail
 * × email/discord/slack/webhook).
 */
type NotificationPrefs = Record<string, Record<string, boolean>>;

type NotifEvent =
  | 'deployOk'
  | 'deployFail'
  | 'serverOff'
  | 'sslExpire'
  | 'backupOk'
  | 'backupFail';

/**
 * Centralised outbound notification dispatcher.
 *
 * Two transports:
 *   - SMTP via nodemailer (lazy-loaded so the dep is optional at runtime)
 *   - Webhook POST via Node 20's global fetch with a 5 s AbortController
 *
 * The service is registered @Global so flows like AuthService.forgotPassword
 * can inject it without creating a circular import between AuthModule and
 * MonitoringModule.
 *
 * If SMTP_HOST is unset, every email-shaped call is a logged no-op rather
 * than a thrown error — this keeps dev/test environments running while the
 * raw token is still surfaced in the logs (gated on NODE_ENV !== production)
 * so developers can copy-paste it during a password reset.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: any = null;
  private smtpFrom: string | null = null;
  private smtpReady = false;
  private unsubscribeConfig: (() => void) | null = null;

  /**
   * In-memory dedupe ledger for alert dispatch. `sendAlert` consults this
   * before firing — the polling loop in MonitoringService runs every 30 s
   * so without TTL-gating, a sustained CPU spike would generate dozens of
   * identical emails per hour. 15-min window matches the cool-down most
   * monitoring tools default to.
   */
  private readonly recentlyFiredAlerts = new Map<string, number>();
  private static readonly ALERT_TTL_MS = 15 * 60 * 1000;
  private cleanupTimer: NodeJS.Timeout | null = null;

  /**
   * 60s cache of active ADMIN/SUPERADMIN ids used by the in-app feed
   * fan-out. Global events (deploy/ssl/backup/alert) create one
   * Notification row per admin; re-querying the user table on every
   * deployment would be wasteful, and 60s staleness is fine — a freshly
   * promoted admin just misses at most one minute of feed entries.
   */
  private adminIdsCache: { ids: string[]; at: number } | null = null;
  private static readonly ADMIN_CACHE_TTL_MS = 60 * 1000;
  /** Feed retention — rows older than this are pruned at creation time. */
  private static readonly RETENTION_DAYS = 90;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
  ) {
    this.cleanupTimer = setInterval(
      () => this.sweepExpiredAlerts(),
      NotificationsService.ALERT_TTL_MS,
    );
    this.cleanupTimer.unref?.();
  }

  async onModuleInit() {
    this.initTransport();
    // Live-reload the SMTP transport whenever any smtp_* setting changes
    // in the Admin UI. No API restart needed — admin saves, transport
    // gets recreated, the next email goes via the new server.
    this.unsubscribeConfig = this.systemConfig.onChange((keys) => {
      if (keys.some((k) => k.startsWith('smtp_') || k === 'public_dashboard_url')) {
        this.logger.log('SMTP config changed — re-initialising transport');
        this.closeTransport();
        this.initTransport();
      }
    });
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.unsubscribeConfig) this.unsubscribeConfig();
    this.closeTransport();
  }

  private closeTransport() {
    if (this.transporter?.close) {
      try {
        this.transporter.close();
      } catch {}
    }
    this.transporter = null;
    this.smtpReady = false;
  }

  // ── transport bootstrap ───────────────────────────────────────────

  private initTransport() {
    // Resolution: DB (SystemSetting) wins → env fallback → no-op.
    const host = this.systemConfig.get<string>('smtp_host', 'SMTP_HOST');
    if (!host) {
      this.logger.warn(
        'SMTP not configured — email notifications will be no-ops. ' +
          'Set it up in Admin → System Config to enable outbound mail.',
      );
      return;
    }
    const port = this.systemConfig.getNumber('smtp_port', 'SMTP_PORT', 587) ?? 587;
    const user = this.systemConfig.get<string>('smtp_user', 'SMTP_USER');
    const pass = this.systemConfig.get<string>('smtp_pass', 'SMTP_PASS');
    this.smtpFrom =
      this.systemConfig.get<string>('smtp_from', 'SMTP_FROM') ?? user ?? 'no-reply@dockcontrol.local';

    try {
      // Lazy-require so missing optional dep doesn't crash the app at
      // import time (e.g. fresh clone before `pnpm install`).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodemailer = require('nodemailer');
      this.transporter = nodemailer.createTransport({
        host,
        port,
        // Port 465 is implicit TLS; everything else uses STARTTLS.
        secure: port === 465,
        auth: user && pass ? { user, pass } : undefined,
      });
      this.smtpReady = true;
      this.logger.log(`SMTP transport configured (${host}:${port}).`);
    } catch (err) {
      this.logger.error(
        `Failed to initialise SMTP transport: ${(err as Error).message}. ` +
          'Email notifications will be no-ops.',
      );
    }
  }

  // ── public API ────────────────────────────────────────────────────

  /**
   * Admin-triggered SMTP probe. Throws BadRequestException if SMTP isn't
   * configured so the UI can surface a precise error instead of a silent
   * no-op. Throws the underlying transport error verbatim so admins see
   * EAUTH / ECONNREFUSED / etc. directly.
   */
  async sendTestEmail(to: string, actorName: string): Promise<void> {
    if (!this.smtpReady) {
      throw new Error(
        'SMTP is not configured. Save the SMTP settings first, then try again.',
      );
    }
    const html = renderEmail({
      title: 'DockControl test email',
      preheader: 'If you can read this, SMTP works.',
      body: `
        <p style="margin:0 0 12px 0;">Hi ${escapeHtml(actorName)},</p>
        <p style="margin:0;">
          This is a test email triggered from Admin → System Config. If you
          received it, your SMTP transport is healthy.
        </p>`,
    });
    await this.sendMail({ to, subject: 'DockControl SMTP test', html });
  }

  async sendPasswordReset(email: string, token: string, userName: string): Promise<void> {
    // Dashboard page lives in the (auth) route group → public URL has no
    // /auth segment.
    const url = this.buildDashboardUrl(`/reset-password?token=${encodeURIComponent(token)}`);

    // Dev-mode token surfacing — replaces the old console.warn in
    // AuthService. Gated on NODE_ENV so production logs never leak the
    // raw reset token. This still runs even when SMTP is unconfigured
    // so a developer running locally can complete the flow.
    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn(
        `[dev] password reset token for ${email}: ${token} ` +
          `(URL: ${url}) — gated to NODE_ENV !== production`,
      );
    }

    if (!this.smtpReady) {
      this.logger.warn(`Skipping password-reset email to ${email} — SMTP not configured.`);
      return;
    }

    const html = renderEmail({
      title: 'Reset your password',
      preheader: 'Use the button below to choose a new password.',
      body: `
        <p style="margin:0 0 12px 0;">Hi ${escapeHtml(userName)},</p>
        <p style="margin:0 0 12px 0;">
          We received a request to reset the password for your DockControl
          account. Click the button below to choose a new one. This link
          expires in 1 hour and can only be used once.
        </p>
        <p style="margin:0;">If you didn't request a reset, no action is needed.</p>`,
      ctaLabel: 'Reset password',
      ctaUrl: url,
    });
    await this.sendMail({
      to: email,
      subject: 'Reset your DockControl password',
      html,
    });
  }

  async sendEmailVerification(email: string, token: string, userName: string): Promise<void> {
    // (auth) route group → the page is served at /verify-email.
    const url = this.buildDashboardUrl(
      `/verify-email?token=${encodeURIComponent(token)}`,
    );
    if (!this.smtpReady) {
      this.logger.warn(`Skipping verification email to ${email} — SMTP not configured.`);
      return;
    }
    const html = renderEmail({
      title: 'Verify your email',
      preheader: 'Confirm your address to finish signing up.',
      body: `
        <p style="margin:0 0 12px 0;">Hi ${escapeHtml(userName)},</p>
        <p style="margin:0;">
          Please confirm your email address by clicking the button below.
          This helps keep your DockControl account secure.
        </p>`,
      ctaLabel: 'Verify email',
      ctaUrl: url,
    });
    await this.sendMail({
      to: email,
      subject: 'Verify your DockControl email',
      html,
    });
  }

  // Project invitations are transactional (the recipient may not even have
  // an account yet) — intentionally NOT gated on notificationPrefs.
  async sendUserInvited(
    email: string,
    projectName: string,
    inviterName: string,
    token: string,
  ): Promise<void> {
    const url = this.buildDashboardUrl(`/invite/accept?token=${encodeURIComponent(token)}`);
    if (!this.smtpReady) {
      this.logger.warn(`Skipping invite email to ${email} — SMTP not configured.`);
      return;
    }
    const html = renderEmail({
      title: `You've been invited to ${projectName}`,
      preheader: `${inviterName} invited you to collaborate on DockControl.`,
      body: `
        <p style="margin:0 0 12px 0;">Hi,</p>
        <p style="margin:0 0 12px 0;">
          <strong>${escapeHtml(inviterName)}</strong> invited you to join the
          <strong>${escapeHtml(projectName)}</strong> project on DockControl.
        </p>
        <p style="margin:0;">Accept the invitation to get started.</p>`,
      ctaLabel: 'Accept invitation',
      ctaUrl: url,
    });
    await this.sendMail({
      to: email,
      subject: `${inviterName} invited you to ${projectName} on DockControl`,
      html,
    });
  }

  // Sent when an existing user is added straight to a project (membership
  // created directly — no acceptance token). Unlike sendUserInvited this
  // links to the project page itself, never the dead /invite/accept flow.
  async sendUserAddedToProject(
    email: string,
    projectName: string,
    inviterName: string,
    projectId: string,
  ): Promise<void> {
    const url = this.buildDashboardUrl(`/dashboard/projects/${encodeURIComponent(projectId)}`);
    if (!this.smtpReady) {
      this.logger.warn(`Skipping project-added email to ${email} — SMTP not configured.`);
      return;
    }
    const html = renderEmail({
      title: `You've been added to ${projectName}`,
      preheader: `${inviterName} added you to a project on DockControl.`,
      body: `
        <p style="margin:0 0 12px 0;">Hi,</p>
        <p style="margin:0 0 12px 0;">
          <strong>${escapeHtml(inviterName)}</strong> added you to the
          <strong>${escapeHtml(projectName)}</strong> project on DockControl.
        </p>
        <p style="margin:0;">You already have access — open the project to get started.</p>`,
      ctaLabel: 'Open project',
      ctaUrl: url,
    });
    await this.sendMail({
      to: email,
      subject: `You've been added to ${projectName} on DockControl`,
      html,
    });
  }

  async sendDeploymentResult(
    userId: string,
    appName: string,
    status: 'success' | 'failed',
    error?: string,
  ): Promise<void> {
    // We don't have the user's email cached here — resolve at call time
    // so a changed-email user still gets the latest address. The userId
    // path keeps callers from having to look it up themselves.
    let email: string | null = null;
    let name = 'there';
    let prefs: unknown = null;
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true, notificationPrefs: true },
      });
      email = u?.email ?? null;
      name = u?.name ?? 'there';
      prefs = u?.notificationPrefs ?? null;
    } catch (err) {
      this.logger.error(
        `sendDeploymentResult: failed to resolve user ${userId}: ${(err as Error).message}`,
      );
      return;
    }
    const ok = status === 'success';
    const title = ok ? `Deployment succeeded: ${appName}` : `Deployment failed: ${appName}`;
    const url = this.buildDashboardUrl('/dashboard/applications');

    // In-app feed: deploy outcomes are "global" events — fan out to all
    // active admins plus the user who triggered the deploy. Persisted
    // BEFORE the SMTP guard so the feed works without mail configured.
    await this.notifyAdmins(
      {
        type: ok ? 'deploy.success' : 'deploy.failed',
        title,
        body: ok ? undefined : error,
        link: '/dashboard/applications',
      },
      [userId],
    );

    if (!email) {
      this.logger.warn(`sendDeploymentResult: no email on user ${userId}; skipping.`);
      return;
    }
    // Honour the user's notification toggles (deployOk / deployFail).
    if (!this.allows(prefs, ok ? 'deployOk' : 'deployFail', 'email')) {
      this.logger.debug(
        `sendDeploymentResult: user ${userId} opted out of ${ok ? 'deployOk' : 'deployFail'} email; skipping.`,
      );
      return;
    }
    if (!this.smtpReady) {
      this.logger.warn(`Skipping deployment email to ${email} — SMTP not configured.`);
      return;
    }

    const errorBlock = !ok && error
      ? `<p style="margin:12px 0 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;
                  font-size:13px;background:#f5f5fa;border:1px solid #e5e5ec;
                  border-radius:8px;padding:10px 12px;white-space:pre-wrap;
                  word-break:break-word;">${escapeHtml(error)}</p>`
      : '';
    const html = renderEmail({
      title,
      preheader: ok ? `${appName} is live.` : `${appName} did not deploy.`,
      body: `
        <p style="margin:0 0 12px 0;">Hi ${escapeHtml(name)},</p>
        <p style="margin:0;">
          ${
            ok
              ? `Your application <strong>${escapeHtml(appName)}</strong> deployed successfully.`
              : `Your application <strong>${escapeHtml(appName)}</strong> failed to deploy.`
          }
        </p>
        ${errorBlock}`,
      ctaLabel: 'Open dashboard',
      ctaUrl: url,
    });
    await this.sendMail({ to: email, subject: title, html });
  }

  /**
   * Dispatch a monitoring alert. Routes by `rule.channel`:
   *   - EMAIL → looks up admins of the server's project / owner and emails
   *     them. (For now we email the rule's server owners; richer routing
   *     belongs in a follow-up.)
   *   - WEBHOOK/DISCORD/SLACK → POSTs JSON payload to rule.webhookUrl.
   *
   * Dedupes by ruleId for 15 minutes so a sustained breach doesn't spam.
   */
  async sendAlert(rule: AlertRule, value: number): Promise<void> {
    if (this.wasRecentlyFired(rule.id)) {
      return;
    }
    this.markFired(rule.id);

    const payload = {
      ruleId: rule.id,
      ruleName: rule.name,
      value,
      threshold: rule.threshold,
      server: rule.serverId,
      ts: new Date().toISOString(),
    };

    // In-app feed for every active admin, whatever the outbound channel.
    // Shares the 15-min dedupe window above so a sustained breach doesn't
    // flood the bell either.
    await this.notifyAdmins({
      type: 'alert.fired',
      title: `Alert: ${rule.name}`,
      body: `${rule.metric} = ${value} (threshold ${rule.threshold}) on server ${rule.serverId}`,
      link: '/dashboard/monitoring',
    });

    const channel = String(rule.channel);
    if (channel === 'WEBHOOK' || channel === 'DISCORD' || channel === 'SLACK') {
      if (!rule.webhookUrl) {
        this.logger.warn(
          `Alert rule ${rule.id} channel=${channel} but no webhookUrl set — skipping.`,
        );
        return;
      }
      await this.postWebhook(rule.webhookUrl, payload);
      return;
    }

    // EMAIL channel. Resolve recipients = the server's owners. We
    // don't have a direct alert-recipient relation yet, so we email
    // every ADMIN/SUPERADMIN and any project member tied to the server.
    if (!this.smtpReady) {
      this.logger.warn(
        `Alert "${rule.name}" fired (value=${value}, threshold=${rule.threshold}) ` +
          `but SMTP is not configured — skipping email.`,
      );
      return;
    }

    // notificationPrefs mapping note: alert rules only cover cpu/memory/disk
    // threshold breaches today — none of the whitelist events (serverOff,
    // sslExpire, …) corresponds, so these emails are deliberately NOT
    // pref-filtered. If an "offline" metric/alert appears later, gate it on
    // this.allows(prefs, 'serverOff', 'email') here.
    let recipients: string[] = [];
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'SUPERADMIN'] }, status: 'ACTIVE' },
        select: { email: true },
      });
      recipients = admins.map((a: { email: string }) => a.email).filter(Boolean);
    } catch (err) {
      this.logger.error(
        `sendAlert: failed to resolve recipients for rule ${rule.id}: ${(err as Error).message}`,
      );
      return;
    }
    if (recipients.length === 0) {
      this.logger.warn(`Alert ${rule.id} fired but no recipients resolved.`);
      return;
    }

    const html = renderEmail({
      title: `Alert: ${rule.name}`,
      preheader: `${rule.metric} crossed ${rule.threshold}.`,
      body: `
        <p style="margin:0 0 12px 0;">
          Monitoring rule <strong>${escapeHtml(rule.name)}</strong> tripped.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"
               style="border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:2px 12px 2px 0;color:#6b6b78;">Metric</td>
              <td>${escapeHtml(rule.metric)}</td></tr>
          <tr><td style="padding:2px 12px 2px 0;color:#6b6b78;">Value</td>
              <td>${escapeHtml(String(value))}</td></tr>
          <tr><td style="padding:2px 12px 2px 0;color:#6b6b78;">Threshold</td>
              <td>${escapeHtml(String(rule.threshold))}</td></tr>
          <tr><td style="padding:2px 12px 2px 0;color:#6b6b78;">Server</td>
              <td>${escapeHtml(rule.serverId)}</td></tr>
        </table>`,
      ctaLabel: 'Open monitoring',
      ctaUrl: this.buildDashboardUrl('/dashboard/monitoring'),
    });

    await this.sendMail({
      to: recipients.join(', '),
      subject: `[DockControl] Alert: ${rule.name}`,
      html,
    });
  }

  /**
   * Backup job outcome — called fire-and-forget from the backups job
   * runner. Mirrors sendDeploymentResult: in-app feed entry for every
   * active admin (always — the feed is not a prefs channel), then one
   * email per admin honouring their backupOk / backupFail toggles.
   * Never throws: any failure is caught and logged here.
   */
  async sendBackupResult(input: {
    backupId: string;
    name: string;
    serverId: string;
    status: 'COMPLETED' | 'FAILED';
    error?: string;
  }): Promise<void> {
    try {
      const ok = input.status === 'COMPLETED';
      const event: NotifEvent = ok ? 'backupOk' : 'backupFail';
      const title = ok
        ? `Backup completed: ${input.name}`
        : `Backup failed: ${input.name}`;

      await this.notifyAdmins({
        type: ok ? 'backup.completed' : 'backup.failed',
        title,
        body: ok
          ? `Backup ${input.backupId} on server ${input.serverId} completed.`
          : input.error ?? `Backup ${input.backupId} on server ${input.serverId} failed.`,
        link: '/dashboard/backups',
      });

      if (!this.smtpReady) {
        this.logger.warn(`Skipping backup email for ${input.backupId} — SMTP not configured.`);
        return;
      }

      let admins: Array<{ email: string; notificationPrefs: unknown }> = [];
      try {
        admins = await this.prisma.user.findMany({
          where: { role: { in: ['ADMIN', 'SUPERADMIN'] }, status: 'ACTIVE' },
          select: { email: true, notificationPrefs: true },
        });
      } catch (err) {
        this.logger.error(
          `sendBackupResult: failed to resolve recipients for backup ${input.backupId}: ${(err as Error).message}`,
        );
        return;
      }
      const recipients = admins
        .filter((a) => a.email && this.allows(a.notificationPrefs, event, 'email'))
        .map((a) => a.email);
      if (recipients.length === 0) {
        this.logger.debug(
          `sendBackupResult: no opted-in recipients for backup ${input.backupId}.`,
        );
        return;
      }

      const errorBlock = !ok && input.error
        ? `<p style="margin:12px 0 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;
                    font-size:13px;background:#f5f5fa;border:1px solid #e5e5ec;
                    border-radius:8px;padding:10px 12px;white-space:pre-wrap;
                    word-break:break-word;">${escapeHtml(input.error)}</p>`
        : '';
      const html = renderEmail({
        title,
        preheader: ok
          ? `Backup "${input.name}" finished successfully.`
          : `Backup "${input.name}" failed.`,
        body: `
          <p style="margin:0 0 12px 0;">
            Backup <strong>${escapeHtml(input.name)}</strong> on server
            <strong>${escapeHtml(input.serverId)}</strong>
            ${ok ? 'completed successfully.' : 'failed.'}
          </p>
          ${errorBlock}`,
        ctaLabel: 'Open backups',
        ctaUrl: this.buildDashboardUrl('/dashboard/backups'),
      });

      await this.sendMail({
        to: recipients.join(', '),
        subject: `[DockControl] ${title}`,
        html,
      });
    } catch (err) {
      // Fire-and-forget contract — never let a notification failure
      // bubble into the backup job.
      this.logger.error(`sendBackupResult failed: ${(err as Error).message}`);
    }
  }

  /**
   * Server went offline (heartbeat stopped) — called fire-and-forget from
   * the ServersService offline sweep, only on the ONLINE→OFFLINE
   * transition (the status flip is the dedupe). Mirrors sendBackupResult:
   * in-app feed entry for every active admin, then one email per admin
   * honouring their `serverOff` toggle. Never throws.
   */
  async sendServerOffline(input: {
    serverId: string;
    name: string;
    host: string;
    lastSeenAt: Date | null;
  }): Promise<void> {
    try {
      const title = `Server offline: ${input.name}`;
      const lastSeen = input.lastSeenAt
        ? input.lastSeenAt.toISOString()
        : 'never';

      await this.notifyAdmins({
        type: 'server.offline',
        title,
        body: `Server ${input.name} (${input.host}) stopped sending heartbeats. Last seen: ${lastSeen}.`,
        link: '/dashboard/servers',
      });

      if (!this.smtpReady) {
        this.logger.warn(
          `Skipping server-offline email for ${input.serverId} — SMTP not configured.`,
        );
        return;
      }

      let admins: Array<{ email: string; notificationPrefs: unknown }> = [];
      try {
        admins = await this.prisma.user.findMany({
          where: { role: { in: ['ADMIN', 'SUPERADMIN'] }, status: 'ACTIVE' },
          select: { email: true, notificationPrefs: true },
        });
      } catch (err) {
        this.logger.error(
          `sendServerOffline: failed to resolve recipients for server ${input.serverId}: ${(err as Error).message}`,
        );
        return;
      }
      const recipients = admins
        .filter((a) => a.email && this.allows(a.notificationPrefs, 'serverOff', 'email'))
        .map((a) => a.email);
      if (recipients.length === 0) {
        this.logger.debug(
          `sendServerOffline: no opted-in recipients for server ${input.serverId}.`,
        );
        return;
      }

      const html = renderEmail({
        title,
        preheader: `${input.name} stopped sending heartbeats.`,
        body: `
          <p style="margin:0 0 12px 0;">
            Server <strong>${escapeHtml(input.name)}</strong>
            (<strong>${escapeHtml(input.host)}</strong>) has stopped sending
            heartbeats and was marked <strong>OFFLINE</strong>.
          </p>
          <p style="margin:0;">
            Last seen: ${escapeHtml(lastSeen)}. Check the agent process and
            network connectivity on the machine.
          </p>`,
        ctaLabel: 'Open servers',
        ctaUrl: this.buildDashboardUrl('/dashboard/servers'),
      });

      await this.sendMail({
        to: recipients.join(', '),
        subject: `[DockControl] ${title}`,
        html,
      });
    } catch (err) {
      // Fire-and-forget contract — never let a notification failure
      // bubble into the offline sweep.
      this.logger.error(`sendServerOffline failed: ${(err as Error).message}`);
    }
  }

  /**
   * SSL certificate approaching expiry — called fire-and-forget from the
   * SslService daily expiry sweep (dedupe lives there via
   * SSLCertificate.expiryNotifiedAt). In-app feed entry for every active
   * admin, then one email per admin honouring their `sslExpire` toggle.
   * Never throws.
   */
  async sendSslExpiry(input: {
    domain: string;
    expiresAt: Date;
    daysLeft: number;
  }): Promise<void> {
    try {
      const title =
        input.daysLeft > 0
          ? `SSL certificate expiring: ${input.domain}`
          : `SSL certificate expired: ${input.domain}`;
      const when = input.expiresAt.toISOString().slice(0, 10);
      const summary =
        input.daysLeft > 0
          ? `Certificate for ${input.domain} expires in ${input.daysLeft} day(s) (${when}).`
          : `Certificate for ${input.domain} expired on ${when}.`;

      await this.notifyAdmins({
        type: 'ssl.expiring',
        title,
        body: summary,
        link: '/dashboard/domains',
      });

      if (!this.smtpReady) {
        this.logger.warn(
          `Skipping SSL-expiry email for ${input.domain} — SMTP not configured.`,
        );
        return;
      }

      let admins: Array<{ email: string; notificationPrefs: unknown }> = [];
      try {
        admins = await this.prisma.user.findMany({
          where: { role: { in: ['ADMIN', 'SUPERADMIN'] }, status: 'ACTIVE' },
          select: { email: true, notificationPrefs: true },
        });
      } catch (err) {
        this.logger.error(
          `sendSslExpiry: failed to resolve recipients for ${input.domain}: ${(err as Error).message}`,
        );
        return;
      }
      const recipients = admins
        .filter((a) => a.email && this.allows(a.notificationPrefs, 'sslExpire', 'email'))
        .map((a) => a.email);
      if (recipients.length === 0) {
        this.logger.debug(
          `sendSslExpiry: no opted-in recipients for ${input.domain}.`,
        );
        return;
      }

      const html = renderEmail({
        title,
        preheader: summary,
        body: `
          <p style="margin:0 0 12px 0;">
            The SSL certificate for <strong>${escapeHtml(input.domain)}</strong>
            ${
              input.daysLeft > 0
                ? `expires in <strong>${input.daysLeft} day(s)</strong> (${escapeHtml(when)}).`
                : `expired on <strong>${escapeHtml(when)}</strong>.`
            }
          </p>
          <p style="margin:0;">
            Certificates tracked here are not auto-renewed by the platform —
            renew it from the Domains page (or re-issue via your CA) before
            visitors start seeing browser warnings.
          </p>`,
        ctaLabel: 'Open domains',
        ctaUrl: this.buildDashboardUrl('/dashboard/domains'),
      });

      await this.sendMail({
        to: recipients.join(', '),
        subject: `[DockControl] ${title}`,
        html,
      });
    } catch (err) {
      this.logger.error(`sendSslExpiry failed: ${(err as Error).message}`);
    }
  }

  // ── in-app notification feed ──────────────────────────────────────

  /**
   * Persist one feed entry per active ADMIN/SUPERADMIN. Used for the
   * "global" events (deploy outcome, SSL, backup, monitoring alert).
   * Best-effort: a DB hiccup must never break the calling flow, mirroring
   * the sendMail contract. `extraUserIds` lets a caller include the
   * directly-affected user (e.g. the deploy trigger) — deduped.
   */
  async notifyAdmins(
    entry: { type: string; title: string; body?: string; link?: string },
    extraUserIds: string[] = [],
  ): Promise<void> {
    try {
      const adminIds = await this.getActiveAdminIds();
      const userIds = [...new Set([...adminIds, ...extraUserIds])];
      if (userIds.length === 0) return;
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          type: entry.type,
          title: entry.title,
          body: entry.body ?? null,
          link: entry.link ?? null,
        })),
      });
      // Retention: best-effort prune of entries older than 90 days for
      // the users we just wrote to. Piggy-backing on creation keeps the
      // table bounded without a dedicated cron.
      await this.pruneOldNotifications(userIds);
    } catch (err) {
      this.logger.error(`notifyAdmins failed: ${(err as Error).message}`);
    }
  }

  /** Feed for the current user, newest first. */
  async listNotifications(userId: string, opts: { unread?: boolean; take?: number } = {}) {
    const take = Math.min(Math.max(opts.take ?? 20, 1), 100);
    return this.prisma.notification.findMany({
      where: { userId, ...(opts.unread ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { count };
  }

  /** Mark one notification read — scoped to the owner, idempotent. */
  async markRead(userId: string, id: string): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  private async getActiveAdminIds(): Promise<string[]> {
    const now = Date.now();
    if (
      this.adminIdsCache &&
      now - this.adminIdsCache.at < NotificationsService.ADMIN_CACHE_TTL_MS
    ) {
      return this.adminIdsCache.ids;
    }
    const admins = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPERADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    const ids = admins.map((a: { id: string }) => a.id);
    this.adminIdsCache = { ids, at: now };
    return ids;
  }

  private async pruneOldNotifications(userIds: string[]): Promise<void> {
    const cutoff = new Date(
      Date.now() - NotificationsService.RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    try {
      await this.prisma.notification.deleteMany({
        where: { userId: { in: userIds }, createdAt: { lt: cutoff } },
      });
    } catch (err) {
      // Best-effort — retention failure must never surface to callers.
      this.logger.warn(`notification retention prune failed: ${(err as Error).message}`);
    }
  }

  // ── internal helpers ──────────────────────────────────────────────

  /**
   * Per-user notification-preference gate. Opt-out model: the dashboard
   * toggles default to "on", so a missing prefs object, missing event or
   * missing channel entry all mean "send". Only an explicit `false`
   * blocks. Unknown events/channels therefore pass through unfiltered.
   */
  private allows(
    prefs: unknown,
    event: NotifEvent,
    channel: 'email' | 'discord' | 'slack' | 'webhook',
  ): boolean {
    if (!prefs || typeof prefs !== 'object') return true;
    const eventPrefs = (prefs as NotificationPrefs)[event];
    if (!eventPrefs || typeof eventPrefs !== 'object') return true;
    return eventPrefs[channel] !== false;
  }

  private async sendMail(opts: { to: string; subject: string; html: string }): Promise<void> {
    if (!this.transporter || !this.smtpFrom) return;
    try {
      await this.transporter.sendMail({
        from: this.smtpFrom,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
    } catch (err) {
      // Never throw out of a notification — caller flows must not break
      // because mail is misconfigured. Log loudly so it shows up in ops.
      this.logger.error(
        `sendMail to ${opts.to} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * SSRF guard for outbound webhook POSTs. Alert-rule webhookUrl is
   * operator-supplied, so without this an admin (or a compromised one)
   * could point it at internal infra — the docker network, the host's
   * loopback, or the cloud metadata endpoint (169.254.169.254) to exfil
   * IAM creds. We reject anything that isn't a public http(s) target.
   *
   * We deliberately do NOT DNS-resolve here (a public hostname could still
   * resolve to a private IP — full protection needs resolve + connect-time
   * pinning). This is a hostname/IP-literal screen: it blocks the obvious
   * `http://169.254.169.254`, `http://localhost`, `http://10.x` cases that
   * make up the realistic attack surface for a stored alert-rule URL.
   * Returns the validation error string, or null when the URL is allowed.
   * Public so the monitoring service can screen a webhookUrl at write time
   * (create/update alert rule) using the exact same ruleset as dispatch.
   */
  validateWebhookUrl(raw: string): string | null {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'not a valid URL';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `unsupported scheme "${url.protocol}" (only http/https)`;
    }
    // Strip IPv6 brackets / trailing dot for the literal checks below.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return 'loopback host is not allowed';
    }
    // IPv4 literal → block loopback/private/link-local ranges.
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      if (
        a === 127 || // 127.0.0.0/8 loopback
        a === 10 || // 10.0.0.0/8 private
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
        (a === 192 && b === 168) || // 192.168.0.0/16 private
        (a === 169 && b === 254) || // 169.254.0.0/16 link-local incl. metadata 169.254.169.254
        a === 0 // 0.0.0.0/8 "this host"
      ) {
        return `private/loopback/link-local address ${host} is not allowed`;
      }
      return null;
    }
    // IPv6 literal → default-DENY, then allow only addresses that are clearly
    // public. Blocking by enumerated range alone is unsafe because an IPv4
    // address can be smuggled inside IPv6 (::ffff:127.0.0.1 IPv4-mapped,
    // ::a.b.c.d compat, 64:ff9b::a.b.c.d NAT64), so we extract any embedded
    // IPv4 and run it through the v4 private-range screen.
    if (host.includes(':')) {
      if (host === '::1' || host === '::') return 'loopback address is not allowed';
      if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'unique-local address (fc00::/7) is not allowed';
      if (/^fe[89ab][0-9a-f]:/.test(host)) return 'link-local address (fe80::/10) is not allowed';
      // Embedded IPv4 — ::ffff:1.2.3.4 (dotted), ::ffff:0102:0304 (hex), and
      // the NAT64 64:ff9b::/96 prefix. Pull out the trailing IPv4, whether
      // written dotted or as the last two hextets, and re-screen it.
      const embeddedV4 = this.extractEmbeddedV4(host);
      if (embeddedV4) {
        const v4err = this.validateWebhookUrl(`http://${embeddedV4}`);
        // Re-screen returns the v4 range error (or null if the embedded
        // address is genuinely public).
        if (v4err) return `embedded IPv4 ${embeddedV4}: ${v4err}`;
        return null;
      }
      // Any IPv6 literal we can't positively classify as public is rejected.
      // (Global-unicast 2000::/3 alert targets are vanishingly rare; the safe
      // default for a stored, server-dereferenced URL is deny.)
      return 'IPv6 literal hosts are not allowed for webhooks';
    }
    return null;
  }

  /**
   * Extract a dotted-quad IPv4 embedded in an IPv6 literal, covering the
   * IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), and NAT64
   * (64:ff9b::a.b.c.d) forms — including the all-hex spelling where the last
   * 32 bits are written as two hextets (::ffff:7f00:0001). Returns the dotted
   * string, or null when there is no embedded IPv4 to screen.
   */
  private extractEmbeddedV4(host: string): string | null {
    // Already-dotted tail, e.g. ::ffff:127.0.0.1 or 64:ff9b::10.0.0.1
    const dotted = host.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
    if (dotted) return dotted[1];
    // Hex tail for the IPv4-mapped/compat prefixes: last two hextets are the
    // 32-bit IPv4 (::ffff:7f00:1 → 127.0.0.1, ::ffff:0:7f00:1, etc.).
    const mapped = host.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const compat = host.match(/^(?:0{0,4}:){1,6}([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const hx = mapped || compat;
    if (hx) {
      const hi = parseInt(hx[1], 16);
      const lo = parseInt(hx[2], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      }
    }
    return null;
  }

  private async postWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
    // SSRF screen — never POST to an internal/loopback/metadata target.
    const violation = this.validateWebhookUrl(url);
    if (violation) {
      this.logger.warn(`Refusing webhook to ${url}: ${violation}.`);
      return;
    }
    // Node 20 ships global fetch + AbortController. 5 s ceiling keeps a
    // slow webhook target from blocking the monitoring loop.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `Webhook ${url} returned HTTP ${res.status} for rule ${payload.ruleId}.`,
        );
      }
    } catch (err) {
      const msg = (err as Error).message || String(err);
      this.logger.error(`Webhook ${url} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private buildDashboardUrl(path: string): string {
    const base =
      this.systemConfig.get<string>('public_dashboard_url', 'PUBLIC_DASHBOARD_URL') ??
      'http://localhost:3000';
    const trimmed = base.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${trimmed}${suffix}`;
  }

  private wasRecentlyFired(ruleId: string): boolean {
    const at = this.recentlyFiredAlerts.get(ruleId);
    if (!at) return false;
    if (Date.now() - at > NotificationsService.ALERT_TTL_MS) {
      this.recentlyFiredAlerts.delete(ruleId);
      return false;
    }
    return true;
  }

  private markFired(ruleId: string): void {
    this.recentlyFiredAlerts.set(ruleId, Date.now());
  }

  private sweepExpiredAlerts(): void {
    const cutoff = Date.now() - NotificationsService.ALERT_TTL_MS;
    for (const [id, at] of this.recentlyFiredAlerts) {
      if (at < cutoff) this.recentlyFiredAlerts.delete(id);
    }
  }
}
