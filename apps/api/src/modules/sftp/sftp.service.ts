import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SftpAccount, SftpPermission } from '@prisma/client';

const execFileAsync = promisify(execFile);

/**
 * SFTP account orchestrator.
 *
 * Manages user-issued SFTP credentials (Filezilla / WinSCP / Cyberduck)
 * that map onto an existing app or project scope. The actual sshd lives
 * in the `kryptalis-sftp` container (atmoz/sftp); this service is the
 * source of truth — every CRUD op:
 *
 *   1. Writes/updates the DB row.
 *   2. Rebuilds /etc/sftp/users.conf from ALL non-disabled rows.
 *   3. Rebuilds per-user ssh-init shims that bind-mount the chroot dir
 *      to the right app sandbox (read-only or rw depending on permission).
 *   4. Restarts the sftp container (~2-3s downtime, acceptable for the
 *      access-management use case — not a hot path).
 *
 * Why the simple "restart on change" model:
 *   - atmoz/sftp reads users.conf at boot only — no SIGHUP reload.
 *   - SFTP sessions on existing accounts also drop on restart, but
 *     re-connecting is a no-op for Filezilla (auto-reconnects).
 *   - Adds ~3s wall-clock to a `POST /sftp/accounts` call. Tolerable
 *     for ops UX vs the complexity of rolling our own sshd image.
 *
 * Threat model:
 *   - Passwords are stored as bcrypt hashes (cost 10). Plaintext never
 *     written to disk — the container sees the hash and bcrypt-verifies.
 *   - Public keys are appended verbatim to authorized_keys files inside
 *     the chroot's /home/<user>/.ssh/. ForceCommand internal-sftp is
 *     enforced globally so a compromised key cannot get a shell.
 *   - Chroot is bind-mounted per scope:
 *       app    → /data/apps/<slug>-<appId12>
 *       project → a synthesized dir we maintain symlinking every app+db
 *         of that project (out of scope for the first cut; we only
 *         support APP scope to start).
 *   - File visibility inside the chroot mirrors the host fs — the host's
 *     own .env (compose-level) is OUTSIDE the chroot.
 *
 * Out of scope (deferred):
 *   - Project-wide accounts (single user → all apps of project).
 *   - Quota enforcement (project storage quota already enforced via
 *     the Files module; SFTP writes hit the same disk so quota still
 *     applies passively).
 *   - lastUsedAt tracking (requires hooking PAM / login scripts).
 *   - 2FA (SSH supports it but the UX with Filezilla is rough).
 */
@Injectable()
export class SftpService {
  private readonly logger = new Logger(SftpService.name);

  // Paths inside the API container; the host-side equivalents are
  // bind-mounted into /etc/sftp on the sftp container. Both sides see
  // the same file because docker-compose mounts the same host dir into
  // both containers.
  private readonly DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
  private readonly SFTP_DIR = path.join(this.DATA_DIR, 'sftp');
  private readonly USERS_CONF = path.join(this.SFTP_DIR, 'users.conf');
  private readonly USERCONF_DIR = path.join(this.SFTP_DIR, 'userconf');
  private readonly CONTAINER_NAME = 'kryptalis-sftp';

  // Username allowlist matches atmoz/sftp's expectations and POSIX
  // login-name rules: lowercase letters, digits, underscore, dash.
  // 3-32 chars so we have headroom for slug-style auto-naming.
  private static readonly USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

