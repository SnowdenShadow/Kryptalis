import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SftpService } from '../sftp/sftp.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { slugify } from '../applications/applications.helpers';
import * as crypto from 'crypto';

/**
 * Where to open an interactive shell for an app:
 *  - LOCAL  → `docker exec` on the platform host (node-pty, in the gateway).
 *  - REMOTE → SSH-bridge to the agent's :2522 shell channel, authenticating
 *             with a short-lived EPHEMERAL key-only account scoped to exactly
 *             this app's container.
 */
export type TerminalTarget =
  | { kind: 'local'; containerName: string }
  | {
      kind: 'remote';
      serverId: string; // for SSH host-key pinning (H-4)
      host: string;
      port: number;
      username: string;
      privateKey: string; // PEM, in-memory only — never persisted
      cleanup: () => Promise<void>;
    };

@Injectable()
export class TerminalService {
  private readonly logger = new Logger(TerminalService.name);

  constructor(
    private prisma: PrismaService,
    private sftp: SftpService,
  ) {}

  /**
   * Resolve the container name for an app, mirroring execCommand: the persisted
   * containerName wins; PHP_SITE nginx targets the `-fpm` sidecar (mod_php
   * Apache stays single-container).
   */
  private containerNameFor(app: {
    name: string;
    id: string;
    containerName: string | null;
    framework: string;
    phpWebServer?: string | null;
  }): string {
    let cname = app.containerName || `dockcontrol-${slugify(app.name)}-${app.id.slice(0, 12)}`;
    if (app.framework === 'PHP_SITE' && app.phpWebServer === 'nginx') cname = `${cname}-fpm`;
    return cname;
  }

  /**
   * Build a terminal target for `appId`. For a remote app this CREATES an
   * ephemeral, key-only SFTP account (allowShell + this container) on the
   * agent and returns its private key + a cleanup that deletes the account and
   * re-syncs. Caller MUST invoke cleanup() when the session ends.
   */
  async resolveTarget(appId: string, userId?: string): Promise<TerminalTarget> {
    const app = await this.prisma.application.findUnique({
      where: { id: appId },
      select: {
        id: true, name: true, containerName: true, framework: true, phpWebServer: true,
        server: { select: { id: true, host: true } },
      },
    });
    if (!app) throw new NotFoundException('Application not found');
    const containerName = this.containerNameFor(app);
    const server = app.server;

    if (!server || isLocalHost(server.host)) {
      return { kind: 'local', containerName };
    }

    // ── Remote: provision an ephemeral shell account on the agent. ──
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const sshPub = this.toOpenSshEd25519(publicKey);
    const username = `dcterm-${crypto.randomBytes(6).toString('hex')}`;

    const created = await this.sftp.createEphemeralShellAccount({
      username,
      applicationId: app.id,
      publicKey: sshPub,
      serverId: server.id,
      createdById: userId,
    });

    return {
      kind: 'remote',
      serverId: server.id,
      host: server.host,
      port: 2522,
      username,
      privateKey,
      cleanup: async () => {
        try {
          await this.sftp.removeEphemeralShellAccount(created.id, server.id);
        } catch (e: any) {
          this.logger.warn(`ephemeral terminal account cleanup failed: ${e?.message || e}`);
        }
      },
    };
  }

  /**
   * Convert a PEM SPKI ed25519 public key to an OpenSSH authorized_keys line.
   * Node's crypto exports SPKI; the agent (golang.org/x/crypto/ssh) parses the
   * `ssh-ed25519 AAAA…` wire format.
   */
  private toOpenSshEd25519(pemSpki: string): string {
    const der = crypto.createPublicKey(pemSpki).export({ type: 'spki', format: 'der' }) as Buffer;
    // The 32-byte raw key is the DER tail (SPKI ed25519 prefix is 12 bytes).
    const raw = der.subarray(der.length - 32);
    const type = Buffer.from('ssh-ed25519');
    const wire = Buffer.concat([
      this.sshString(type),
      this.sshString(raw),
    ]);
    return `ssh-ed25519 ${wire.toString('base64')}`;
  }

  private sshString(buf: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length, 0);
    return Buffer.concat([len, buf]);
  }
}
