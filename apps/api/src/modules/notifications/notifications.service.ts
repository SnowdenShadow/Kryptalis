import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlertRule } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { renderEmail, escapeHtml } from './email-templates';

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
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: any = null;
  private smtpFrom: string | null = null;
  private smtpReady = false;

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

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.initTransport();
    // Periodic sweep so the Set/Map never grows unbounded if rule IDs
    // come and go. Cheap O(n) over a tiny collection — refresh every TTL.
    this.cleanupTimer = setInterval(
      () => this.sweepExpiredAlerts(),
      NotificationsService.ALERT_TTL_MS,
    );
    // Unref so this timer doesn't hold the event loop open at shutdown.
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.transporter?.close) {
      try {
        this.transporter.close();
      } catch {}
    }
  }

  // ── transport bootstrap ───────────────────────────────────────────

  private initTransport() {
    const host = this.config.get<string>('SMTP_HOST');
    if (!host) {
      this.logger.warn(
        'SMTP_HOST not configured — email notifications will be no-ops. ' +
          'Set SMTP_HOST/PORT/USER/PASS/FROM to enable outbound mail.',
      );
      return;
    }
    const port = Number(this.config.get<string>('SMTP_PORT') ?? 587);
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    this.smtpFrom =
      this.config.get<string>('SMTP_FROM') ?? user ?? 'no-reply@kryptalis.local';

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

  async sendPasswordReset(email: string, token: string, userName: string): Promise<void> {
    const url = this.buildDashboardUrl(`/auth/reset-password?token=${encodeURIComponent(token)}`);

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
          We received a request to reset the password for your Kryptalis
          account. Click the button below to choose a new one. This link
          expires in 30 minutes and can only be used once.
        </p>
        <p style="margin:0;">If you didn't request a reset, no action is needed.</p>`,
      ctaLabel: 'Reset password',
      ctaUrl: url,
    });
    await this.sendMail({
      to: email,
      subject: 'Reset your Kryptalis password',
      html,
    });
  }

  async sendEmailVerification(email: string, token: string, userName: string): Promise<void> {
    const url = this.buildDashboardUrl(
      `/auth/verify-email?token=${encodeURIComponent(token)}`,
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
          This helps keep your Kryptalis account secure.
        </p>`,
      ctaLabel: 'Verify email',
      ctaUrl: url,
    });
    await this.sendMail({
      to: email,
      subject: 'Verify your Kryptalis email',
      html,
    });
  }

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
      preheader: `${inviterName} invited you to collaborate on Kryptalis.`,
      body: `
        <p style="margin:0 0 12px 0;">Hi,</p>
        <p style="margin:0 0 12px 0;">
          <strong>${escapeHtml(inviterName)}</strong> invited you to join the
          <strong>${escapeHtml(projectName)}</strong> project on Kryptalis.
        </p>
        <p style="margin:0;">Accept the invitation to get started.</p>`,
      ctaLabel: 'Accept invitation',
      ctaUrl: url,
    });
    await this.sendMail({
      to: email,
      subject: `${inviterName} invited you to ${projectName} on Kryptalis`,
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
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      });
      email = u?.email ?? null;
      name = u?.name ?? 'there';
    } catch (err) {
      this.logger.error(
        `sendDeploymentResult: failed to resolve user ${userId}: ${(err as Error).message}`,
      );
      return;
    }
    if (!email) {
      this.logger.warn(`sendDeploymentResult: no email on user ${userId}; skipping.`);
      return;
    }
    if (!this.smtpReady) {
      this.logger.warn(`Skipping deployment email to ${email} — SMTP not configured.`);
      return;
    }

    const ok = status === 'success';
    const title = ok ? `Deployment succeeded: ${appName}` : `Deployment failed: ${appName}`;
    const url = this.buildDashboardUrl('/dashboard/applications');
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
      subject: `[Kryptalis] Alert: ${rule.name}`,
      html,
    });
  }

  // ── internal helpers ──────────────────────────────────────────────

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

  private async postWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
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
      this.config.get<string>('PUBLIC_DASHBOARD_URL') ??
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
