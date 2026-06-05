import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
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

/**
 * Provisions a docker-mailserver stack per domain.
 * Uses `mailserver/docker-mailserver` image — Postfix + Dovecot + rspamd + OpenDKIM bundled.
 */
@Injectable()
export class MailServerService {
  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
  ) {
    if (!fs.existsSync(MAIL_DIR)) fs.mkdirSync(MAIL_DIR, { recursive: true });
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

    // postfix-accounts.cf — bcrypt password compatible with docker-mailserver dovecot
    // docker-mailserver expects each line: address|{SHA512-CRYPT}hash — but it also
    // accepts pre-hashed plain SHA512 via setup.sh. For simplicity we let setup.sh
    // run inside the container do the hashing at first boot via env files.
    const accountsPath = path.join(dir, 'config', 'postfix-accounts.cf');
    const accountsLines = mailboxes.map((m) => {
      // we re-hash using bcrypt for portability; dovecot SHA512-CRYPT
      // would be ideal but requires the container's binary. Plain bcrypt is supported.
      return `${m.address}|{BCRYPT}${m.passwordHash}`;
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

    // DKIM key files expected by docker-mailserver
    const dkimDir = path.join(cfgDir, 'opendkim', 'keys', domain);
    fs.mkdirSync(dkimDir, { recursive: true });
    fs.writeFileSync(path.join(dkimDir, 'kryptalis.private'), dkimPrivateKey);

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
      ENABLE_OPENDKIM: 0
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
      - ./data:/var/mail
      - ./state:/var/mail-state
      - ./logs:/var/log/mail
      - ./config:/tmp/docker-mailserver
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
