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
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const MAIL_DIR = path.join(DATA_DIR, 'mail');
// When the API runs in a container, the docker daemon on the host resolves
// bind-mount source paths against the HOST filesystem, not the API container's
// filesystem. Set KRYPTALIS_HOST_DATA_DIR to the host path that the API's
// .kryptalis volume mounts FROM (e.g. /opt/kryptalis/.kryptalis) so generated
// compose files use the correct absolute host paths.
const HOST_DATA_DIR = process.env.KRYPTALIS_HOST_DATA_DIR || DATA_DIR;
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
      server.dkimPrivateKey,
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
    const containerName = `kryptalis-mail-${server.domain.domain.replace(/\./g, '-')}`;
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

    let server = await this.prisma.mailServer.findUnique({ where: { domainId } });

    // generate DKIM keypair if first time
    let dkimKey = server?.dkimPrivateKey;
    let dkimPub = server?.dkimPublicKey;
    if (!dkimKey || !dkimPub) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      dkimKey = privateKey;
      // extract base64 of public key for DNS TXT record
      const pubB64 = publicKey
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\s+/g, '');
      dkimPub = pubB64;
    }

    // claim a free port range
    const ports = await this.allocatePorts(domainId, server);

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
        dkimSelector: 'kryptalis',
        dkimPrivateKey: dkimKey,
        dkimPublicKey: dkimPub,
      },
      update: {
        status: 'DEPLOYING',
        dkimPrivateKey: dkimKey,
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
   * Internal cleanup — no auth check. Safe to call when the parent Domain row
   * is about to be deleted (cascade): tears down compose stack, removes the
   * container by name (covers orphans whose compose dir is missing), wipes
   * the on-disk dir, deletes the DB row. Idempotent.
   */
  async removeForDomain(domainId: string) {
    const server = await this.prisma.mailServer.findUnique({ where: { domainId } });
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    const containerName = domain
      ? `kryptalis-mail-${domain.domain.replace(/\./g, '-')}`
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

    // postfix-accounts.cf — dovecot reads bcrypt hashes via {CRYPT} (the generic
    // crypt(3) scheme, which recognizes $2y$ / $2a$ / $2b$ bcrypt prefixes).
    // Dovecot does NOT have a {BCRYPT} scheme — that name is rejected with
    // "Unknown scheme BCRYPT" and every login fails. Also normalize the legacy
    // $2a$/$2b$ identifier to $2y$, which is what crypt_blowfish (dovecot's
    // backend) expects. The hash payload is byte-compatible across $2a/$2b/$2y.
    const accountsPath = path.join(dir, 'config', 'postfix-accounts.cf');
    const accountsLines = mailboxes.map((m) => {
      const hash = m.passwordHash.replace(/^\$2[ab]\$/, '$2y$');
      return `${m.address}|{CRYPT}${hash}`;
    });
    fs.writeFileSync(accountsPath, accountsLines.join('\n') + '\n');

    const virtualPath = path.join(dir, 'config', 'postfix-virtual.cf');
    const virtualLines: string[] = [];
    for (const f of forwards) virtualLines.push(`${f.address}  ${f.forwardTo}`);
    for (const a of aliases) {
      const dest = a.mailbox?.address || a.forwardTo;
      if (dest) virtualLines.push(`${a.address}  ${dest}`);
    }
    fs.writeFileSync(virtualPath, virtualLines.join('\n') + '\n');

    // reload postfix in-place if container is running
    const containerName = `kryptalis-mail-${domain.domain.replace(/\./g, '-')}`;
    try {
      await execFileAsync('docker', ['exec', containerName, 'postfix', 'reload'], { timeout: 5000 });
    } catch {}
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
    fs.writeFileSync(path.join(dkimKeyDir, 'kryptalis.private'), cleanKey);
    try { fs.chmodSync(path.join(dkimKeyDir, 'kryptalis.private'), 0o600); } catch {}

    fs.writeFileSync(
      path.join(opendkimDir, 'KeyTable'),
      `kryptalis._domainkey.${domain} ${domain}:kryptalis:/etc/opendkim/keys/${domain}/kryptalis.private\n`,
    );
    fs.writeFileSync(
      path.join(opendkimDir, 'SigningTable'),
      `*@${domain} kryptalis._domainkey.${domain}\n`,
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

    const containerName = `kryptalis-mail-${domain.replace(/\./g, '-')}`;
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
      : `      - kryptalis_caddy_data:/caddy-certs:ro\n`;
    // The Caddy data volume is created by the root docker-compose. Its real
    // name is <project>_caddy_data where <project> is the compose project
    // (usually the parent dir name: "kryptalis" on /opt/kryptalis, but could
    // be "kryptalis-dev" in dev). Resolve it dynamically by introspecting the
    // running kryptalis-caddy container, with sensible env-var override.
    const caddyDataVolumeName = isLocal ? '' : await this.resolveCaddyDataVolume();
    const sslExternalVolumes = isLocal
      ? ''
      : `\nvolumes:\n  kryptalis_caddy_data:\n    external: true\n    name: ${caddyDataVolumeName}\n`;

    const compose = `services:
  mailserver:
    image: ghcr.io/docker-mailserver/docker-mailserver:latest
    container_name: ${containerName}
    hostname: mail.${domain}
    restart: unless-stopped
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
   * (e.g. "kryptalis" on /opt/kryptalis, "kryptalis-dev" on a dev checkout).
   * Resolution priority:
   *   1. CADDY_DATA_VOLUME env var (explicit operator override)
   *   2. The volume currently mounted at /data inside the kryptalis-caddy container
   *   3. First matching docker volume ending in _caddy_data
   *   4. Fallback to kryptalis_caddy_data
   */
  private async resolveCaddyDataVolume(): Promise<string> {
    if (process.env.CADDY_DATA_VOLUME) return process.env.CADDY_DATA_VOLUME;
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['inspect', 'kryptalis-caddy', '--format',
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
    return 'kryptalis_caddy_data';
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
   * Find free ports for this mail server. Default smtp=25 must be on host,
   * but we offset each new domain by +10 to avoid collisions in dev/local.
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
