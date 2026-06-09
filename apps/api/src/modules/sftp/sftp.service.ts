import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SftpAccount, SftpPermission } from '@prisma/client';

const execFileAsync = promisify(execFile);

/**
 * SFTP account orchestrator.
 *
 * Talks to the `kryptalis-sftp` container over the host docker socket:
 *
 *   docker exec kryptalis-sftp useradd  -m -d <home> -s /bin/false -G sftpusers ...
 *   docker exec kryptalis-sftp chpasswd
 *   docker exec kryptalis-sftp userdel  -r ...
 *
 * Account state lives in two places:
 *
 *   1. Kryptalis DB row (source of truth — owns RBAC, audit, expiry).
 *   2. Container /etc/passwd + /etc/shadow + /home/<user>/ + per-user
 *      sshd_config drop-in, persisted across restarts via named volumes
 *      sftp_users + sftp_homes.
 *
 * On boot we walk every row in the DB and re-apply it to the container,
 * so a container recreate (image rebuild, host reboot) doesn't drop
 * accounts. Container-side drift is reconciled to the DB, never the
 * other way around.
 *
 * Threat model:
 *   - Kryptalis-internal credentials use bcrypt (`passwordHash`).
 *   - sshd authenticates via PAM/crypt(3) against /etc/shadow inside
 *     the container — set via `chpasswd` (SHA-512 crypt entry).
 *   - Plaintext is AES-256-GCM at rest (`passwordEnc`) under the
 *     platform's ENCRYPTION_KEY, kept only so we can re-apply via
 *     chpasswd after a container recreate. Compromised DB without the
 *     key reveals neither bcrypt nor plaintext.
 *   - Chroot is enforced per-user in /etc/ssh/sshd_config.d/<user>.conf
 *     (the historic global `Match Group sftpusers` block shadowed those
 *     includes — sshd matches first-wins — and was removed).
 *   - READ permission is enforced by `internal-sftp -R` in the dropin,
 *     which makes the entire chroot read-only at the SFTP layer.
 *   - Every account ships with /bin/false as the login shell — even if
 *     ForceCommand were bypassed there's no shell to invoke.
 */
