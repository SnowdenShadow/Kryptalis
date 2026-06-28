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
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { AgentService } from '../agent/agent.service';
import { remoteAppSlug, slugify as appSlugify } from '../applications/applications.helpers';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SftpAccount, SftpPermission } from '@prisma/client';

const execFileAsync = promisify(execFile);

/**
 * One bind-mount inside an account's chroot. The chroot leaf itself is
 * always the sterile root-owned /home/<user>; every piece of actual app
 * data is exposed by bind-mounting `source` at /home/<user>/<dir>.
 *
 *   - app-scope accounts: a single { dir: 'app', source: <app data> }.
 *   - project-scope accounts: one entry PER application of the project,
 *     dir = '<slug>-<id12>' (mirrors the on-disk layout). The flat
 *     .dockcontrol/apps dir is shared across ALL projects, so a chroot on
 *     it would leak other tenants' apps — per-app binds are the only
 *     safe way to give project-wide access.
 */
interface ChrootBind {
  /** Mount-point dir name directly under /home/<user>. */
  dir: string;
  /** Path (inside the SFTP container) to bind-mount there. */
  source: string;
}

/**
 * SFTP account orchestrator.
 *
 * Talks to the `dockcontrol-sftp` container over the host docker socket:
 *
 *   docker exec dockcontrol-sftp useradd  -m -d <home> -s /bin/false -G sftpusers ...
 *   docker exec dockcontrol-sftp chpasswd
 *   docker exec dockcontrol-sftp userdel  -r ...
 *
 * Account state lives in two places:
 *
 *   1. DockControl DB row (source of truth — owns RBAC, audit, expiry).
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
 *   - DockControl-internal credentials use bcrypt (`passwordHash`).
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
  private readonly CONTAINER_NAME = 'dockcontrol-sftp';

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
    private agent: AgentService,
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

  async list(
    userId: string,
    scope: 'app' | 'project',
    scopeId: string,
  ): Promise<Array<SftpAccount & { remoteHost?: string | null; remotePort?: number | null }>> {
    await this.assertScopeAccess(userId, scope, scopeId, 'VIEWER');
    const rows = await this.prisma.sftpAccount.findMany({
      where: scope === 'app' ? { applicationId: scopeId } : { projectId: scopeId },
      orderBy: { createdAt: 'desc' },
    });
    // Annotate with the connection target: remote-placed scopes connect
    // to the agent's embedded server (their server's host, port 2522);
    // local scopes use the platform host on 2222 (UI default).
    const remote = await this.resolveRemoteSftpServer(scope, scopeId).catch(() => null);
    return rows.map((r) => ({
      ...r,
      remoteHost: remote?.host ?? null,
      remotePort: remote ? 2522 : null,
    }));
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
      allowShell?: boolean;
    },
  ): Promise<{ account: SftpAccount; plainPassword: string | null; remoteHost?: string | null }> {
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

    // Routing: apps on a remote server are served by THAT server's agent
    // (embedded SFTP on :2522). Local apps go through the platform's SFTP
    // container as before. Resolved BEFORE creating the row.
    const remoteServer = await this.resolveRemoteSftpServer(scope, scopeId);
    // Local chroot binds only make sense for the local path — and double
    // as the "has this ever been deployed" check.
    const chrootBinds = remoteServer ? [] : await this.resolveChrootBinds(scope, scopeId);

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
        // Shell access: locally it's a chroot in the SFTP container; on a remote
        // server the agent opens an interactive `docker exec` INTO the app's
        // container (app-scoped accounts only — a project account has no single
        // container to target).
        allowShell: remoteServer ? (scope === 'app' && !!dto.allowShell) : !!dto.allowShell,
        createdById: userId,
      },
    });

    try {
      if (remoteServer) {
        await this.syncRemoteSftpAccounts(remoteServer.id);
      } else {
        await this.applyAccountToContainer({
          username,
          plainPassword,
          publicKeys,
          chrootBinds,
          permission: account.permission,
          disabled: false,
          allowShell: account.allowShell,
        });
      }
    } catch (err: any) {
      // Roll back the DB row so the username doesn't get stuck. We log
      // ABOVE the rollback so the failed apply is captured even if the
      // delete also throws.
      this.logger.error(`SFTP apply failed for ${username}: ${err?.message || err}`);
      await this.prisma.sftpAccount.delete({ where: { id: account.id } }).catch(() => {});
      throw new BadRequestException(`SFTP backend rejected the account: ${err?.message || err}`);
    }

    await this.audit(userId, 'create', account.id, username, {
      scope, scopeId, permission: account.permission, hasKeys: publicKeys.length,
      ...(remoteServer ? { remoteServerId: remoteServer.id } : {}),
    });

    return { account, plainPassword, remoteHost: remoteServer?.host ?? null };
  }

  /**
   * Create a short-lived, KEY-ONLY SFTP account that the web terminal uses to
   * SSH-bridge into a REMOTE app's container (allowShell + that container). No
   * password; the public key is the only credential and the matching private
   * key stays in the gateway's memory for the session. Synced to the agent.
   * Caller MUST call removeEphemeralShellAccount() when the session ends — a
   * short expiresAt is the safety net if it doesn't.
   */
  async createEphemeralShellAccount(opts: {
    username: string;
    applicationId: string;
    publicKey: string;
    serverId: string;
    createdById?: string;
  }): Promise<{ id: string }> {
    // Fall back to the app's project owner if no creator is supplied (the FK is
    // Restrict). Terminal sessions are already RBAC-gated upstream.
    let createdById = opts.createdById;
    if (!createdById) {
      const owner = await this.prisma.user.findFirst({
        where: { role: { in: ['ADMIN', 'SUPERADMIN'] } },
        select: { id: true },
      });
      createdById = owner?.id;
    }
    const account = await this.prisma.sftpAccount.create({
      data: {
        username: opts.username,
        passwordHash: null,
        passwordEnc: null,
        publicKeys: [opts.publicKey] as any,
        applicationId: opts.applicationId,
        projectId: null,
        permission: 'WRITE',
        allowShell: true,
        // 15-min safety expiry — sessions are far shorter and explicitly
        // removed on close; this just bounds the leak window if cleanup never
        // runs (the sweeper revokes it on the agent).
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdById: createdById!,
      },
    });
    await this.syncRemoteSftpAccounts(opts.serverId);
    return { id: account.id };
  }

  /** Delete an ephemeral terminal account and re-sync the agent (revoke). */
  async removeEphemeralShellAccount(id: string, serverId: string): Promise<void> {
    await this.prisma.sftpAccount.delete({ where: { id } }).catch(() => {});
    await this.syncRemoteSftpAccounts(serverId);
  }

  /**
   * Push the FULL desired account set for a remote server to its agent
   * (SFTP_SYNC). Full-state + idempotent: every call rebuilds the list
   * from the DB, so create/update/delete/rotate all share this one sync
   * path and a lost task self-heals on the next call.
   */
  private async syncRemoteSftpAccounts(serverId: string): Promise<void> {
    // Accounts whose scope resolves to this server: app-scoped accounts
    // on apps placed there + project-scoped accounts on projects whose
    // default server is there.
    const accounts = await this.prisma.sftpAccount.findMany({
      where: {
        OR: [
          { application: { serverId } },
          { application: { serverId: null, project: { serverId } } },
          { project: { serverId } },
        ],
      },
      include: {
        application: { select: { id: true, name: true, containerName: true } },
        project: {
          select: {
            serverId: true,
            applications: { select: { id: true, name: true, serverId: true } },
          },
        },
      },
    });

    const payload = accounts.map((acc) => {
      const roots: Record<string, string> = {};
      if (acc.application) {
        roots['app'] = `/opt/dockcontrol/apps/${remoteAppSlug(acc.application.name, acc.application.id)}`;
      } else if (acc.project) {
        for (const app of acc.project.applications) {
          // Only this server's apps — a project may span machines.
          const appServer = app.serverId ?? acc.project.serverId;
          if (appServer !== serverId) continue;
          roots[`${appSlugify(app.name)}-${app.id.slice(0, 12)}`] =
            `/opt/dockcontrol/apps/${remoteAppSlug(app.name, app.id)}`;
        }
      }
      return {
        username: acc.username,
        passwordHash: acc.passwordHash ?? undefined,
        publicKeys: (acc.publicKeys as string[] | null) ?? [],
        permission: acc.permission,
        disabled: acc.disabled || (acc.expiresAt ? acc.expiresAt < new Date() : false),
        roots,
        // Shell access: only meaningful for an app-scoped account (a single
        // container to exec into). The agent refuses the shell channel unless
        // BOTH allowShell and containerName are set.
        allowShell: acc.allowShell && !!acc.application?.containerName,
        containerName: acc.application?.containerName ?? undefined,
      };
    });

    const task = await this.agent.enqueueAndWait(serverId, 'SFTP_SYNC', { accounts: payload }, 60_000);
    if (task.status === 'FAILED') {
      throw new Error(task.error || 'remote SFTP sync failed');
    }
  }

  /** The remote server an account's files live on, or null for local. */
  private async remoteServerForAccount(acc: SftpAccount): Promise<{ id: string; host: string } | null> {
    if (acc.applicationId) return this.resolveRemoteSftpServer('app', acc.applicationId);
    if (acc.projectId) return this.resolveRemoteSftpServer('project', acc.projectId);
    return null;
  }

  async rotatePassword(userId: string, id: string): Promise<{ plainPassword: string }> {
    const acc = await this.assertAccountAccess(userId, id, 'ADMIN');
    const plainPassword = this.generatePassword();
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    const passwordEnc = this.encryption.encrypt(plainPassword);

    const remoteServer = await this.remoteServerForAccount(acc);
    if (remoteServer) {
      // Remote: persist first, then full-state sync (the agent's auth
      // reads the bcrypt hash from the synced set — there is no separate
      // chpasswd step).
      await this.prisma.sftpAccount.update({
        where: { id: acc.id },
        data: { passwordHash, passwordEnc },
      });
      await this.syncRemoteSftpAccounts(remoteServer.id);
    } else {
      // Local: apply to container FIRST, then persist. If the container
      // fails, the old password keeps working — better than a DB out of
      // sync with sshd (user thinks the rotation worked).
      await this.execChpasswd(acc.username, plainPassword);
      await this.prisma.sftpAccount.update({
        where: { id: acc.id },
        data: { passwordHash, passwordEnc },
      });
    }

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
      allowShell?: boolean;
    },
  ): Promise<SftpAccount> {
    const acc = await this.assertAccountAccess(userId, id, 'ADMIN');

    const data: Record<string, unknown> = {};
    if (patch.disabled !== undefined) data.disabled = patch.disabled;
    if (patch.permission !== undefined) data.permission = patch.permission;
    if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt;
    if (patch.allowShell !== undefined) data.allowShell = patch.allowShell;
    if (patch.publicKeys !== undefined) {
      data.publicKeys = this.normalizePublicKeys(patch.publicKeys) as any;
    }

    // Remote account → persist, then one full-state sync covers every
    // patched field (the agent reads permission/disabled/keys/shell from the
    // synced set). Shell is only meaningful for an APP-scoped remote account
    // (a single container to exec into) — force off for project-scoped ones.
    const remoteForUpdate = await this.remoteServerForAccount(acc);
    if (remoteForUpdate) {
      if (patch.allowShell && !acc.applicationId) data.allowShell = false;
      const updatedRemote = await this.prisma.sftpAccount.update({
        where: { id: acc.id },
        data,
      });
      await this.syncRemoteSftpAccounts(remoteForUpdate.id);
      await this.audit(
        userId,
        patch.disabled === true ? 'disable' : patch.disabled === false ? 'enable' : 'update',
        acc.id, acc.username,
        { remoteServerId: remoteForUpdate.id },
      );
      return updatedRemote;
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

    // Login shell switches between /bin/bash and /bin/false based on
    // allowShell. We chsh through usermod (POSIX-safe). If chsh fails
    // (rare) the dropin still keeps ForceCommand=internal-sftp for
    // non-shell accounts, so the user never actually gets a shell.
    if (patch.allowShell !== undefined) {
      const shell = patch.allowShell ? '/bin/bash' : '/bin/false';
      await this.dockerExec(
        ['usermod', '-s', shell, acc.username],
        { allowFailure: true, timeoutMs: 10_000 },
      );
    }

    if (patch.permission !== undefined || patch.disabled !== undefined || patch.allowShell !== undefined) {
      // Permission, disabled state and shell-mode all live in the
      // dropin; rewrite it once. ChrootDirectory is always /home/<user>
      // — never changes — so the dropin only needs username +
      // permission + disabled + allowShell.
      const chrootLeaf = `/home/${acc.username}`;
      await this.writeUserDropin(acc.username, chrootLeaf, next.permission, next.disabled, next.allowShell);
      // ACL flips between rwx and rx when permission changes.
      // Skipping this on a READ→WRITE upgrade would leave the user
      // unable to write despite the dropin no longer carrying `-R`.
      if (patch.permission !== undefined) {
        const binds = await this.resolveChrootBindsForAccount(acc).catch(() => null);
        if (binds?.length) {
          await this.applyAclToBindTargets(acc.username, binds, next.permission);
        }
      }
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
    const remoteServer = await this.remoteServerForAccount(acc).catch(() => null);
    if (remoteServer) {
      // Delete the row first, then sync — the full-state push simply no
      // longer contains the account, so the agent drops it.
      await this.prisma.sftpAccount.delete({ where: { id: acc.id } });
      await this.syncRemoteSftpAccounts(remoteServer.id).catch((e) =>
        this.logger.warn(`remote SFTP sync after delete failed (heals on next sync): ${e?.message || e}`),
      );
    } else {
      await this.removeAccountFromContainer(acc.username);
      await this.prisma.sftpAccount.delete({ where: { id: acc.id } });
    }
    await this.audit(userId, 'delete', acc.id, acc.username);
    return { message: 'SFTP account deleted' };
  }

  /**
   * Deprovision every SFTP account bound to an application — used by
   * ApplicationsService.remove() BEFORE the app row is deleted (the FK cascade
   * drops the SftpAccount rows but NOT the OS-level sshd user/chroot/password
   * inside the sftp container, which would otherwise survive as a ghost login
   * whose chroot target — the now-deleted app dir — no longer exists).
   *
   * Best-effort and self-contained: it resolves accounts from the DB, removes
   * each from its container (local docker exec, or remote agent via a post-
   * delete sync), then deletes the rows so the later app delete's cascade is a
   * no-op. Never throws — a cleanup failure must not block the app deletion.
   */
  async deprovisionForApplication(applicationId: string): Promise<void> {
    let accounts: { id: string; username: string }[] = [];
    try {
      accounts = await this.prisma.sftpAccount.findMany({
        where: { applicationId },
        select: { id: true, username: true },
      }) as any;
    } catch (e) {
      this.logger.warn(`deprovisionForApplication(${applicationId}): list failed: ${(e as Error).message}`);
      return;
    }
    if (!accounts.length) return;

    const remoteServer = await this.resolveRemoteSftpServer('app', applicationId).catch(() => null);
    for (const acc of accounts) {
      try {
        if (!remoteServer) {
          await this.removeAccountFromContainer(acc.username);
        }
        await this.prisma.sftpAccount.delete({ where: { id: acc.id } }).catch(() => undefined);
      } catch (e) {
        this.logger.warn(`deprovisionForApplication: could not remove "${acc.username}": ${(e as Error).message}`);
      }
    }
    if (remoteServer) {
      // Rows are gone → a full-state push no longer contains them, so the agent
      // drops the OS accounts on its embedded server.
      await this.syncRemoteSftpAccounts(remoteServer.id).catch((e) =>
        this.logger.warn(`remote SFTP sync after app delete failed (heals on next sync): ${e?.message || e}`),
      );
    }
  }

  // ── Sync / sweep ──────────────────────────────────────────────────

  /**
   * Re-apply every DB row to the container. Idempotent — useradd
   * complaints about an existing user are tolerated; the dropin is
   * always rewritten so any drift is corrected.
   */
  private async resyncFromDb(): Promise<void> {
    const allRows = await this.prisma.sftpAccount.findMany();
    if (!allRows.length) return;
    // Remote accounts live on their agent's embedded server — applying
    // them to the LOCAL container would create chroots onto empty dirs.
    const rows: typeof allRows = [];
    for (const row of allRows) {
      const remote = await this.remoteServerForAccount(row).catch(() => null);
      if (!remote) rows.push(row);
    }
    if (!rows.length) return;
    this.logger.log(`Resyncing ${rows.length} SFTP account(s) to container`);
    for (const row of rows) {
      try {
        const chrootBinds = await this.resolveChrootBindsForAccount(row).catch(() => null);
        if (!chrootBinds || !chrootBinds.length) {
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
          chrootBinds,
          permission: row.permission,
          disabled: row.disabled || expired,
          allowShell: row.allowShell,
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
    const remoteServerIds = new Set<string>();
    for (const row of expired) {
      try {
        // Remote (agent) accounts — including ephemeral terminal accounts whose
        // session cleanup never ran (API restart/crash) — are revoked by a full
        // re-sync below; locally we lock the unix user. We collect remote server
        // ids first so one sync per server covers all its expired rows.
        const remote = await this.remoteServerForAccount(row).catch(() => null);
        if (remote) {
          remoteServerIds.add(remote.id);
        } else {
          await this.dockerExec(
            ['usermod', '-L', row.username],
            { allowFailure: true, timeoutMs: 10_000 },
          );
        }
        await this.prisma.sftpAccount.update({
          where: { id: row.id },
          data: { disabled: true },
        });
        await this.audit(null, 'disable', row.id, row.username, { reason: 'expired' });
      } catch (err: any) {
        this.logger.warn(`Sweep of ${row.username} failed: ${err?.message || err}`);
      }
    }
    // Push the now-disabled set to each affected agent so a leaked ephemeral
    // shell account actually stops working (the sync marks expired rows
    // disabled). Best-effort: a failed sync self-heals on the next sweep.
    for (const serverId of remoteServerIds) {
      await this.syncRemoteSftpAccounts(serverId).catch((e: any) =>
        this.logger.warn(`expired-account re-sync for ${serverId} failed: ${e?.message || e}`),
      );
    }
  }

  // ── Audit ─────────────────────────────────────────────────────────

  /**
   * Append an AuditLog row. Failures are swallowed — we never want to
   * roll back a successful CRUD because of a logging blip — but logged
   * loudly so ops can investigate.
   *
   * The schema is { userId, action, resource, resourceId, details } —
   * we used to write the wrong field names (resourceType / metadata)
   * which silently dropped every row via the `as any` escape hatch.
   *
   * userId can be `null` for system-driven events (expiry sweep). The
   * column itself is non-nullable + has an FK, so we use the createdBy
   * field of the underlying account row in that case.
   */
  private async audit(
    userId: string | null,
    action: 'create' | 'rotate' | 'disable' | 'enable' | 'update' | 'delete',
    accountId: string,
    username: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      // System events have no acting user — fall back to the account
      // creator so the FK stays valid and the audit trail still
      // attributes the change to a real user. The `reason` field in
      // details disambiguates ("expired" vs a real CRUD).
      let actor = userId;
      if (!actor) {
        const row = await this.prisma.sftpAccount.findUnique({
          where: { id: accountId },
          select: { createdById: true },
        });
        actor = row?.createdById ?? null;
      }
      if (!actor) return;
      await this.prisma.auditLog.create({
        data: {
          userId: actor,
          resource: 'sftp_account',
          resourceId: accountId,
          action: `sftp.${action}`,
          details: { username, ...extra },
        },
      });
    } catch (e: any) {
      this.logger.warn(`audit log failed for sftp.${action} ${username}: ${e?.message || e}`);
    }
  }

  // ── Docker shell wrapper ─────────────────────────────────────────

  /**
   * Centralises every `docker exec dockcontrol-sftp …` call. Uses
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
   *   1. Create the unix user — home is /home/<user>, owned root:root
   *      mode 0755 (sshd's `safely_chroot` requires the chroot leaf
   *      and every ancestor to be root-owned with no group/other
   *      write bit).
   *   2. Bind-mount the actual data dir(s) under /home/<user>/<dir>
   *      — this is where the user can read/write. App-scope accounts
   *      get a single /home/<user>/app bind; project-scope accounts
   *      get one bind PER application of the project (named
   *      <slug>-<id12>). sshd doesn't inspect the bind targets (it
   *      only walks ancestors of ChrootDirectory), so we're free to
   *      layer POSIX ACLs on the bind targets without tripping sshd.
   *      We can't put the ACL on the chroot leaf directly because the
   *      kernel surfaces the ACL mask in stat()'s group bits, and
   *      sshd reads that as a write bit and refuses.
   *   3. Write the per-user sshd_config drop-in (chroot=/home/<user>,
   *      sftp-lock, RO flag for READ permission, blanket disable when
   *      locked).
   *   4. ACL on the bind targets so the user can actually write.
   *   5. Set the password (chpasswd over stdin).
   *   6. Write authorized_keys.
   *   7. SIGHUP sshd so the new dropin is loaded mid-flight.
   */
  private async applyAccountToContainer(opts: {
    username: string;
    plainPassword: string | null;
    publicKeys: string[];
    chrootBinds: ChrootBind[];
    permission: SftpPermission;
    disabled: boolean;
    allowShell: boolean;
  }): Promise<void> {
    const { username, plainPassword, publicKeys, chrootBinds, permission, disabled, allowShell } = opts;

    this.assertUsernameValid(username);
    if (!chrootBinds.length) {
      throw new BadRequestException('No filesystem target to expose over SFTP');
    }
    for (const b of chrootBinds) {
      this.assertChrootPathSafe(b.source);
      this.assertBindDirValid(b.dir);
    }

    const home = `/home/${username}`;
    const chrootLeaf = home;
    // /bin/false locks the account to SFTP only (sshd refuses session
    // requests when the shell isn't on /etc/shells, but more
    // importantly ForceCommand=internal-sftp in the dropin already
    // covers it). /bin/bash gives Putty/ssh an interactive shell still
    // chrooted to /home/<user>.
    const shell = allowShell ? '/bin/bash' : '/bin/false';

    // 1. Create the user. If it already exists (re-sync after rebuild),
    //    re-apply the shell via usermod so the allowShell flag actually
    //    takes effect on resync.
    try {
      await this.dockerExec(
        ['useradd', '-m', '-d', home, '-s', shell, '-G', 'sftpusers', username],
        { timeoutMs: 15_000 },
      );
    } catch (err: any) {
      if (!String(err?.message || err).includes('already exists')) throw err;
      await this.dockerExec(
        ['usermod', '-s', shell, username],
        { allowFailure: true, timeoutMs: 10_000 },
      );
    }

    // 2. Sterile chroot leaf + bind-mount the writable data dir(s)
    //    under /home/<user>/<dir>. When allowShell is on, also
    //    bind-mount /bin /lib /usr… RO so the user's bash actually has
    //    commands to run inside the chroot. The bind mounts point FROM
    //    the sources INTO our container's /home — Docker daemon
    //    doesn't manage /home in this container, so there's no
    //    daemon race like the old design had against Docker-managed
    //    volume paths.
    await this.prepareChrootLeafAndBind(username, chrootBinds, allowShell);

    // 3. Per-user sshd_config drop-in.
    await this.writeUserDropin(username, chrootLeaf, permission, disabled, allowShell);

    // 4. ACL on the bind targets (/home/<user>/<dir>), not the chroot
    //    leaf — see prepareChrootLeafAndBind for the why.
    await this.applyAclToBindTargets(username, chrootBinds, permission);

    // 5. Password.
    if (plainPassword) await this.execChpasswd(username, plainPassword);

    // 6. authorized_keys.
    await this.writeAuthorizedKeys(username, publicKeys);

    // 7. Reload sshd so the new dropin is picked up.
    await this.reloadSshd();
  }

  private async removeAccountFromContainer(username: string): Promise<void> {
    this.assertUsernameValid(username);
    // Order matters: umount BEFORE userdel -r. Otherwise `rm -rf` on
    // the home dir would recurse INTO the bind mount and try to
    // delete the actual app data on the volume. `|| true` because
    // the mount might already be gone (manual cleanup, container
    // recreate without resync, etc.) and we still want userdel to
    // run.
    // `umount -l` (lazy): detach the mount even if a session has a
    // descriptor open inside. The actual unmount completes when the
    // last fd closes. Without -l, deleting a user with a live session
    // would block here and leave the bind mount stuck.
    //
    // We umount EVERY top-level dir of the home that is a mountpoint —
    // covers the app bind, project-scope per-app binds (dynamic names),
    // and the shell chroot binds — even if the dropin is missing or
    // corrupted but the mounts are still there. All best-effort.
    // username passed assertUsernameValid above, so the glob is safe.
    // (No `.*` in the glob — it would match `..` and could lazy-umount
    // /home itself. Bind dirs are never dotfiles by construction.)
    const allBinds =
      `for d in /home/${username}/* ; do ` +
      `mountpoint -q "$d" 2>/dev/null && umount -l "$d" 2>/dev/null ; ` +
      `done ; true`;
    await this.dockerExec(
      ['sh', '-c', allBinds],
      { allowFailure: true, timeoutMs: 10_000 },
    );
    await this.dockerExec(
      ['userdel', '-r', '-f', username],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    await this.dockerExec(
      ['rm', '-f', `/etc/ssh/sshd_config.d/${username}.conf`],
      { allowFailure: true, timeoutMs: 5_000 },
    );
    await this.reloadSshd();
  }

  /**
   * Compose the per-user dropin. Each block sets:
   *   - ChrootDirectory: always /home/<user>. The writable app data is
   *     bind-mounted at /home/<user>/app — so even shell users can't
   *     walk out of the chroot.
   *   - ForceCommand: internal-sftp (+ `-R` for READ accounts) when
   *     allowShell=false. Omitted when allowShell=true so Putty/ssh
   *     get the user's login shell (/bin/bash).
   *   - PermitTTY / pty: enabled only when allowShell=true. Without
   *     this, ssh would connect but the bash prompt would be useless
   *     (no echo, no line editing).
   *   - DenyUsers: when the account is disabled, sshd refuses login
   *     before PAM is consulted. Belt + suspenders with `usermod -L`.
   *   - Forwarding blanket-off: tcp/X11/agent/tun. We keep these off
   *     even for shell users — they don't need them and they widen the
   *     blast radius if a credential is leaked.
   */
  private async writeUserDropin(
    username: string,
    chrootSource: string,
    permission: SftpPermission,
    disabled: boolean,
    allowShell: boolean,
  ): Promise<void> {
    this.assertUsernameValid(username);
    this.assertChrootPathSafe(chrootSource);
    const dropinPath = `/etc/ssh/sshd_config.d/${username}.conf`;
    const lines: string[] = [];
    if (disabled) {
      lines.push(`DenyUsers ${username}`);
    }
    lines.push(
      `Match User ${username}`,
      `  ChrootDirectory ${chrootSource}`,
    );
    if (allowShell) {
      // No ForceCommand → sshd runs the user's login shell.
      // PermitTTY yes so the user gets a usable interactive prompt.
      lines.push(`  PermitTTY yes`);
    } else {
      const forceCmd = permission === 'READ'
        ? 'internal-sftp -l VERBOSE -R'
        : 'internal-sftp -l VERBOSE';
      lines.push(`  ForceCommand ${forceCmd}`);
      lines.push(`  PermitTTY no`);
    }
    lines.push(
      `  AllowTcpForwarding no`,
      `  X11Forwarding no`,
      `  AllowAgentForwarding no`,
      `  PermitTunnel no`,
    );
    const body = lines.join('\n') + '\n';
    // Write via stdin so the body never lands on argv (and our
    // null/newline arg guard never has to scan it).
    await this.dockerExec(
      ['sh', '-c', `mkdir -p /etc/ssh/sshd_config.d && cat > ${dropinPath} && chmod 0644 ${dropinPath}`],
      { stdin: body, timeoutMs: 10_000 },
    );
  }

  /**
   * Two-layer chroot setup:
   *
   *   /home/<user>          root:root 0755   — the sshd chroot LEAF
   *   /home/<user>/app      bind mount       — the writable app data
   *
   * Why split:
   *   sshd's `safely_chroot()` walks every ancestor of
   *   ChrootDirectory and requires each to be owned by root with no
   *   group/other write bit. That check inspects st_mode, and the
   *   Linux kernel surfaces the POSIX ACL mask in the group bits of
   *   st_mode — so you cannot grant the user write access to the
   *   chroot leaf itself via ACL without sshd rejecting it. The bind
   *   mount sidesteps that: sshd only inspects the leaf and its
   *   ancestors, never descends. /home/<user>/app can have any
   *   ownership/ACL we want.
   *
   * Why mount per-user (instead of one shared mount):
   *   The bind target lives INSIDE the chroot — each user needs their
   *   own. Mount is idempotent — `mountpoint -q` skip if already
   *   mounted (covers resync after container restart).
   *
   * Why this isn't the old SYS_ADMIN footgun:
   *   The earlier design tried to bind-mount onto paths managed by
   *   the host Docker daemon (Docker volume `_data` dirs), which
   *   raced the daemon and could wipe volumes. Here we mount FROM the
   *   Docker-managed path INTO our own /home tree — Docker doesn't
   *   touch /home in this container, so no race.
   */
  // Dirs we bind-mount RO into the chroot when allowShell is on. They
  // are the minimum a real bash session needs (Alpine layout):
  //
  //   /bin   /sbin   /usr  → busybox + bash + nano/vi/awk/grep…
  //   /lib   /lib64        → musl + dynamic linker
  //   /etc                 → /etc/passwd /etc/group /etc/hosts (so
  //                          `whoami`, `ls -l`, name resolution work).
  //                          Only the in-container /etc — no host
  //                          secrets there; just the SFTP container's
  //                          own minimal config.
  //
  // The mounts are READ-ONLY so a shell user can't tamper with
  // anything. The bind targets live INSIDE /home/<user>, so umount
  // them along with the user dir on delete.
  private static readonly SHELL_CHROOT_BIND_DIRS = ['bin', 'sbin', 'usr', 'lib', 'lib64', 'etc'];

  private async prepareChrootLeafAndBind(
    username: string,
    binds: ChrootBind[],
    allowShell: boolean,
  ): Promise<void> {
    this.assertUsernameValid(username);
    for (const b of binds) {
      this.assertChrootPathSafe(b.source);
      this.assertBindDirValid(b.dir);
    }
    const home = `/home/${username}`;
    // Data binds. Always re-mount so resyncs after a redeploy point at
    // the FRESH source (Docker volume names change on marketplace
    // re-install). App-scope: a single `app` dir. Project-scope: one
    // dir per application of the project.
    const appMount =
      `chown root:root ${home} && chmod 0755 ${home}` +
      binds
        .map((b) => {
          const bindTarget = `${home}/${b.dir}`;
          return (
            ` && mkdir -p ${bindTarget}` +
            // Source may not exist yet on a freshly-provisioned
            // shell-only account (no deploy yet) — make it.
            ` && mkdir -p ${b.source}` +
            ` && { umount -l ${bindTarget} 2>/dev/null || true ; }` +
            ` && mount --bind ${b.source} ${bindTarget}`
          );
        })
        .join('');

    // When shell is enabled we bind-mount the SFTP container's own
    // /bin /sbin /usr /lib /lib64 /etc into the chroot so bash + its
    // dynamic linker are reachable post-chroot. Read-only so the user
    // can't tamper with the system files.
    //
    // When shell is disabled we tear those binds back down — toggling
    // a user from shell→sftp-only should not leave their chroot
    // populated with binaries they no longer need.
    const shellSetup = allowShell
      ? SftpService.SHELL_CHROOT_BIND_DIRS.map((d) =>
          // `[ -d /src ]` guards against missing dirs (e.g. /lib64 on
          // pure-musl Alpine). `mountpoint -q` makes the mount
          // idempotent across resyncs.
          `if [ -d /${d} ] && ! mountpoint -q ${home}/${d}; then ` +
          `mkdir -p ${home}/${d} && mount --bind -o ro /${d} ${home}/${d}; fi`,
        ).join(' && ')
      : SftpService.SHELL_CHROOT_BIND_DIRS.map((d) =>
          // Cleanup path: lazy-umount any existing bind, then rmdir
          // the empty stub. rmdir is best-effort — it fails silently
          // if the dir still has content (e.g. user wrote files there
          // before we toggled off; we leave those untouched).
          `if mountpoint -q ${home}/${d}; then umount -l ${home}/${d} 2>/dev/null || true; fi ; ` +
          `rmdir ${home}/${d} 2>/dev/null || true`,
        ).join(' ; ');

    await this.dockerExec(
      ['sh', '-c', `${appMount} ; ${shellSetup}`],
      { timeoutMs: 30_000 },
    );
  }

  /**
   * Apply the per-user ACL to every data bind target under
   * /home/<user> (app-scope: just `app`; project-scope: one dir per
   * application). The ACL grants rwx (or rx for READ) directly on the
   * dir + default ACL so newly-created files/dirs inherit. Capital
   * `X` = execute only on dirs, never on plain files — chrooted SFTP
   * users shouldn't gain exec on uploaded content. READ accounts get
   * `-R rX` as defence in depth on top of `internal-sftp -R`.
   *
   * Recursive ACL on a large codebase (~80k files for PrestaShop)
   * can take seconds; 60s timeout + allowFailure keeps account
   * creation alive if a partial application happens — next update
   * call will repair the stragglers.
   */
  private async applyAclToBindTargets(
    username: string,
    binds: ChrootBind[],
    permission: SftpPermission,
  ): Promise<void> {
    this.assertUsernameValid(username);
    const uidOut = await this.dockerExec(['id', '-u', username], { timeoutMs: 5_000 });
    const uid = uidOut.trim();
    if (!/^\d+$/.test(uid)) {
      throw new BadRequestException(`Could not resolve uid for ${username}`);
    }
    const aclLeaf = permission === 'READ' ? `u:${uid}:rx` : `u:${uid}:rwx`;
    const aclTree = permission === 'READ' ? `u:${uid}:rX` : `u:${uid}:rwX`;
    for (const b of binds) {
      this.assertBindDirValid(b.dir);
      const bindTarget = `/home/${username}/${b.dir}`;
      await this.dockerExec(
        ['sh', '-c',
          `setfacl -m ${aclLeaf} ${bindTarget} && ` +
          `setfacl -d -m ${aclLeaf} ${bindTarget} && ` +
          `setfacl -R -m ${aclTree} ${bindTarget}/ 2>/dev/null || true`,
        ],
        { timeoutMs: 60_000, allowFailure: true },
      );
    }
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
   * Resolve the bind-mount set for an account's chroot. Sources mirror
   * FilesService.resolveDockerTarget:
   *
   *   - Git deploys / Compose Empty / Dockerfile Empty: appDir on the
   *     host holds real source code → mount it as-is.
   *
   *   - Marketplace / Docker image: appDir holds only docker-compose
   *     plumbing; real app code lives in a Docker-managed named volume
   *     (PrestaShop's /var/www/html, etc.) → resolve that volume's
   *     host mountpoint instead so SFTP users see the live app files.
   *
   * App scope → single bind at /home/<user>/app.
   *
   * Project scope → one bind per application of the project, each at
   * /home/<user>/<slug>-<id12>. The on-disk layout (.dockcontrol/apps)
   * is a FLAT directory shared by every project, so a single chroot
   * over it would expose other tenants' apps — per-app bind mounts
   * are the only containment-preserving way to grant project-wide
   * access. The chroot leaf stays the sterile root-owned /home/<user>
   * either way.
   */
  /** Apps placed on a remote server are served by THAT server's agent —
   *  its embedded SFTP server (port 2522) — not by the platform's SFTP
   *  container. resolveRemoteSftpServer() picks the routing. */
  private isRemoteApp(app: { server?: { host: string | null } | null; project?: { server?: { host: string | null } | null } | null }): boolean {
    const host = app.server?.host ?? app.project?.server?.host;
    return !!host && !isLocalHost(host);
  }

  /**
   * Resolve where an SFTP account's files actually live: null = the
   * platform host (local SFTP container path), otherwise the remote
   * server whose agent will serve them. Mixed-placement projects refuse
   * — one chroot cannot span machines.
   */
  private async resolveRemoteSftpServer(
    scope: 'app' | 'project',
    scopeId: string,
  ): Promise<{ id: string; host: string } | null> {
    if (scope === 'app') {
      const app = await this.prisma.application.findUnique({
        where: { id: scopeId },
        select: {
          server: { select: { id: true, host: true } },
          project: { select: { server: { select: { id: true, host: true } } } },
        },
      });
      if (!app) throw new NotFoundException('Application not found');
      const server = app.server ?? app.project?.server;
      return server && !isLocalHost(server.host) ? (server as { id: string; host: string }) : null;
    }
    const project = await this.prisma.project.findUnique({
      where: { id: scopeId },
      select: {
        server: { select: { id: true, host: true } },
        applications: { select: { server: { select: { id: true, host: true } } } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    const hosts = new Set<string>();
    const resolved: Array<{ id: string; host: string }> = [];
    for (const a of project.applications) {
      const server = (a.server ?? project.server) as { id: string; host: string } | null;
      const key = server && !isLocalHost(server.host) ? server.id : 'local';
      if (!hosts.has(key)) {
        hosts.add(key);
        if (key !== 'local' && server) resolved.push(server);
      }
    }
    if (hosts.size > 1) {
      throw new BadRequestException(
        'Apps in this project are split across servers — a single SFTP account cannot span machines. Create app-scoped accounts instead.',
      );
    }
    return resolved[0] ?? null;
  }

  private async resolveChrootBinds(scope: 'app' | 'project', scopeId: string): Promise<ChrootBind[]> {
    if (scope === 'app') {
      const app = await this.prisma.application.findUnique({
        where: { id: scopeId },
        select: { name: true, id: true, dockerImage: true, containerName: true, framework: true },
      });
      if (!app) throw new NotFoundException('Application not found');
      // A PHP_SITE's docroot is its public/ subdir, created by the first deploy.
      // Creating an SFTP account before that first deploy would bind-mount (and
      // root-create) an empty public/ that the platform hadn't provisioned yet.
      // containerName is set only on a SUCCESSFUL deploy, so use it as the
      // "has been deployed at least once" signal and fail with a clear message.
      if (app.framework === 'PHP_SITE' && !app.containerName) {
        throw new BadRequestException(
          'Deploy this PHP site at least once before creating an SFTP account — its public/ folder is created on first deploy.',
        );
      }
      return [{ dir: 'app', source: await this.computeChrootSourceForApp(app) }];
    }
    const project = await this.prisma.project.findUnique({
      where: { id: scopeId },
      select: {
        applications: {
          select: { name: true, id: true, dockerImage: true, containerName: true, framework: true },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (!project.applications.length) {
      throw new BadRequestException(
        'Project has no applications — nothing to expose over SFTP.',
      );
    }
    const binds: ChrootBind[] = [];
    for (const app of project.applications) {
      const source = await this.computeChrootSourceForApp(app);
      binds.push({ dir: `${this.slugify(app.name)}-${app.id.slice(0, 12)}`, source });
    }
    // Defensive: dir names are slug-id12 and ids are unique, but a
    // duplicate mount-point would silently shadow an app — fail closed.
    const seen = new Set<string>();
    for (const b of binds) {
      if (seen.has(b.dir)) {
        throw new BadRequestException(`Duplicate SFTP mount dir '${b.dir}'`);
      }
      seen.add(b.dir);
    }
    return binds;
  }

  private async resolveChrootBindsForAccount(acc: SftpAccount): Promise<ChrootBind[]> {
    if (acc.applicationId) return this.resolveChrootBinds('app', acc.applicationId);
    if (acc.projectId) return this.resolveChrootBinds('project', acc.projectId);
    throw new BadRequestException('This SFTP account is bound to neither an application nor a project.');
  }

  private async computeChrootSourceForApp(
    app: { name: string; id: string; dockerImage: string | null; containerName: string | null; framework?: string | null },
  ): Promise<string> {
    const slug = this.slugify(app.name);
    const id12 = app.id.slice(0, 12);

    // Path inside the sftp container. docker-compose maps host
    // .dockcontrol/apps → /data/apps.
    const hostFsPath = `/data/apps/${slug}-${id12}`;

    // PHP_SITE: the Apache docroot is the app's public/ subdir (the generated
    // Dockerfile/docker-compose.yml live one level up). Drop the SFTP user
    // straight into public/ so they upload web files there and never see — or
    // overwrite — the platform's infra files.
    if (app.framework === 'PHP_SITE') return `${hostFsPath}/public`;

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
    // Keep in sync with files/docker-fs.ts IMAGE_ROOTS. SFTP reads the
    // VOLUME directly (no in-container shell needed), so shell-less images
    // like Portainer are browsable HERE even though the web file manager
    // can't exec into them.
    const ROOT_MAP: Array<[RegExp, string]> = [
      [/prestashop/, '/var/www/html'],
      [/wordpress/, '/var/www/html'],
      [/ghost/, '/var/lib/ghost/content'],
      [/nextcloud/, '/var/www/html'],
      [/gitea/, '/data'],
      [/nginx/, '/usr/share/nginx/html'],
      [/portainer/, '/data'],
      [/grafana/, '/var/lib/grafana'],
      [/n8n/, '/home/node/.n8n'],
      [/code-server|coder/, '/home/coder'],
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

  /**
   * Mount-point dir name under /home/<user>. Built from slugify() +
   * id12 (or the literal 'app'), so this should never fire — it's a
   * fail-closed guard for the value that ends up unquoted in a
   * `sh -c mount …` command line. No slashes, no dots, no shell
   * metachars; must not collide with the RO shell-chroot system dirs
   * or .ssh.
   */
  private assertBindDirValid(dir: string): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dir)) {
      throw new BadRequestException(`Refusing unsafe SFTP mount dir: ${dir}`);
    }
    if (SftpService.SHELL_CHROOT_BIND_DIRS.includes(dir)) {
      throw new BadRequestException(`SFTP mount dir '${dir}' collides with a system dir`);
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
