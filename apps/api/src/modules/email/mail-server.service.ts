import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  OnApplicationBootstrap,
  Logger,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as net from 'net';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.DOCKCONTROL_DATA_DIR || path.join(process.cwd(), '.dockcontrol');
const MAIL_DIR = path.join(DATA_DIR, 'mail');
// When the API runs in a container, the docker daemon on the host resolves
// bind-mount source paths against the HOST filesystem, not the API container's
// filesystem. Set DOCKCONTROL_HOST_DATA_DIR to the host path that the API's
// .dockcontrol volume mounts FROM (e.g. /opt/dockcontrol/.dockcontrol) so generated
// compose files use the correct absolute host paths.
const HOST_DATA_DIR = process.env.DOCKCONTROL_HOST_DATA_DIR || DATA_DIR;
const HOST_MAIL_DIR = path.posix.join(HOST_DATA_DIR.replace(/\\/g, '/'), 'mail');

/**
 * Provisions a docker-mailserver stack per domain.
 * Uses `mailserver/docker-mailserver` image — Postfix + Dovecot + rspamd + OpenDKIM bundled.
 */
@Injectable()
export class MailServerService implements OnApplicationBootstrap {
  private readonly logger = new Logger('MailServerReconcile');

  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    private encryption: EncryptionService,
  ) {
    if (!fs.existsSync(MAIL_DIR)) fs.mkdirSync(MAIL_DIR, { recursive: true });
  }

  /**
   * On every API boot, walk every MailServer row and make sure the on-disk
   * compose file + opendkim config match what the CURRENT code would
   * generate. If anything drifted (because the code changed across a
   * deploy, like the ENABLE_OPENDKIM:0 → 1 fix), redeploy that domain.
   *
   * This is what makes `git pull + restart api` enough — no manual click.
   * Safe to run repeatedly: the comparison is content-based, so identical
   * configs are no-ops.
   */
  async onApplicationBootstrap() {
    // Register the cert-renewal callback with the reverse-proxy so it can
    // ping us when Caddy rotates a mail.<apex> certificate. Avoids the
    // circular dep that direct injection would create.
    try {
      this.proxy.setMailReloadHook((domainId: string) => this.reloadMailServer(domainId));
    } catch {}
    // Run async; never block the API from coming up if reconcile hangs.
    setImmediate(() => this.reconcileAll().catch((e) =>
      this.logger.error(`Reconcile failed: ${e?.message || e}`),
    ));
  }

  private async reconcileAll() {
    let servers: { id: string; domainId: string }[];
    try {
      servers = await this.prisma.mailServer.findMany({
        select: { id: true, domainId: true },
      });
    } catch (e: any) {
      // DB not ready yet — boot reconcile is best-effort; the next API
      // restart will pick it up.
      this.logger.warn(`Skipping mail reconcile (DB not ready): ${e?.message || e}`);
      return;
    }
    if (servers.length === 0) return;
    this.logger.log(`Reconciling ${servers.length} mail server(s)…`);
    for (const s of servers) {
      try {
        await this.reconcileOne(s.id, s.domainId);
      } catch (e: any) {
        this.logger.error(`reconcile ${s.id}: ${e?.message || e}`);
      }
    }
  }

  /**
   * Schema version of the generated mail server compose. Bumped EVERY TIME
   * we change the compose body or the opendkim/postfix layout in a way that
   * existing on-disk stacks need to pick up. The bootstrap reconciler reads
   * .stack-version from each mail dir and triggers a redeploy if it's
   * missing or older than this constant.
   *
   * History:
   *   1 — first auto-deploy logic
   *   2 — enable OpenDKIM + write KeyTable/SigningTable/TrustedHosts,
   *       enable OpenDMARC + policyd-spf
   */
  private static readonly STACK_VERSION = 2;

  /**
   * If the stack on disk is older than STACK_VERSION (or has no version
   * stamp at all), rebuild it with the current code. This is what makes
   * `git pull + restart api` enough — no manual click required to pick up
   * code changes to the mail stack.
   */
  private async reconcileOne(serverId: string, domainId: string) {
    const server = await this.prisma.mailServer.findUnique({ where: { id: serverId } });
    if (!server) return;
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) return;
    if (!server.dkimPrivateKey) return; // never deployed — nothing to reconcile

    const dir = path.join(MAIL_DIR, serverId);
    if (!fs.existsSync(dir)) return; // stack was wiped manually — leave alone

    const versionPath = path.join(dir, '.stack-version');
    let onDiskVersion = 0;
    try {
      onDiskVersion = parseInt(fs.readFileSync(versionPath, 'utf-8').trim(), 10) || 0;
    } catch {}

    if (onDiskVersion >= MailServerService.STACK_VERSION) return; // up to date

    this.logger.log(
      `Mail server ${domain.domain}: stack v${onDiskVersion} → v${MailServerService.STACK_VERSION} — redeploying with new code`,
    );

    await this.prisma.mailServer.update({
      where: { id: serverId },
      data: { status: 'DEPLOYING', lastError: null },
    });
    // runDeploy() rewrites everything + `docker compose up -d --build`.
    this.runDeploy(
      serverId,
      domain.domain,
      {
        smtp: server.smtpPort,
        submission: server.submissionPort,
        smtps: server.smtpsPort,
        imap: server.imapPort,
        imaps: server.imapsPort,
      },
      this.encryption.decrypt(server.dkimPrivateKey),
    ).catch(() => {});
  }

  // ── access ────────────────────────────────────────────────────────

  private async assertDomainAccess(
    userId: string,
    domainId: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'VIEWER',
  ) {
    const domain = await this.prisma.domain.findUnique({
      where: { id: domainId },
      include: { application: { select: { projectId: true } } },
    });
    if (!domain) throw new NotFoundException('Domain not found');
    const projectId = domain.projectId || domain.application?.projectId;
    if (!projectId) {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (me?.role !== 'ADMIN' && me?.role !== 'SUPERADMIN') {
        throw new ForbiddenException('Domain has no project');
      }
      return domain;
    }
    await assertProjectAccess(this.prisma, userId, projectId, minRole);
    return domain;
  }

  // ── reads ─────────────────────────────────────────────────────────

  async getStatus(userId: string, domainId: string) {
    await this.assertDomainAccess(userId, domainId, 'VIEWER');
    const server = await this.prisma.mailServer.findUnique({
      where: { domainId },
      include: { domain: { select: { domain: true } } },
    });
    if (!server) return null;

    // also probe docker for live state
    const containerName = `dockcontrol-mail-${server.domain.domain.replace(/\./g, '-')}`;
    let liveStatus = server.status as string;
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['inspect', '--format', '{{.State.Status}}', containerName],
        { timeout: 5000 },
      );
      const docker = stdout.trim();
      if (docker === 'running' && server.status !== 'RUNNING') {
        await this.prisma.mailServer.update({
          where: { id: server.id },
          data: { status: 'RUNNING' },
        });
        liveStatus = 'RUNNING';
      } else if (docker !== 'running' && server.status === 'RUNNING') {
        await this.prisma.mailServer.update({
          where: { id: server.id },
          data: { status: 'STOPPED' },
        });
        liveStatus = 'STOPPED';
      }
    } catch {
      if (server.status === 'RUNNING') {
        await this.prisma.mailServer.update({
          where: { id: server.id },
          data: { status: 'STOPPED' },
        });
        liveStatus = 'STOPPED';
      }
    }

    return { ...server, status: liveStatus };
  }

  // ── deploy ────────────────────────────────────────────────────────

  async deploy(userId: string, domainId: string) {
    const domain = await this.assertDomainAccess(userId, domainId, 'ADMIN');

    // Mail server is intended for the APEX domain. If the user picked a
    // subdomain we'd build hostname mail.<sub>.<apex>, generate DKIM/SPF/
    // DMARC against the subdomain (not the parent), and the user would
    // never receive mail addressed to user@apex. Block it with a clear
    // error pointing at the right domain. Skip the check when there's an
    // existing server (re-deploy of an already-set-up subdomain shouldn't
    // suddenly fail).
    const existing = await this.prisma.mailServer.findUnique({ where: { domainId } });
    if (!existing) {
      const labels = domain.domain.split('.').filter(Boolean);
      if (labels.length > 2) {
        const apex = labels.slice(-2).join('.');
        throw new BadRequestException(
          `Mail servers must be attached to the apex domain. "${domain.domain}" is a subdomain — attach the mail server to "${apex}" instead, and your addresses will be user@${apex}.`,
        );
      }
    }

    let server = existing;

    // Generate DKIM keypair on first deploy. Private key is encrypted at
    // rest (AES-256-GCM) — a DB leak no longer hands DKIM signing material
    // to an attacker. Public key stays plain since it's already in DNS
    // (TXT record on the user's domain).
    let dkimKey = server?.dkimPrivateKey ? this.encryption.decrypt(server.dkimPrivateKey) : undefined;
    let dkimPub = server?.dkimPublicKey;
    if (!dkimKey || !dkimPub) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      dkimKey = privateKey;
      const pubB64 = publicKey
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\s+/g, '');
      dkimPub = pubB64;
    }
    const dkimKeyEncrypted = this.encryption.encrypt(dkimKey);

    // claim a free port range
    const ports = await this.allocatePorts(domainId, server);

    // Preflight: confirm the host ports we're about to bind aren't already
    // held by a non-Docker process. Classic case: Ubuntu ships with Postfix
    // already running on tcp/25 — `docker compose up` would error with a
    // cryptic "address already in use" and the operator would have no
    // actionable signal. Probe ALL the ports we're going to publish; if any
    // is taken, throw with the exact remediation command.
    //
    // First deploy ONLY: on a re-deploy the probe would hit our own running
    // container (allocatePorts returns the existing range) and 400 every
    // time. runDeploy force-removes that container before `compose up`, so
    // its ports are guaranteed to be released mid-pipeline.
    const portsToCheck = existing
      ? []
      : [
          { port: ports.smtp, label: 'SMTP' },
          { port: ports.submission, label: 'Submission' },
          { port: ports.smtps, label: 'SMTPS' },
          { port: ports.imap, label: 'IMAP' },
          { port: ports.imaps, label: 'IMAPS' },
        ];
    const conflicts: { port: number; label: string }[] = [];
    for (const { port, label } of portsToCheck) {
      const occupied = await this.isHostPortOccupied(port);
      if (occupied) conflicts.push({ port, label });
    }
    if (conflicts.length > 0) {
      const list = conflicts.map((c) => `${c.label} (${c.port})`).join(', ');
      const remediation = conflicts.some((c) => c.port === 25 || c.port === 587 || c.port === 465)
        ? `\n\nMost common cause: the system's native Postfix or sendmail. To free the ports:\n  sudo systemctl stop postfix && sudo systemctl disable postfix\n  sudo systemctl stop sendmail 2>/dev/null && sudo systemctl disable sendmail 2>/dev/null`
        : `\n\nUse \`sudo lsof -i :${conflicts[0].port}\` on the host to find the offending process.`;
      throw new BadRequestException(
        `Cannot deploy mail server: host ports already in use: ${list}.${remediation}`,
      );
    }

    server = await this.prisma.mailServer.upsert({
      where: { domainId },
      create: {
        domainId,
        status: 'DEPLOYING',
        hostname: `mail.${domain.domain}`,
        smtpPort: ports.smtp,
        submissionPort: ports.submission,
        smtpsPort: ports.smtps,
        imapPort: ports.imap,
        imapsPort: ports.imaps,
        dkimSelector: 'dockcontrol',
        dkimPrivateKey: dkimKeyEncrypted,
        dkimPublicKey: dkimPub,
      },
      update: {
        status: 'DEPLOYING',
        dkimPrivateKey: dkimKeyEncrypted,
        dkimPublicKey: dkimPub,
        lastError: null,
      },
    });

    // make sure Caddy has a block for mail.<apex> so a Let's Encrypt cert gets
    // provisioned BEFORE the container tries to start dovecot — without the
    // cert files on disk, dovecot can't open the IMAPS socket and the deploy
    // ends in a half-up state.
    this.proxy.regenerate().catch(() => {});

    // write filesystem + start docker (async, no await)
    this.runDeploy(server.id, domain.domain, ports, dkimKey!).catch(() => {});

    return server;
  }

  async stop(userId: string, domainId: string) {
    await this.assertDomainAccess(userId, domainId, 'DEVELOPER');
    const server = await this.prisma.mailServer.findUnique({ where: { domainId } });
    if (!server) throw new NotFoundException('Mail server not provisioned');
    const dir = path.join(MAIL_DIR, server.id);
    if (fs.existsSync(dir)) {
      try { await execFileAsync('docker', ['compose', 'stop'], { cwd: dir, timeout: 60_000 }); } catch {}
    }
    return this.prisma.mailServer.update({
      where: { id: server.id },
      data: { status: 'STOPPED' },
    });
  }

  async remove(userId: string, domainId: string) {
    await this.assertDomainAccess(userId, domainId, 'ADMIN');
    await this.removeForDomain(domainId);
    return { message: 'Mail server removed' };
  }

  /**
   * Send a real test email to verify end-to-end deliverability.
   *
   * We submit via tcp/25 from the host (where the API runs) — Postfix accepts
   * messages from 127.0.0.1 with no auth (mynetworks). The mail enters the
   * outbound queue, Postfix opens a tcp/25 connection to the recipient's MX,
   * and delivers (or queues with a bounce on failure). The user gets back a
   * transcript of the SMTP conversation between us and the local Postfix —
   * which is enough to confirm "your mail server accepted the message".
   *
   * What this does NOT prove: that the recipient's MX actually accepted
   * delivery. That requires:
   *   - outbound tcp/25 unblocked at the VPS-provider level (checked
   *     separately in /dns/:domainId/health → outboundSmtp)
   *   - DKIM/SPF/DMARC records propagated
   *   - PTR (rDNS) set
   * The summary string returned tells the user to check those if the test
   * "succeeds" but mail still doesn't arrive.
   */
  async sendTestEmail(userId: string, domainId: string, fromMailboxId: string, to: string) {
    await this.assertDomainAccess(userId, domainId, 'DEVELOPER');
    const server = await this.prisma.mailServer.findUnique({ where: { domainId } });
    if (!server) throw new NotFoundException('Mail server not deployed for this domain');
    const mailbox = await this.prisma.mailbox.findFirst({
      where: { id: fromMailboxId, domainId },
    });
    if (!mailbox) throw new NotFoundException('Mailbox not found on this domain');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new BadRequestException(`"${to}" is not a valid email address.`);
    }

    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');

    const transcript: string[] = [];
    const log = (line: string) => transcript.push(line);

    // Connect via the shared docker network using the container's name.
    // 127.0.0.1 wouldn't work because the API runs inside its own container
    // (loopback ≠ host). The mail server's internal port is always 25 — the
    // host-mapped port (server.smtpPort) is irrelevant for in-cluster traffic.
    const host = `dockcontrol-mail-${domain.domain.replace(/\./g, '-')}`;
    const port = 25;
    const from = `${mailbox.localPart}@${domain.domain}`;

    return await new Promise<{
      success: boolean;
      transcript: string[];
      durationMs: number;
      summary: string;
    }>((resolve) => {
      const started = Date.now();
      const socket = new net.Socket();
      let buffer = '';
      let step = 0;
      const out = (data: string) => {
        log(`> ${data.trim()}`);
        socket.write(data);
      };
      const finish = (success: boolean, summary: string) => {
        try { socket.destroy(); } catch {}
        resolve({ success, transcript, durationMs: Date.now() - started, summary });
      };

      socket.setTimeout(20_000);
      socket.once('timeout', () => finish(false, 'Connection to local Postfix timed out — is the mail server running?'));
      socket.once('error', (e: any) => finish(false, `Connection error: ${e?.message || e}`));

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!line) continue;
          log(`< ${line}`);
          if (line.length >= 4 && line[3] === '-') continue; // multi-line continuation
          const code = parseInt(line.slice(0, 3), 10);

          if (step === 0 && code === 220) { out(`EHLO dockcontrol.local\r\n`); step = 1; return; }
          if (step === 1 && code === 250) { out(`MAIL FROM:<${from}>\r\n`); step = 2; return; }
          if (step === 2 && code === 250) { out(`RCPT TO:<${to}>\r\n`); step = 3; return; }
          if (step === 3) {
            if (code === 250 || code === 251) { out(`DATA\r\n`); step = 4; return; }
            return finish(false, `Recipient rejected by local Postfix (${code} ${line.slice(4)}). The mail server isn't configured to relay to external addresses — check that mynetworks includes 127.0.0.0/8.`);
          }
          if (step === 4 && code === 354) {
            const subject = `DockControl test email from ${domain.domain}`;
            const body = [
              `From: ${from}`,
              `To: ${to}`,
              `Subject: ${subject}`,
              `Date: ${new Date().toUTCString()}`,
              `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${domain.domain}>`,
              `Content-Type: text/plain; charset=utf-8`,
              ``,
              `This is a test message sent from your DockControl mail server.`,
              ``,
              `If you received it, outbound delivery from ${domain.domain} works end-to-end.`,
              `If it landed in spam: DKIM/SPF/DMARC/PTR likely need attention.`,
              `If it never arrived: outbound tcp/25 may be blocked at your VPS provider.`,
              ``,
              `-- DockControl`,
              `.`,
              ``,
            ].join('\r\n');
            out(body);
            step = 5;
            return;
          }
          if (step === 5) {
            if (code === 250) {
              out(`QUIT\r\n`);
              return finish(
                true,
                `Local Postfix accepted the message (queue ID: ${line.slice(4)}). It's now being relayed to the recipient's MX. If it doesn't arrive within a minute: 1) check the DNS health tab (DKIM/SPF/DMARC/PTR), 2) verify outbound tcp/25 isn't blocked at your VPS provider, 3) check the mail server's logs.`,
              );
            }
            return finish(false, `Message rejected after DATA (${code} ${line.slice(4)}).`);
          }
          if (code >= 400) {
            return finish(false, `SMTP error ${code}: ${line.slice(4)}`);
          }
        }
      });

      try {
        log(`-- connecting to ${host}:${port} (local Postfix) --`);
        socket.connect(port, host);
      } catch (e: any) {
        finish(false, `Could not connect: ${e?.message || e}`);
      }
    });
  }

  /**
   * Internal cleanup — no auth check. Safe to call when the parent Domain row
   * is about to be deleted (cascade): tears down compose stack, removes the
   * container by name (covers orphans whose compose dir is missing), wipes
   * the on-disk dir, deletes the DB row. Idempotent.
   */
  async removeForDomain(domainId: string) {
    const server = await this.prisma.mailServer.findUnique({ where: { domainId } });
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    const containerName = domain
      ? `dockcontrol-mail-${domain.domain.replace(/\./g, '-')}`
      : null;

    if (server) {
      const dir = path.join(MAIL_DIR, server.id);
      if (fs.existsSync(dir)) {
        try { await execFileAsync('docker', ['compose', 'down', '-v', '--remove-orphans'], { cwd: dir, timeout: 60_000 }); } catch {}
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      await this.prisma.mailServer.delete({ where: { id: server.id } });
    }

    // belt-and-suspenders: if a container with the expected name still exists
    // (compose dir missing, prior crash, name reused), force-remove it so the
    // ports it holds are freed.
    if (containerName) {
      try { await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 30_000 }); } catch {}
    }
  }

  // ── account sync (called by EmailService after each mailbox/alias change) ──

  async syncAccounts(domainId: string) {
    const server = await this.prisma.mailServer.findUnique({ where: { domainId } });
    if (!server) return;
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) return;

    const mailboxes = await this.prisma.mailbox.findMany({
      where: { domainId, status: 'ACTIVE', forwardTo: null },
    });
    const forwards = await this.prisma.mailbox.findMany({
      where: { domainId, status: 'ACTIVE', NOT: { forwardTo: null } },
    });
    const aliases = await this.prisma.emailAlias.findMany({
      where: { domainId },
      include: { mailbox: true },
    });

    const dir = path.join(MAIL_DIR, server.id);
    if (!fs.existsSync(dir)) return;

    // postfix-accounts.cf — Dovecot's canonical bcrypt scheme is
    // {BLF-CRYPT}, which has a native verifier inside Dovecot since 2.3 and
    // does not depend on the host libc's crypt(3). The previous {CRYPT}
    // implementation only worked because the docker-mailserver base image
    // happens to ship libxcrypt with $2y$ support — fragile across base
    // image rebuilds and not what doveadm pw produces. We also normalize
    // the legacy $2a$/$2b$ prefix to $2y$ so Dovecot's bcrypt verifier
    // doesn't choke on the identifier; the hash payload is identical
    // across the three variants.
    const accountsPath = path.join(dir, 'config', 'postfix-accounts.cf');
    const newAccounts =
      mailboxes
        .map((m) => {
          const hash = m.passwordHash.replace(/^\$2[ab]\$/, '$2y$');
          return `${m.address}|{BLF-CRYPT}${hash}`;
        })
        .join('\n') + '\n';
    const prevAccounts = fs.existsSync(accountsPath) ? fs.readFileSync(accountsPath, 'utf-8') : '';
    const accountsChanged = prevAccounts !== newAccounts;
    if (accountsChanged) {
      fs.writeFileSync(accountsPath, newAccounts);
    }

    const virtualPath = path.join(dir, 'config', 'postfix-virtual.cf');
    const virtualLines: string[] = [];
    for (const f of forwards) virtualLines.push(`${f.address}  ${f.forwardTo}`);
    for (const a of aliases) {
      const dest = a.mailbox?.address || a.forwardTo;
      if (dest) virtualLines.push(`${a.address}  ${dest}`);
    }
    // Catch-all: a mailbox flagged catchAll receives everything addressed to
    // the domain that no other mailbox/alias matches. Postfix expresses this
    // as a bare "@domain  <target>" virtual map entry. createMailbox enforces
    // at most one catch-all per domain, so the first match wins. Without this
    // the flag was stored but never wired up — catch-all mail was rejected.
    const catchAllBox =
      mailboxes.find((m) => m.catchAll) || forwards.find((m) => m.catchAll);
    if (catchAllBox) {
      const target = catchAllBox.forwardTo || catchAllBox.address;
      virtualLines.push(`@${domain.domain}  ${target}`);
    }
    const newVirtual = virtualLines.join('\n') + '\n';
    const prevVirtual = fs.existsSync(virtualPath) ? fs.readFileSync(virtualPath, 'utf-8') : '';
    const virtualChanged = prevVirtual !== newVirtual;
    if (virtualChanged) {
      fs.writeFileSync(virtualPath, newVirtual);
    }

    // Skip the reload entirely when nothing changed. The reload itself is
    // a no-op semantically, but the OLD code triggered one on every mailbox
    // CRUD which (a) wasted ~50ms per request, (b) hid the absence of a
    // proper cert-renewal reload behind accidental side-effects.
    if (!accountsChanged && !virtualChanged) return;

    const containerName = `dockcontrol-mail-${domain.domain.replace(/\./g, '-')}`;
    try {
      await execFileAsync('docker', ['exec', containerName, 'postfix', 'reload'], { timeout: 5_000 });
    } catch {}
    // Also force Dovecot to flush its auth cache + re-read userdb so the new
    // mailbox is loggable immediately (the docker-mailserver image's
    // changedetector usually catches this within 2s, but we don't want to
    // gamble on timing).
    try {
      await execFileAsync('docker', ['exec', containerName, 'doveadm', 'reload'], { timeout: 5_000 });
    } catch {}
    try {
      await execFileAsync('docker', ['exec', containerName, 'doveadm', 'auth', 'cache', 'flush'], { timeout: 5_000 });
    } catch {}
  }

  /**
   * Tail mail container logs. Defaults to last 200 combined lines from
   * Postfix + Dovecot + rspamd + fail2ban. `service` filters to one
   * stream. Project-scoped via assertDomainAccess.
   */
  async getLogs(
    userId: string,
    domainId: string,
    opts: { lines?: number; service?: 'all' | 'postfix' | 'dovecot' | 'rspamd' | 'fail2ban' } = {},
  ): Promise<{ logs: string }> {
    await this.assertDomainAccess(userId, domainId, 'DEVELOPER');
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');
    const containerName = `dockcontrol-mail-${domain.domain.replace(/\./g, '-')}`;
    const lines = Math.min(Math.max(opts.lines || 200, 10), 5000);
    const service = opts.service || 'all';
    try {
      if (service === 'all') {
        const { stdout } = await execFileAsync(
          'docker',
          ['logs', '--tail', String(lines), '--timestamps', containerName],
          { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
        );
        return { logs: stdout };
      }
      // Service-scoped logs live under /var/log/mail in the container,
      // mounted at ${hostDir}/logs. Use tail on the right file.
      const fileMap: Record<string, string> = {
        postfix: '/var/log/mail/mail.log',
        dovecot: '/var/log/mail/dovecot.log',
        rspamd: '/var/log/mail/rspamd.log',
        fail2ban: '/var/log/mail/fail2ban.log',
      };
      const file = fileMap[service];
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', containerName, 'tail', '-n', String(lines), file],
        { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return { logs: stdout };
    } catch (e: any) {
      return { logs: `(failed to read logs: ${e?.message || e})` };
    }
  }

  /**
   * List fail2ban jails + their currently-banned IPs. Lets a project
   * member see whether their own IP / a user's IP got auto-banned by
   * dovecot/postfix and gives them a way to unblock without SSH.
   */
  async getBans(userId: string, domainId: string): Promise<{ jails: { name: string; banned: string[] }[] }> {
    await this.assertDomainAccess(userId, domainId, 'DEVELOPER');
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');
    const containerName = `dockcontrol-mail-${domain.domain.replace(/\./g, '-')}`;
    try {
      const { stdout: statusOut } = await execFileAsync(
        'docker',
        ['exec', containerName, 'fail2ban-client', 'status'],
        { timeout: 5_000 },
      );
      const jailLine = statusOut.split('\n').find((l) => l.includes('Jail list:'));
      const jailNames = (jailLine ? jailLine.split(':').slice(1).join(':') : '')
        .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      const jails: { name: string; banned: string[] }[] = [];
      for (const name of jailNames) {
        try {
          const { stdout } = await execFileAsync(
            'docker',
            ['exec', containerName, 'fail2ban-client', 'status', name],
            { timeout: 5_000 },
          );
          const ipLine = stdout.split('\n').find((l) => l.includes('Banned IP list:'));
          const ips = ipLine
            ? ipLine.split(':').slice(1).join(':').trim().split(/\s+/).filter(Boolean)
            : [];
          jails.push({ name, banned: ips });
        } catch {}
      }
      return { jails };
    } catch (e: any) {
      throw new NotFoundException(`fail2ban not reachable in mail container: ${e?.message || e}`);
    }
  }

  async unbanIp(userId: string, domainId: string, ip: string): Promise<{ unbanned: string }> {
    await this.assertDomainAccess(userId, domainId, 'ADMIN');
    // Tight validation — IP only, no shell metacharacters slipping in.
    if (!/^[0-9.:a-fA-F]+$/.test(ip)) {
      throw new BadRequestException('Invalid IP.');
    }
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');
    const containerName = `dockcontrol-mail-${domain.domain.replace(/\./g, '-')}`;
    try {
      await execFileAsync(
        'docker',
        ['exec', containerName, 'fail2ban-client', 'unban', ip],
        { timeout: 5_000 },
      );
      return { unbanned: ip };
    } catch (e: any) {
      throw new NotFoundException(`Could not unban: ${e?.message || e}`);
    }
  }

  /**
   * Reload Postfix + Dovecot inside the mail container. Used by the SSL
   * cert watcher (see reverse-proxy.service.ts) and by the daily cron
   * pulse. Safe to call when the container is down — failures are logged
   * but never thrown.
   */
  async reloadMailServer(domainId: string): Promise<void> {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) return;
    const containerName = `dockcontrol-mail-${domain.domain.replace(/\./g, '-')}`;
    try {
      await execFileAsync('docker', ['exec', containerName, 'postfix', 'reload'], { timeout: 5_000 });
      await execFileAsync('docker', ['exec', containerName, 'doveadm', 'reload'], { timeout: 5_000 });
    } catch (e: any) {
      this.logger.warn(`Mail reload failed for ${domain.domain}: ${e?.message || e}`);
    }
  }

  // ── internal: write compose + start ──────────────────────────────

  private async runDeploy(
    serverId: string,
    domain: string,
    ports: { smtp: number; submission: number; smtps: number; imap: number; imaps: number },
    dkimPrivateKey: string,
  ) {
    const dir = path.join(MAIL_DIR, serverId);
    const cfgDir = path.join(dir, 'config');
    const dataDir = path.join(dir, 'data');
    const stateDir = path.join(dir, 'state');
    const logsDir = path.join(dir, 'logs');
    for (const d of [dir, cfgDir, dataDir, stateDir, logsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    // path the docker daemon (running on the HOST) will see — must be the host
    // path, NOT the API-container path. See HOST_MAIL_DIR above.
    const hostDir = path.posix.join(HOST_MAIL_DIR, serverId);

    // DKIM key files expected by docker-mailserver (OpenDKIM).
    // DMS mounts /tmp/docker-mailserver/opendkim → /etc/opendkim. We must
    // ship the FULL OpenDKIM config (KeyTable, SigningTable, TrustedHosts,
    // opendkim.conf) AND the private key — DMS does NOT auto-generate these
    // when an external key is provided.
    const opendkimDir = path.join(cfgDir, 'opendkim');
    const dkimKeyDir = path.join(opendkimDir, 'keys', domain);
    fs.mkdirSync(dkimKeyDir, { recursive: true });
    // Trim accidental BOM/whitespace + ensure trailing newline (OpenDKIM is strict).
    const cleanKey = dkimPrivateKey.replace(/^﻿/, '').trimEnd() + '\n';
    fs.writeFileSync(path.join(dkimKeyDir, 'dockcontrol.private'), cleanKey);
    try { fs.chmodSync(path.join(dkimKeyDir, 'dockcontrol.private'), 0o600); } catch {}

    fs.writeFileSync(
      path.join(opendkimDir, 'KeyTable'),
      `dockcontrol._domainkey.${domain} ${domain}:dockcontrol:/etc/opendkim/keys/${domain}/dockcontrol.private\n`,
    );
    fs.writeFileSync(
      path.join(opendkimDir, 'SigningTable'),
      `*@${domain} dockcontrol._domainkey.${domain}\n`,
    );
    // Trust localhost + every RFC1918 range so postfix→opendkim signing works
    // from any docker network (DMS sometimes lands on 172.16/12, 172.17/16, …).
    fs.writeFileSync(
      path.join(opendkimDir, 'TrustedHosts'),
      [
        '127.0.0.1',
        'localhost',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        `mail.${domain}`,
        domain,
      ].join('\n') + '\n',
    );

    // accounts/virtual seed (empty until sync)
    fs.writeFileSync(path.join(cfgDir, 'postfix-accounts.cf'), '');
    fs.writeFileSync(path.join(cfgDir, 'postfix-virtual.cf'), '');

    const containerName = `dockcontrol-mail-${domain.replace(/\./g, '-')}`;
    const isLocal =
      domain.endsWith('.local') ||
      domain.endsWith('.localhost') ||
      domain.endsWith('.test') ||
      domain === 'localhost';

    // SSL config:
    //   production domain → reuse Caddy's Let's Encrypt cert (manual mode).
    //   local domain      → no TLS configured, postfix uses opportunistic plain-text.
    //                       (DMS's "self-signed" mode requires you ship the key, which
    //                       we don't — leaving SSL_TYPE empty avoids the boot crash.)
    const sslEnv = isLocal
      ? `# SSL disabled in local dev — no Let's Encrypt cert available.`
      : [
          `SSL_TYPE: manual`,
          `SSL_CERT_PATH: /caddy-certs/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mail.${domain}/mail.${domain}.crt`,
          `SSL_KEY_PATH: /caddy-certs/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mail.${domain}/mail.${domain}.key`,
        ].join('\n      ');
    const sslVolume = isLocal
      ? ''
      : `      - dockcontrol_caddy_data:/caddy-certs:ro\n`;
    // The Caddy data volume is created by the root docker-compose. Its real
    // name is <project>_caddy_data where <project> is the compose project
    // (usually the parent dir name: "dockcontrol" on /opt/dockcontrol, but could
    // be "dockcontrol-dev" in dev). Resolve it dynamically by introspecting the
    // running dockcontrol-caddy container, with sensible env-var override.
    const caddyDataVolumeName = isLocal ? '' : await this.resolveCaddyDataVolume();
    const sslExternalVolumes = isLocal
      ? ''
      : `\nvolumes:\n  dockcontrol_caddy_data:\n    external: true\n    name: ${caddyDataVolumeName}\n`;

    const compose = `services:
  mailserver:
    image: ghcr.io/docker-mailserver/docker-mailserver:latest
    container_name: ${containerName}
    hostname: mail.${domain}
    restart: unless-stopped
    networks:
      # default network for inbound/outbound traffic
      - default
      # join the shared bridge so the API container can talk to us by name
      # for the 'Send test email' loopback (container-to-container SMTP).
      - dockcontrol-apps
    ports:
      - "${ports.smtp}:25"
      - "${ports.submission}:587"
      - "${ports.smtps}:465"
      - "${ports.imap}:143"
      - "${ports.imaps}:993"
    environment:
      ENABLE_RSPAMD: 1
      ENABLE_OPENDKIM: 1
      ENABLE_OPENDMARC: 1
      ENABLE_POLICYD_SPF: 1
      ENABLE_RSPAMD_REDIS: 1
      ENABLE_AMAVIS: 0
      ENABLE_SPAMASSASSIN: 0
      ENABLE_CLAMAV: 0
      ENABLE_FAIL2BAN: 1
      ENABLE_POSTGREY: 0
      OVERRIDE_HOSTNAME: mail.${domain}
      PERMIT_DOCKER: network
      ONE_DIR: 1
      ${sslEnv}
      POSTFIX_INET_PROTOCOLS: ipv4
      DOVECOT_INET_PROTOCOLS: ipv4
      TZ: UTC
    volumes:
      - ${hostDir}/data:/var/mail
      - ${hostDir}/state:/var/mail-state
      - ${hostDir}/logs:/var/log/mail
      - ${hostDir}/config:/tmp/docker-mailserver
${sslVolume}    cap_add:
      - NET_ADMIN
      - SYS_PTRACE
    healthcheck:
      test: ["CMD", "ss", "--listening", "--tcp", "|", "grep", "-P", "LISTEN.+:smtp"]
      interval: 30s
      timeout: 10s
      retries: 3
networks:
  dockcontrol-apps:
    external: true
    name: dockcontrol-apps
${sslExternalVolumes}`;
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);

    // Tag the on-disk stack with the version the boot reconciler compares
    // against. Write BEFORE compose up so even a partial failure leaves a
    // marker (next boot won't retry endlessly if compose itself is broken —
    // the run already errored visibly via lastError).
    try {
      fs.writeFileSync(
        path.join(dir, '.stack-version'),
        String(MailServerService.STACK_VERSION) + '\n',
      );
    } catch {}

    try {
      // Force-remove any stale container with this name. Happens when a prior
      // deploy crashed mid-flight or the mail_servers row was recreated with a
      // new serverId (different compose dir) but the old container survived.
      try { await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 30_000 }); } catch {}
      await execFileAsync('docker', ['compose', 'pull'], { cwd: dir, timeout: 600_000 });
      await execFileAsync('docker', ['compose', 'up', '-d'], { cwd: dir, timeout: 300_000 });
      // mark RUNNING after 5s grace (DMS bootstrap)
      setTimeout(async () => {
        try {
          await this.prisma.mailServer.update({
            where: { id: serverId },
            data: { status: 'RUNNING' },
          });
          // initial account sync
          const srv = await this.prisma.mailServer.findUnique({ where: { id: serverId } });
          if (srv) await this.syncAccounts(srv.domainId);
          // Reconcile any webmail apps (Roundcube/SnappyMail/Rainloop) that
          // were installed against this domain. Their compose was generated
          // with placeholder host.docker.internal because the mail server
          // didn't exist yet — restart them so they pick up the right host
          // + ports. Best-effort, never blocks the mail server deploy.
          await this.reconcileWebmails(serverId).catch(() => {});
        } catch {}
      }, 5000);
    } catch (err: any) {
      await this.prisma.mailServer.update({
        where: { id: serverId },
        data: {
          status: 'ERROR',
          lastError: (err?.stderr || err?.message || 'deploy failed').toString().slice(0, 4000),
        },
      });
    }
  }

  /**
   * Find the real name of the Caddy data volume created by the root compose.
   * Default name = <project>_caddy_data; <project> defaults to the parent dir
   * (e.g. "dockcontrol" on /opt/dockcontrol, "dockcontrol-dev" on a dev checkout).
   * Resolution priority:
   *   1. CADDY_DATA_VOLUME env var (explicit operator override)
   *   2. The volume currently mounted at /data inside the dockcontrol-caddy container
   *   3. First matching docker volume ending in _caddy_data
   *   4. Fallback to dockcontrol_caddy_data
   */
  private async resolveCaddyDataVolume(): Promise<string> {
    if (process.env.CADDY_DATA_VOLUME) return process.env.CADDY_DATA_VOLUME;
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['inspect', 'dockcontrol-caddy', '--format',
         '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}'],
        { timeout: 5000 },
      );
      const name = stdout.trim();
      if (name) return name;
    } catch {}
    try {
      const { stdout } = await execFileAsync(
        'docker', ['volume', 'ls', '--quiet', '--filter', 'name=_caddy_data$'],
        { timeout: 5000 },
      );
      const first = stdout.trim().split('\n').find(Boolean);
      if (first) return first;
    } catch {}
    return 'dockcontrol_caddy_data';
  }

  /**
   * Enumerate every host-side TCP port currently published by any running
   * docker container. Used by allocatePorts() as a safety net against orphan
   * containers whose mail_servers row was deleted but whose port bindings
   * persist (would otherwise cause "Bind for 0.0.0.0:X failed: port is already
   * allocated" on the next deploy).
   */
  private async listDockerHostPorts(): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync(
        'docker', ['ps', '--format', '{{.Ports}}'], { timeout: 5000 },
      );
      const ports = new Set<number>();
      // Sample line: "0.0.0.0:2525->25/tcp, [::]:2525->25/tcp, 0.0.0.0:2528->143/tcp"
      const re = /:(\d+)->/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stdout)) !== null) ports.add(parseInt(m[1], 10));
      return [...ports];
    } catch {
      return [];
    }
  }

  /**
   * Kick all live IMAP/POP3 sessions for a given email address on this
   * mail server. Used after a mailbox is deleted/renamed to terminate
   * any client that's still reading mail. Best-effort: if the container
   * isn't running, returns silently.
   */
  async kickMailboxSessions(domainId: string, address: string): Promise<void> {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) return;
    const containerName = `dockcontrol-mail-${domain.domain.replace(/\./g, '-')}`;
    try {
      await execFileAsync(
        'docker',
        ['exec', containerName, 'doveadm', 'kick', address],
        { timeout: 5_000 },
      );
    } catch {
      // Container down, doveadm not in PATH, no sessions — all fine.
    }
  }

  /**
   * Rewrite the compose file of every webmail app (Roundcube / SnappyMail /
   * Rainloop) linked to a freshly-deployed mail server, then `docker compose
   * up -d --force-recreate` it. Handles the install-order race: user installs
   * Roundcube before the mail server, Roundcube boots with placeholder values
   * and the SMTP/IMAP env vars are wrong. Re-templating from the live
   * mailServer + domain row brings everything into sync.
   */
  private async reconcileWebmails(mailServerId: string): Promise<void> {
    const server = await this.prisma.mailServer.findUnique({
      where: { id: mailServerId },
      include: { domain: { select: { id: true, domain: true } } },
    });
    if (!server || !server.domain) return;

    const WEBMAIL_NAMES = ['Roundcube', 'SnappyMail', 'Rainloop'];
    const apps = await this.prisma.application.findMany({
      where: {
        name: { in: WEBMAIL_NAMES },
        domains: { some: { id: server.domain.id } },
      },
      select: { id: true, name: true },
    });
    if (apps.length === 0) return;

    const mailHost = `mail.${server.domain.domain}`;
    for (const app of apps) {
      try {
        const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';
        const slug = slugify(app.name);
        const appDir = path.join(DATA_DIR, 'apps', `${slug}-${app.id.slice(0, 12)}`);
        const composePath = path.join(appDir, 'docker-compose.yml');
        if (!fs.existsSync(composePath)) continue;
        let content = fs.readFileSync(composePath, 'utf-8');

        // Replace any prior host (host.docker.internal or an old mail.<sub>)
        // with the current mail host + ports.
        const before = content;
        content = content
          .replace(/ROUNDCUBEMAIL_DEFAULT_HOST:\s*(?:ssl|tls|tcp):\/\/[^\s\n]+/g, `ROUNDCUBEMAIL_DEFAULT_HOST: ssl://${mailHost}`)
          .replace(/ROUNDCUBEMAIL_DEFAULT_PORT:\s*"?\d+"?/g, `ROUNDCUBEMAIL_DEFAULT_PORT: "${server.imapsPort}"`)
          .replace(/ROUNDCUBEMAIL_SMTP_SERVER:\s*(?:ssl|tls|tcp):\/\/[^\s\n]+/g, `ROUNDCUBEMAIL_SMTP_SERVER: tls://${mailHost}`)
          .replace(/ROUNDCUBEMAIL_SMTP_PORT:\s*"?\d+"?/g, `ROUNDCUBEMAIL_SMTP_PORT: "${server.submissionPort}"`);
        if (content === before) continue; // nothing to reconcile

        fs.writeFileSync(composePath, content);
        await execFileAsync('docker', ['compose', 'up', '-d', '--force-recreate'], { cwd: appDir, timeout: 180_000 });
      } catch (e: any) {
        this.logger.warn(`Webmail reconcile failed for app ${app.id}: ${e?.message || e}`);
      }
    }
  }

  /**
   * Check if a TCP port on the HOST is currently bound — by anything,
   * including non-Docker processes. Runs `ss` or `lsof` via `docker exec`
   * on a privileged sidecar... or actually no, we just try to listen on it
   * ourselves from the API container's network namespace... no, that's
   * the API container, not the host.
   *
   * Real approach: ask `docker run --rm --net host` to test for us. That
   * container shares the host network namespace, so a `nc -z` from inside
   * really probes the host port. Single docker exec, no extra deps on the
   * host (every install has `docker` and the `busybox` image).
   *
   * Returns false if the probe itself fails — we don't want to block deploys
   * on a flaky docker daemon; the user will see the real bind error later.
   */
  private async isHostPortOccupied(port: number): Promise<boolean> {
    try {
      // -z = scan only (no data), -w 1 = 1s timeout.
      // exit 0 → port is OPEN (something is listening) → occupied.
      // exit ≠ 0 → port refused → free.
      await execFileAsync(
        'docker',
        ['run', '--rm', '--network', 'host', 'busybox:latest', 'nc', '-zw', '1', '127.0.0.1', String(port)],
        { timeout: 10_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find free ports for this mail server.
   *
   * Inbound mail from the public Internet ALWAYS arrives on tcp/25 — that's
   * not configurable on the sender side. So the first mail server we deploy
   * gets the standard set (25/465/587/143/993). Additional mail servers
   * cannot share tcp/25 (only one process can bind a host port at a time);
   * we offset them to 2525+10*n. The DNS hints UI clearly marks those as
   * non-default so the operator knows there's only ever ONE inbound mail
   * server per host.
   */
  private async allocatePorts(
    domainId: string,
    existing: { smtpPort: number; submissionPort: number; smtpsPort: number; imapPort: number; imapsPort: number } | null,
  ) {
    if (existing) {
      return {
        smtp: existing.smtpPort,
        submission: existing.submissionPort,
        smtps: existing.smtpsPort,
        imap: existing.imapPort,
        imaps: existing.imapsPort,
      };
    }
    const others = await this.prisma.mailServer.findMany({
      where: { NOT: { domainId } },
      select: { smtpPort: true, submissionPort: true, smtpsPort: true, imapPort: true, imapsPort: true },
    });
    const used = new Set<number>();
    for (const o of others) {
      used.add(o.smtpPort);
      used.add(o.submissionPort);
      used.add(o.smtpsPort);
      used.add(o.imapPort);
      used.add(o.imapsPort);
    }
    // also include any ports currently bound on the docker host — guards against
    // orphan containers whose DB row was wiped (crash, manual cleanup, etc.).
    for (const p of await this.listDockerHostPorts()) used.add(p);

    // Try the canonical SMTP port set first. Anyone sending mail to us via
    // the public Internet hits tcp/25 — if it's free, take it.
    const standard = { smtp: 25, submission: 587, smtps: 465, imap: 143, imaps: 993 };
    const standardFree = Object.values(standard).every((p) => !used.has(p));
    if (standardFree) return standard;

    let base = 2525;
    while (
      used.has(base) || used.has(base + 1) || used.has(base + 2) ||
      used.has(base + 3) || used.has(base + 4)
    ) base += 10;
    return {
      smtp: base,
      submission: base + 1,
      smtps: base + 2,
      imap: base + 3,
      imaps: base + 4,
    };
  }
}