@Injectable()
export class SftpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SftpService.name);
  private readonly CONTAINER_NAME = 'kryptalis-sftp';

  // Username must start with a letter, then 2-31 of [a-z 0-9 _ -].
  // Useradd would accept more, but we want a tight surface for the
  // string that ends up in a shell-rendered sshd_config Match block.
  private static readonly USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

  // Public key format — strict enough to refuse a passphrase comment
  // containing newlines (which would break authorized_keys parsing).
  private static readonly PUBKEY_RE = /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/;

  // Container names follow our deploy naming convention. Used as a
  // defence in depth around `docker inspect`.
  private static readonly CONTAINER_NAME_RE = /^[a-z0-9_-]{1,64}$/;

  // Docker volume names: alphanumerics + _ - . The daemon would refuse
  // path-traversal anyway but we don't want to rely on that.
  private static readonly VOLUME_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

  // Filesystem paths we accept as a chroot target. No spaces, no shell
  // metacharacters, no `..`. The daemon validates ownership/modes on
  // top of this; we just want any bad row to fail closed.
  private static readonly CHROOT_PATH_RE = /^[A-Za-z0-9/_.-]+$/;

  private static readonly RESERVED_USERNAMES = new Set([
    'root', 'admin', 'sshd', 'nobody', 'sftp', 'daemon',
    'mail', 'sys', 'sftpusers', 'bin', 'operator',
  ]);

  // Cheap periodic sweep for expired accounts. ScheduleModule isn't
  // wired into the app, so we drive it ourselves with a setInterval.
  private expirySweepTimer: NodeJS.Timeout | null = null;
  private readonly EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    // Best-effort resync. If the container isn't up yet (boot ordering,
    // image rebuild in progress) we just log and let the next CRUD or
    // the periodic sweep heal things — we MUST NOT block API startup
    // on the SFTP daemon's availability.
    this.resyncFromDb().catch((e) =>
      this.logger.warn(`sftp resync on boot failed: ${e?.message || e}`),
    );
    this.expirySweepTimer = setInterval(
      () => void this.sweepExpired().catch((e) =>
        this.logger.warn(`sftp expiry sweep failed: ${e?.message || e}`),
      ),
      this.EXPIRY_SWEEP_INTERVAL_MS,
    );
    // Don't keep the event loop alive just for this — Node should be
    // free to exit during a graceful shutdown.
    this.expirySweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.expirySweepTimer) clearInterval(this.expirySweepTimer);
    this.expirySweepTimer = null;
  }

  // ── Read paths ────────────────────────────────────────────────────

  async list(userId: string, scope: 'app' | 'project', scopeId: string): Promise<SftpAccount[]> {
    await this.assertScopeAccess(userId, scope, scopeId, 'VIEWER');
    return this.prisma.sftpAccount.findMany({
      where: scope === 'app' ? { applicationId: scopeId } : { projectId: scopeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Mutating paths ────────────────────────────────────────────────

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
    // Read-only callers need DEVELOPER; anything that can write to the
    // app's data needs ADMIN. (READ is enforced at the sshd layer; the
    // role gate is a separate, conservative check on who can issue
    // them.)
    const minRole = dto.permission === 'READ' ? 'DEVELOPER' : 'ADMIN';
    await this.assertScopeAccess(userId, scope, scopeId, minRole);

    const username = (dto.username || '').trim().toLowerCase();
    this.assertUsernameValid(username);

    const existing = await this.prisma.sftpAccount.findUnique({ where: { username } });
    if (existing) throw new ConflictException('Username already taken');

    const publicKeys = this.normalizePublicKeys(dto.publicKeys);

    if (!dto.password && publicKeys.length === 0) {
      throw new BadRequestException(
        'Provide either a password or at least one public key — accounts must be authenticatable.',
      );
    }

    // Always derive a password if the caller didn't pass keys, so
    // the account stays usable from Filezilla. If keys ARE provided
    // and no password is asked for, leave it null (key-only).
    let plainPassword: string | null = null;
    let passwordHash: string | null = null;
    let passwordEnc: string | null = null;
    if (dto.password !== undefined || publicKeys.length === 0) {
      plainPassword = dto.password && dto.password.length >= 8
        ? dto.password
        : this.generatePassword();
      passwordHash = await bcrypt.hash(plainPassword, 10);
      passwordEnc = this.encryption.encrypt(plainPassword);
    }

    // Resolve chroot BEFORE creating the row — if the app has never
    // been deployed there's nothing to FTP into, and we don't want a
    // phantom DB row blocking the username.
    const chrootSource = await this.resolveChrootSource(scope, scopeId);

    const account = await this.prisma.sftpAccount.create({
      data: {
        username,
        passwordHash,
        passwordEnc,
        publicKeys: publicKeys as any,
        applicationId: scope === 'app' ? scopeId : null,
        projectId: scope === 'project' ? scopeId : null,
        permission: dto.permission ?? 'WRITE',
        expiresAt: dto.expiresAt,
        createdById: userId,
      },
    });

    try {
      await this.applyAccountToContainer({
        username,
        plainPassword,
        publicKeys,
        chrootSource,
        permission: account.permission,
        disabled: false,
      });
    } catch (err: any) {
      // Roll back the DB row so the username doesn't get stuck. We log
      // ABOVE the rollback so the failed apply is captured even if the
      // delete also throws.
      this.logger.error(`Container apply failed for ${username}: ${err?.message || err}`);
      await this.prisma.sftpAccount.delete({ where: { id: account.id } }).catch(() => {});
      throw new BadRequestException(`SFTP container rejected the account: ${err?.message || err}`);
    }

    await this.audit(userId, 'create', account.id, username, {
      scope, scopeId, permission: account.permission, hasKeys: publicKeys.length,
    });

    return { account, plainPassword };
  }

  async rotatePassword(userId: string, id: string): Promise<{ plainPassword: string }> {
    const acc = await this.assertAccountAccess(userId, id, 'ADMIN');
    const plainPassword = this.generatePassword();
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    const passwordEnc = this.encryption.encrypt(plainPassword);

    // Order matters: apply to container FIRST, then persist. If the
    // container fails, the old password keeps working — better than
    // a DB out of sync with sshd (user thinks the rotation worked).
    await this.execChpasswd(acc.username, plainPassword);
    await this.prisma.sftpAccount.update({
      where: { id: acc.id },
      data: { passwordHash, passwordEnc },
    });

    await this.audit(userId, 'rotate', acc.id, acc.username);
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

    const data: Record<string, unknown> = {};
    if (patch.disabled !== undefined) data.disabled = patch.disabled;
    if (patch.permission !== undefined) data.permission = patch.permission;
    if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt;
    if (patch.publicKeys !== undefined) {
      data.publicKeys = this.normalizePublicKeys(patch.publicKeys) as any;
    }

    // Compute the desired final state by overlaying the patch on the
    // current row, then re-apply atomically. This collapses
    // disabled/permission/keys changes into a single dropin rewrite +
    // single SIGHUP, instead of N piecemeal exec calls.
    const next: SftpAccount = { ...acc, ...(data as Partial<SftpAccount>) };

    if (patch.publicKeys !== undefined) {
      await this.writeAuthorizedKeys(acc.username, patch.publicKeys);
    }

    if (patch.disabled !== undefined) {
      await this.dockerExec(
        ['usermod', patch.disabled ? '-L' : '-U', acc.username],
        { allowFailure: true, timeoutMs: 10_000 },
      );
    }

    if (patch.permission !== undefined || patch.disabled !== undefined) {
      // Permission and disabled state both live in the dropin; rewrite
      // it once. Chroot source doesn't change so we re-resolve only
      // when the app's deploy mode changes (separate code path).
      const chrootSource = await this.resolveChrootSourceForAccount(acc);
      await this.writeUserDropin(acc.username, chrootSource, next.permission, next.disabled);
      await this.reloadSshd();
    }

    const updated = await this.prisma.sftpAccount.update({
      where: { id: acc.id },
      data,
    });

    await this.audit(
      userId,
      patch.disabled === true ? 'disable' : patch.disabled === false ? 'enable' : 'update',
      acc.id, acc.username,
      {
        ...(patch.permission !== undefined && { permission: patch.permission }),
        ...(patch.expiresAt !== undefined && { expiresAt: patch.expiresAt }),
        ...(patch.publicKeys !== undefined && { keysCount: patch.publicKeys.length }),
      },
    );

    return updated;
  }

  async remove(userId: string, id: string): Promise<{ message: string }> {
    const acc = await this.assertAccountAccess(userId, id, 'ADMIN');
    await this.removeAccountFromContainer(acc.username);
    await this.prisma.sftpAccount.delete({ where: { id: acc.id } });
    await this.audit(userId, 'delete', acc.id, acc.username);
    return { message: 'SFTP account deleted' };
  }

  // ── Sync / sweep ──────────────────────────────────────────────────

  /**
   * Re-apply every DB row to the container. Idempotent — useradd
   * complaints about an existing user are tolerated; the dropin is
   * always rewritten so any drift is corrected.
   */
  private async resyncFromDb(): Promise<void> {
    const rows = await this.prisma.sftpAccount.findMany();
    if (!rows.length) return;
    this.logger.log(`Resyncing ${rows.length} SFTP account(s) to container`);
    for (const row of rows) {
      try {
        const chrootSource = await this.resolveChrootSourceForAccount(row).catch(() => null);
        if (!chrootSource) {
          this.logger.warn(`Skipping resync of ${row.username} — chroot source unresolved`);
          continue;
        }
        const plain = row.passwordEnc ? this.encryption.decrypt(row.passwordEnc) : null;
        const keys = Array.isArray(row.publicKeys) ? (row.publicKeys as unknown as string[]) : [];
        const expired = !!row.expiresAt && row.expiresAt.getTime() <= Date.now();
        await this.applyAccountToContainer({
          username: row.username,
          plainPassword: plain,
          publicKeys: keys,
          chrootSource,
          permission: row.permission,
          disabled: row.disabled || expired,
        });
      } catch (err: any) {
        this.logger.warn(`Resync ${row.username} failed: ${err?.message || err}`);
      }
    }
  }

  /**
   * Periodic sweep: lock any account whose expiresAt is in the past.
   * We don't delete rows — operators need the audit trail and may want
   * to extend the expiry instead.
   */
  private async sweepExpired(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.sftpAccount.findMany({
      where: { expiresAt: { lte: now }, disabled: false },
    });
    if (!expired.length) return;
    this.logger.log(`Auto-disabling ${expired.length} expired SFTP account(s)`);
    for (const row of expired) {
      try {
        await this.dockerExec(
          ['usermod', '-L', row.username],
          { allowFailure: true, timeoutMs: 10_000 },
        );
        await this.prisma.sftpAccount.update({
          where: { id: row.id },
          data: { disabled: true },
        });
        await this.audit('system', 'disable', row.id, row.username, { reason: 'expired' });
      } catch (err: any) {
        this.logger.warn(`Sweep of ${row.username} failed: ${err?.message || err}`);
      }
    }
  }

  // ── Audit ─────────────────────────────────────────────────────────

  /**
   * Append an AuditLog row. Failures are swallowed — we never want to
   * roll back a successful CRUD because of a logging blip — but logged
   * loudly so ops can investigate.
   */
  private async audit(
    userId: string,
    action: 'create' | 'rotate' | 'disable' | 'enable' | 'update' | 'delete',
    accountId: string,
    username: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await (this.prisma as any).auditLog?.create?.({
        data: {
          userId,
          resourceType: 'sftp_account',
          resourceId: accountId,
          action: `sftp.${action}`,
          metadata: { username, ...extra },
        },
      });
    } catch (e: any) {
      this.logger.warn(`audit log failed for sftp.${action} ${username}: ${e?.message || e}`);
    }
  }

  // ── Docker shell wrapper ─────────────────────────────────────────

  /**
   * Centralises every `docker exec kryptalis-sftp …` call. Uses
   * `execFile` (NOT a shell), and refuses any arg containing a null
   * byte or newline. `execFile` doesn't spawn a shell so injection
   * isn't possible by construction, but the explicit check catches
   * future regressions (someone wraps a call in `bash -c`).
   *
   * The `stdin` option pipes plaintext into the child — used for
   * chpasswd and writing files via `cat >`. Keeps secrets out of the
   * host process list (`/proc/<pid>/cmdline`).
   */
  private async dockerExec(
    args: string[],
    opts: { stdin?: string; timeoutMs?: number; allowFailure?: boolean } = {},
  ): Promise<string> {
    for (const a of args) {
      if (typeof a !== 'string' || a.includes('\0') || a.includes('\n')) {
        throw new BadRequestException('Refusing docker exec arg with null/newline');
      }
    }
    const timeout = opts.timeoutMs ?? 15_000;
    try {
      if (opts.stdin !== undefined) {
        return await new Promise<string>((resolve, reject) => {
          const child = execFile(
            'docker',
            ['exec', '-i', this.CONTAINER_NAME, ...args],
            { timeout },
            (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
          );
          child.stdin!.end(opts.stdin);
        });
      }
      const { stdout } = await execFileAsync(
        'docker', ['exec', this.CONTAINER_NAME, ...args],
        { timeout },
      );
      return stdout;
    } catch (err: any) {
      if (opts.allowFailure) {
        this.logger.warn(`docker exec ${args[0]} failed: ${err?.message || err}`);
        return '';
      }
      throw err;
    }
  }

  // ── Container ops ─────────────────────────────────────────────────

  /**
   * Project the DB row into the SFTP container. Steps:
   *
   *   1. Create the unix user (idempotent — re-running on an existing
   *      user is tolerated).
   *   2. Write the per-user sshd_config drop-in (chroot, sftp-lock,
   *      RO flag for READ permission, blanket disable when locked).
   *   3. Tighten ownership/modes on the chroot leaf to satisfy sshd
   *      (ChrootDirectory MUST be root-owned mode 0755 or sshd refuses
   *      with "bad ownership or modes for chroot directory").
   *   4. Set the password (chpasswd over stdin).
   *   5. Write authorized_keys.
   *   6. SIGHUP sshd so the new drop-in is loaded mid-flight.
   */
  private async applyAccountToContainer(opts: {
    username: string;
    plainPassword: string | null;
    publicKeys: string[];
    chrootSource: string;
    permission: SftpPermission;
    disabled: boolean;
  }): Promise<void> {
    const { username, plainPassword, publicKeys, chrootSource, permission, disabled } = opts;

    // Final guard before shelling out. Every caller already validates,
    // but we never want the wrong string to end up in a Match block:
    // the chroot leaf would be wrong, sshd would refuse, and the
    // user's session would tarpit through every failure attempt.
    this.assertUsernameValid(username);
    this.assertChrootPathSafe(chrootSource);

    const home = `/home/${username}`;

    // 1. Create the user.
    //    -m            create home dir (used only for .ssh/authorized_keys)
    //    -d <home>     pin home location
    //    -s /bin/false defence in depth — no shell EVER
    //    -G sftpusers  marks the user as SFTP-only (informational —
    //                  sshd_config no longer matches on the group; the
    //                  per-user dropin owns the policy)
    try {
      await this.dockerExec(
        ['useradd', '-m', '-d', home, '-s', '/bin/false', '-G', 'sftpusers', username],
        { timeoutMs: 15_000 },
      );
    } catch (err: any) {
      if (!String(err?.message || err).includes('already exists')) throw err;
    }

    // 2. Per-user sshd_config drop-in.
    await this.writeUserDropin(username, chrootSource, permission, disabled);

    // 3. Tighten chroot leaf ownership.
    await this.prepareChrootLeaf(username, chrootSource);

    // 4. Password.
    if (plainPassword) await this.execChpasswd(username, plainPassword);

    // 5. authorized_keys.
    await this.writeAuthorizedKeys(username, publicKeys);

    // 6. Reload sshd so the new dropin is picked up. SIGHUP re-reads
    //    config without dropping existing sessions.
    await this.reloadSshd();
  }

  private async removeAccountFromContainer(username: string): Promise<void> {
    this.assertUsernameValid(username);
    // userdel -r removes the home dir; we also drop the per-user
    // dropin and SIGHUP sshd so any reused username never matches a
    // stale ChrootDirectory. Errors swallowed — desired end-state is
    // "user gone" regardless of intermediate failures.
    await this.dockerExec(
      ['userdel', '-r', '-f', username],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    // rm by absolute path (no glob, no shell expansion needed) so we
    // don't drag in `sh -c`. The path is fixed and the username is
    // already regex-validated.
    await this.dockerExec(
      ['rm', '-f', `/etc/ssh/sshd_config.d/${username}.conf`],
      { allowFailure: true, timeoutMs: 5_000 },
    );
    await this.reloadSshd();
  }

  /**
   * Compose the per-user dropin. Each block sets:
   *   - ChrootDirectory: the resolved app data path inside the SFTP
   *     container.
   *   - ForceCommand: internal-sftp (+ `-R` for READ-only accounts).
   *     `-R` tells the SFTP subsystem to refuse every write op
   *     server-side; this is the layer that actually enforces READ.
   *   - DenyUsers: when the account is disabled, sshd refuses login
   *     before PAM is even consulted. Belt + suspenders with the
   *     usermod -L we already did.
   *   - Forwarding blanket-off: tcp/X11/agent/tun/pty — none of these
   *     are needed for SFTP and they each widen the blast radius if
   *     compromised.
   */
  private async writeUserDropin(
    username: string,
    chrootSource: string,
    permission: SftpPermission,
    disabled: boolean,
  ): Promise<void> {
    this.assertUsernameValid(username);
    this.assertChrootPathSafe(chrootSource);
    const dropinPath = `/etc/ssh/sshd_config.d/${username}.conf`;
    const forceCmd = permission === 'READ'
      ? 'internal-sftp -l VERBOSE -R'
      : 'internal-sftp -l VERBOSE';
    const lines: string[] = [];
    if (disabled) {
      // Refuse login at the protocol level. We keep the Match block
      // so the username still resolves to a clear "DenyUsers" log
      // line instead of "no such user".
      lines.push(`DenyUsers ${username}`);
    }
    lines.push(
      `Match User ${username}`,
      `  ChrootDirectory ${chrootSource}`,
      `  ForceCommand ${forceCmd}`,
      `  AllowTcpForwarding no`,
      `  X11Forwarding no`,
      `  AllowAgentForwarding no`,
      `  PermitTunnel no`,
      `  PermitTTY no`,
    );
    const body = lines.join('\n') + '\n';
    // Write via stdin so the secret-less body still avoids the host
    // process list (and our null/newline arg guard never sees the
    // dropin contents on argv).
    await this.dockerExec(
      ['sh', '-c', `mkdir -p /etc/ssh/sshd_config.d && cat > ${dropinPath} && chmod 0644 ${dropinPath}`],
      { stdin: body, timeoutMs: 10_000 },
    );
  }

  /**
   * sshd's ChrootDirectory requires the LEAF to be owned by root with
   * mode <= 0755. Files INSIDE the leaf need to be readable (and, for
   * WRITE accounts, writable) by the SFTP user — they're typically
   * owned by an app's runtime user (e.g. www-data uid 33), so we add
   * the SFTP uid to their group via `chgrp` and `chmod g+rX`.
   *
   * find … -mindepth 1 -maxdepth 1 -exec chgrp +
   *   - mindepth 1: skip the leaf itself (we just chowned it root)
   *   - maxdepth 1: don't recurse — too slow on large code trees;
   *     children's groups inherit on creation, and chmod g+rX takes
   *     care of perms.
   */
  private async prepareChrootLeaf(username: string, chrootSource: string): Promise<void> {
    this.assertUsernameValid(username);
    this.assertChrootPathSafe(chrootSource);
    const uidOut = await this.dockerExec(['id', '-u', username], { timeoutMs: 5_000 });
    const uid = uidOut.trim();
    if (!/^\d+$/.test(uid)) {
      throw new BadRequestException(`Could not resolve uid for ${username}`);
    }
    await this.dockerExec(
      ['sh', '-c',
        `chown root:root ${chrootSource} && chmod 0755 ${chrootSource} && ` +
        `find ${chrootSource} -mindepth 1 -maxdepth 1 -exec chgrp -h ${uid} {} + 2>/dev/null || true && ` +
        `chmod -R g+rX ${chrootSource}/ 2>/dev/null || true`,
      ],
      { timeoutMs: 30_000, allowFailure: true },
    );
  }

  private async reloadSshd(): Promise<void> {
    // pkill -HUP is the cleanest reload signal — sshd re-execs and
    // re-reads its config without dropping live sessions. `|| true`
    // tolerates the (rare) case where sshd isn't running.
    await this.dockerExec(
      ['sh', '-c', 'pkill -HUP sshd || true'],
      { allowFailure: true, timeoutMs: 5_000 },
    );
  }

  private async execChpasswd(username: string, plainPassword: string): Promise<void> {
    // chpasswd reads "user:password" on stdin. stdin (not argv) keeps
    // the password out of /proc/<pid>/cmdline.
    await this.dockerExec(['chpasswd'], {
      stdin: `${username}:${plainPassword}\n`,
      timeoutMs: 15_000,
    });
  }

  private async writeAuthorizedKeys(username: string, keys: string[]): Promise<void> {
    this.assertUsernameValid(username);
    const home = `/home/${username}`;
    // Trailing newline only if there are keys, so an empty key set
    // truncates the file to zero bytes (rather than leaving a stale
    // last entry from a previous write).
    const content = keys.join('\n') + (keys.length ? '\n' : '');
    await this.dockerExec(
      ['sh', '-c',
        `mkdir -p ${home}/.ssh && ` +
        `chmod 0700 ${home}/.ssh && ` +
        `cat > ${home}/.ssh/authorized_keys && ` +
        `chmod 0600 ${home}/.ssh/authorized_keys && ` +
        `chown -R ${username}:${username} ${home}/.ssh`,
      ],
      { stdin: content, timeoutMs: 10_000 },
    );
  }

  // ── Chroot resolution ────────────────────────────────────────────

  /**
   * Resolve the host-side path we'll point ChrootDirectory at. Two
   * cases mirror FilesService.resolveDockerTarget:
   *
   *   - Git deploys / Compose Empty / Dockerfile Empty: appDir on the
   *     host holds real source code → mount it as-is.
   *
   *   - Marketplace / Docker image: appDir holds only docker-compose
   *     plumbing; real app code lives in a Docker-managed named volume
   *     (PrestaShop's /var/www/html, etc.) → resolve that volume's
   *     host mountpoint instead so SFTP users see the live app files.
   */
  private async resolveChrootSource(scope: 'app' | 'project', scopeId: string): Promise<string> {
    if (scope !== 'app') {
      throw new BadRequestException('Project-scope SFTP not implemented yet — pick a specific app.');
    }
    const app = await this.prisma.application.findUnique({
      where: { id: scopeId },
      select: { name: true, id: true, dockerImage: true, containerName: true },
    });
    if (!app) throw new NotFoundException('Application not found');
    return this.computeChrootSourceForApp(app);
  }

  private async resolveChrootSourceForAccount(acc: SftpAccount): Promise<string> {
    if (!acc.applicationId) {
      throw new BadRequestException('Project-scope SFTP not implemented yet');
    }
    const app = await this.prisma.application.findUnique({
      where: { id: acc.applicationId },
      select: { name: true, id: true, dockerImage: true, containerName: true },
    });
    if (!app) throw new NotFoundException('Application not found');
    return this.computeChrootSourceForApp(app);
  }

  private async computeChrootSourceForApp(
    app: { name: string; id: string; dockerImage: string | null; containerName: string | null },
  ): Promise<string> {
    const slug = this.slugify(app.name);
    const id12 = app.id.slice(0, 12);

    // Path inside the sftp container. docker-compose maps host
    // .kryptalis/apps → /data/apps.
    const hostFsPath = `/data/apps/${slug}-${id12}`;

    // No live container → fall back to host-fs (git deploys land
    // there before/without ever being containerised).
    if (!app.containerName) return hostFsPath;

    const containerSrc = await this.discoverContainerCodePath(app.containerName, app.dockerImage);
    return containerSrc ?? hostFsPath;
  }

  /**
   * Find the host-side mountpoint of the container path that holds the
   * app's actual code. `docker inspect` the container, match its
   * Destination against a small map of well-known web roots, then map
   * to the volume's host path (reachable via the SFTP container's
   * /data/volumes bind mount).
   *
   * Returns null when nothing matches → caller falls back to host-fs.
   */
  private async discoverContainerCodePath(
    containerName: string,
    image: string | null,
  ): Promise<string | null> {
    const ROOT_MAP: Array<[RegExp, string]> = [
      [/prestashop/, '/var/www/html'],
      [/wordpress/, '/var/www/html'],
      [/ghost/, '/var/lib/ghost/content'],
      [/nextcloud/, '/var/www/html'],
      [/gitea/, '/data'],
      [/nginx/, '/usr/share/nginx/html'],
    ];
    const lc = (image || containerName).toLowerCase();
    const match = ROOT_MAP.find(([re]) => re.test(lc));
    if (!match) return null;
    const containerDest = match[1];

    if (!SftpService.CONTAINER_NAME_RE.test(containerName)) {
      this.logger.warn(`Refusing to inspect malformed container name: ${containerName}`);
      return null;
    }

    try {
      const { stdout } = await execFileAsync(
        'docker', ['inspect', '--format', '{{json .Mounts}}', containerName],
        { timeout: 5_000 },
      );
      const mounts: Array<{ Type: string; Source: string; Destination: string; Name?: string }>
        = JSON.parse(stdout);
      const found = mounts.find((m) => m.Destination === containerDest);
      if (!found) return null;
      if (found.Type !== 'volume' || !found.Name) return null;
      if (!SftpService.VOLUME_NAME_RE.test(found.Name)) {
        this.logger.warn(`Refusing volume with unexpected name: ${found.Name}`);
        return null;
      }
      return `/data/volumes/${found.Name}/_data`;
    } catch (err: any) {
      this.logger.warn(`docker inspect ${containerName}: ${err?.message || err}`);
      return null;
    }
  }

  // ── Validators / helpers ─────────────────────────────────────────

  private assertUsernameValid(username: string): void {
    if (!SftpService.USERNAME_RE.test(username)) {
      throw new BadRequestException(
        'Username must be lowercase, 3-32 chars, start with a letter, only a-z 0-9 _ -',
      );
    }
    if (SftpService.RESERVED_USERNAMES.has(username)) {
      throw new BadRequestException(`Username '${username}' is reserved`);
    }
  }

  private assertChrootPathSafe(p: string): void {
    if (!SftpService.CHROOT_PATH_RE.test(p) || p.includes('..')) {
      throw new BadRequestException(`Refusing unsafe chroot source: ${p}`);
    }
  }

  private normalizePublicKeys(input: string[] | undefined): string[] {
    const keys = (input || []).map((k) => k.trim()).filter(Boolean);
    for (const k of keys) {
      if (!SftpService.PUBKEY_RE.test(k)) {
        throw new BadRequestException(`Invalid public key format: '${k.slice(0, 40)}…'`);
      }
    }
    return keys;
  }

  private generatePassword(): string {
    // 16 random bytes → 22 base64url chars (>128 bits of entropy).
    return crypto.randomBytes(16).toString('base64url').replace(/=+$/, '');
  }

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
  ): Promise<SftpAccount> {
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