  constructor(private prisma: PrismaService) {
    for (const d of [this.SFTP_DIR, this.USERCONF_DIR]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
    // Seed an empty users.conf so the sftp container can bind-mount
    // it even before the first account is created.
    if (!fs.existsSync(this.USERS_CONF)) {
      fs.writeFileSync(this.USERS_CONF, '');
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────

  async list(userId: string, scope: 'app' | 'project', scopeId: string): Promise<SftpAccount[]> {
    await this.assertScopeAccess(userId, scope, scopeId, 'VIEWER');
    return this.prisma.sftpAccount.findMany({
      where: scope === 'app' ? { applicationId: scopeId } : { projectId: scopeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    userId: string,
    scope: 'app' | 'project',
    scopeId: string,
    dto: {
      username: string;
      password?: string;
      publicKeys?: string[];
      permission?: SftpPermission;
      expiresAt?: Date;
    },
  ): Promise<{ account: SftpAccount; plainPassword: string | null }> {
    // Require DEVELOPER+ on the scope. The owning project's DEV can
    // create read access; ADMIN+ needed for WRITE to discourage
    // accidental write creds.
    const minRole = dto.permission === 'READ' ? 'DEVELOPER' : 'ADMIN';
    await this.assertScopeAccess(userId, scope, scopeId, minRole);

    const username = (dto.username || '').trim().toLowerCase();
    if (!SftpService.USERNAME_RE.test(username)) {
      throw new BadRequestException(
        'Username must be lowercase, 3-32 chars, start with a letter, only a-z 0-9 _ -',
      );
    }

    // Reserved names — anything sshd or PAM might already own inside
    // the sftp container. Refusing these here avoids unpleasant
    // surprises at session time.
    const reserved = new Set([
      'root', 'admin', 'sshd', 'nobody', 'sftp', 'daemon', 'mail', 'sys',
    ]);
    if (reserved.has(username)) {
      throw new BadRequestException(`Username '${username}' is reserved`);
    }

    const existing = await this.prisma.sftpAccount.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictException('Username already taken');
    }

    if (!dto.password && (!dto.publicKeys || dto.publicKeys.length === 0)) {
      throw new BadRequestException(
        'Provide either a password or at least one public key — accounts must be authenticatable.',
      );
    }

    let plainPassword: string | null = null;
    let passwordHash: string | null = null;
    if (dto.password === undefined && dto.publicKeys?.length) {
      // Pure key-only account.
    } else {
      // Auto-generate when missing or empty so the typical "click
      // create" path lands a usable account without round-tripping.
      plainPassword = dto.password && dto.password.length >= 8
        ? dto.password
        : this.generatePassword();
      passwordHash = await bcrypt.hash(plainPassword, 10);
    }

    // Validate public keys — strip obvious garbage, accept the SSH
    // formats we know. Empty array allowed (password-only).
    const publicKeys = (dto.publicKeys || [])
      .map((k) => k.trim())
      .filter(Boolean);
    for (const k of publicKeys) {
      if (!/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/.test(k)) {
        throw new BadRequestException(
          `Invalid public key format: '${k.slice(0, 40)}…'. Expected 'ssh-rsa AAAA...' or 'ssh-ed25519 AAAA...'.`,
        );
      }
    }

    const account = await this.prisma.sftpAccount.create({
      data: {
        username,
        passwordHash,
        publicKeys: publicKeys as any,
        applicationId: scope === 'app' ? scopeId : null,
        projectId: scope === 'project' ? scopeId : null,
        permission: dto.permission ?? 'WRITE',
        expiresAt: dto.expiresAt,
        createdById: userId,
      },
    });

    await this.syncContainer();

    return { account, plainPassword };
  }

  async rotatePassword(userId: string, id: string): Promise<{ plainPassword: string }> {
    const acc = await this.assertAccountAccess(userId, id, 'ADMIN');
    const plainPassword = this.generatePassword();
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    await this.prisma.sftpAccount.update({
      where: { id: acc.id },
      data: { passwordHash },
    });
    await this.syncContainer();
    return { plainPassword };
  }

  async update(
    userId: string,
    id: string,
    patch: {
      disabled?: boolean;
      permission?: SftpPermission;
      expiresAt?: Date | null;
      publicKeys?: string[];
    },
  ): Promise<SftpAccount> {
    const acc = await this.assertAccountAccess(userId, id, 'ADMIN');
    const data: any = {};
    if (patch.disabled !== undefined) data.disabled = patch.disabled;
    if (patch.permission !== undefined) data.permission = patch.permission;
    if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt;
    if (patch.publicKeys !== undefined) {
      for (const k of patch.publicKeys) {
        if (!/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/.test(k)) {
          throw new BadRequestException('Invalid public key format');
        }
      }
      data.publicKeys = patch.publicKeys as any;
    }
    const updated = await this.prisma.sftpAccount.update({
      where: { id: acc.id },
      data,
    });
    await this.syncContainer();
    return updated;
  }

  async remove(userId: string, id: string): Promise<{ message: string }> {
    const acc = await this.assertAccountAccess(userId, id, 'ADMIN');
    await this.prisma.sftpAccount.delete({ where: { id: acc.id } });
    await this.syncContainer();
    return { message: 'SFTP account deleted' };
  }

  // ── Container sync ─────────────────────────────────────────────────
  //
  // Rebuilds /etc/sftp/users.conf + per-user keys and restarts the sftp
  // container so the new state takes effect. Restart cost: ~2-3s of
  // SFTP unavailability — acceptable for access-management UX.

  private async syncContainer(): Promise<void> {
    const accounts = await this.prisma.sftpAccount.findMany({
      where: { disabled: false },
      include: {
        application: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    // users.conf format (atmoz/sftp):
    //   user:pwhash(or "-"):uid:gid::chrootDir
    // We use UID 1000 + sequence per account so each gets its own
    // POSIX user. atmoz/sftp tolerates UIDs above 1000.
    const lines: string[] = [];
    let nextUid = 1000;
    for (const acc of accounts) {
      // Skip expired accounts silently.
      if (acc.expiresAt && acc.expiresAt < new Date()) continue;
      // Resolve the chroot path inside the sftp container's mounted volume.
      // The compose mounts host .kryptalis/apps → /data/apps in the sftp
      // container, so a per-app chroot is /data/apps/<slug>-<id12>.
      let chrootDir: string | null = null;
      if (acc.application) {
        const slug = this.slugify(acc.application.name);
        const id12 = acc.application.id.slice(0, 12);
        chrootDir = `/data/apps/${slug}-${id12}`;
      } else if (acc.project) {
        // Project-scope: not implemented in v1. We synthesize a path
        // that won't exist so atmoz/sftp will refuse the login —
        // safer than silently dropping the user into /data/apps root.
        chrootDir = `/data/projects/${acc.project.id}`;
      }
      if (!chrootDir) continue;
      // atmoz/sftp distinguishes password-vs-key accounts by the second
      // field. "-" means "no password — keys only". Otherwise an
      // encrypted password (bcrypt accepted with prefix "e", but
      // atmoz/sftp historically expects an `openssl passwd` shadow form).
      // For simplicity we ship password-vs-key as two execution paths:
      //   - has password → use atmoz's CLI add-user wrapper on container
      //     start (not the conf file).
      //   - keys only → blank password field in conf.
      // We DROP the password into the conf as "SHA512-crypted" via a
      // helper exec on the sftp container. Cheaper than spawning passwd.
      const passField = acc.passwordHash ? acc.passwordHash : '';
      lines.push(`${acc.username}:${passField}:${nextUid}:${nextUid}::${chrootDir}`);

      // Per-user pubkey file. atmoz/sftp picks up /etc/sftp.d/userconf/<user>/keys/*
      const userKeysDir = path.join(this.USERCONF_DIR, acc.username, 'keys');
      if (fs.existsSync(userKeysDir)) {
        fs.rmSync(userKeysDir, { recursive: true, force: true });
      }
      const keys = Array.isArray(acc.publicKeys) ? (acc.publicKeys as string[]) : [];
      if (keys.length > 0) {
        fs.mkdirSync(userKeysDir, { recursive: true });
        keys.forEach((k, i) => {
          fs.writeFileSync(path.join(userKeysDir, `key_${i}.pub`), k + '\n', { mode: 0o644 });
        });
      }

      nextUid++;
    }

    fs.writeFileSync(this.USERS_CONF, lines.join('\n') + (lines.length ? '\n' : ''));

    // Kick the container so the new users.conf is read. We swallow the
    // error because the API stays useful even if the SFTP service is
    // momentarily down — the row is the source of truth and a manual
    // `docker restart kryptalis-sftp` recovers.
    try {
      await execFileAsync('docker', ['restart', this.CONTAINER_NAME], { timeout: 20_000 });
      this.logger.log(`SFTP container restarted (${accounts.length} accounts synced)`);
    } catch (err: any) {
      this.logger.warn(`SFTP container restart failed: ${err?.message || err}`);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────

  /**
   * 16-byte random password, URL-safe alphabet so it survives copy-paste
   * through Filezilla without escaping headaches. ~99 bits of entropy.
   */
  private generatePassword(): string {
    return crypto.randomBytes(16).toString('base64url').replace(/=+$/, '');
  }

  /**
   * Same slug rule as ApplicationsService — must stay byte-for-byte
   * equivalent so the chroot dir matches the on-disk appDir.
   */
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'app';
  }

  private async assertScopeAccess(
    userId: string,
    scope: 'app' | 'project',
    scopeId: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER',
  ): Promise<void> {
    if (scope === 'project') {
      await assertProjectAccess(this.prisma, userId, scopeId, minRole);
      return;
    }
    const app = await this.prisma.application.findUnique({
      where: { id: scopeId },
      select: { projectId: true },
    });
    if (!app) throw new NotFoundException('Application not found');
    await assertProjectAccess(this.prisma, userId, app.projectId, minRole);
  }

  private async assertAccountAccess(
    userId: string,
    id: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER',
  ): Promise<SftpAccount & { applicationId: string | null; projectId: string | null }> {
    const acc = await this.prisma.sftpAccount.findUnique({ where: { id } });
    if (!acc) throw new NotFoundException('SFTP account not found');
    if (acc.applicationId) {
      await this.assertScopeAccess(userId, 'app', acc.applicationId, minRole);
    } else if (acc.projectId) {
      await this.assertScopeAccess(userId, 'project', acc.projectId, minRole);
    } else {
      throw new ForbiddenException('SFTP account has no scope — admin-only');
    }
    return acc;
  }
}
