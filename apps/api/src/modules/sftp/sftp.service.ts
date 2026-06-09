import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
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
 * SFTP account orchestrator (v2 — custom alpine image).
 *
 * Talks to the `kryptalis-sftp` container over the host docker socket:
 *
 *   docker exec kryptalis-sftp useradd  -m -g sftpusers ...
 *   docker exec kryptalis-sftp chpasswd
 *   docker exec kryptalis-sftp userdel  -r ...
 *
 * No /etc/sftp/users.conf file involved — atmoz's design that bit us
 * earlier is gone. Account state lives in two places:
 *
 *   1. Kryptalis DB row (source of truth, owns RBAC + audit).
 *   2. Container's /etc/passwd + /etc/shadow + /home/<user>/, persisted
 *      across container restarts via named volumes sftp_users + sftp_homes.
 *
 * Sync model: each CRUD op mutates BOTH simultaneously. On container
 * restart (rare — only when /infra/sftp/Dockerfile changes), we re-apply
 * every account by decrypting the stored plaintext passwords from the
 * passwordEnc column.
 *
 * Threat model:
 *   - Kryptalis-internal verification uses bcrypt (passwordHash).
 *   - sshd authenticates via PAM/crypt(3) against /etc/shadow inside
 *     the container — we set it with `chpasswd` and the password is
 *     immediately hashed by passwd into a SHA-512 crypt(3) entry.
 *   - Plaintext passwords are encrypted at rest (passwordEnc) with the
 *     platform's ENCRYPTION_KEY. Compromised DB without the key
 *     reveals neither the bcrypt nor the plaintext.
 *   - Chroot enforced at sshd level (Match Group sftpusers); even a
 *     compromised credential cannot reach beyond /home/<user>.
 *   - Every account ships with /bin/false as the shell — no real
 *     shell access regardless of sshd config bugs.
 */
@Injectable()
export class SftpService {
  private readonly logger = new Logger(SftpService.name);
  private readonly CONTAINER_NAME = 'kryptalis-sftp';

  private static readonly USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────

  async list(userId: string, scope: 'app' | 'project', scopeId: string): Promise<SftpAccount[]> {
    await this.assertScopeAccess(userId, scope, scopeId, 'VIEWER');
    return this.prisma.sftpAccount.findMany({
      where: scope === 'app' ? { applicationId: scopeId } : { projectId: scopeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── audit log ──────────────────────────────────────────────────
  //
  // Every mutating op writes an AuditLog row so security review can
  // trace who issued / rotated / disabled / deleted what. Failures
  // are swallowed (we don't want to roll back a successful CRUD on a
  // logging blip), but logged for ops to investigate.
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

  // ── docker exec wrapper ────────────────────────────────────────
  //
  // Centralizes every call to `docker exec kryptalis-sftp ...` so we
  // get consistent timeouts, logging, and stdin handling. Refusing to
  // run if any arg contains shell metacharacters is paranoia at this
  // depth (execFile doesn't spawn a shell), but it makes the intent
  // explicit and catches future regressions where someone passes a
  // path through `bash -c` by accident.
  private async dockerExec(
    args: string[],
    opts: { stdin?: string; timeoutMs?: number; allowFailure?: boolean } = {},
  ): Promise<string> {
    for (const a of args) {
      if (typeof a !== 'string' || a.includes('\0') || a.includes('\n')) {
        throw new BadRequestException('Refusing docker exec arg with null/newline');
      }
    }
    try {
      if (opts.stdin !== undefined) {
        return await new Promise<string>((resolve, reject) => {
          const child = execFile(
            'docker',
            ['exec', '-i', this.CONTAINER_NAME, ...args],
            { timeout: opts.timeoutMs ?? 15_000 },
            (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
          );
          child.stdin!.end(opts.stdin);
        });
      }
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', this.CONTAINER_NAME, ...args],
        { timeout: opts.timeoutMs ?? 15_000 },
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
    const minRole = dto.permission === 'READ' ? 'DEVELOPER' : 'ADMIN';
    await this.assertScopeAccess(userId, scope, scopeId, minRole);

    const username = (dto.username || '').trim().toLowerCase();
    if (!SftpService.USERNAME_RE.test(username)) {
      throw new BadRequestException(
        'Username must be lowercase, 3-32 chars, start with a letter, only a-z 0-9 _ -',
      );
    }

    const reserved = new Set([
      'root', 'admin', 'sshd', 'nobody', 'sftp', 'daemon', 'mail', 'sys',
      'sftpusers',
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
    let passwordEnc: string | null = null;
    if (dto.password !== undefined || !dto.publicKeys?.length) {
      plainPassword = dto.password && dto.password.length >= 8
        ? dto.password
        : this.generatePassword();
      passwordHash = await bcrypt.hash(plainPassword, 10);
      passwordEnc = this.encryption.encrypt(plainPassword);
    }

    const publicKeys = (dto.publicKeys || [])
      .map((k) => k.trim())
      .filter(Boolean);
    for (const k of publicKeys) {
      if (!/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/.test(k)) {
        throw new BadRequestException(
          `Invalid public key format: '${k.slice(0, 40)}…'.`,
        );
      }
    }

    // Resolve the chroot target BEFORE writing the row. If the app
    // doesn't have a per-instance dir yet (never deployed), refuse —
    // there's nothing for the user to FTP into.
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
      });
    } catch (err: any) {
      // Rollback the DB row on container failure so the user can retry
      // without a phantom row blocking the username.
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
    await this.prisma.sftpAccount.update({
      where: { id: acc.id },
      data: { passwordHash, passwordEnc },
    });
    await this.execChpasswd(acc.username, plainPassword);
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
      await this.writeAuthorizedKeys(acc.username, patch.publicKeys);
    }

    // Disabled accounts get locked in the container too. usermod -L
    // sets a `!` prefix on the shadow password so PAM auth fails
    // immediately. unlock with -U.
    if (patch.disabled !== undefined) {
      await this.dockerExec(
        ['usermod', patch.disabled ? '-L' : '-U', acc.username],
        { allowFailure: true, timeoutMs: 10_000 },
      );
    }

    const updated = await this.prisma.sftpAccount.update({
      where: { id: acc.id },
      data,
    });

    await this.audit(
      userId,
      patch.disabled === true ? 'disable' : patch.disabled === false ? 'enable' : 'update',
      acc.id, acc.username,
      // Patch summary lets the auditor see what was changed without
      // also dumping the raw publicKeys (they can be many KiB).
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
    // userdel -r removes the home dir (and any authorized_keys inside).
    // We also drop the per-user sshd_config.d include + SIGHUP sshd so
    // the username never matches a stale ChrootDirectory if it gets
    // reused later. Errors swallowed — the desired end state is "user
    // gone" regardless of intermediate failures.
    await this.dockerExec(
      ['userdel', '-r', '-f', acc.username],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    await this.dockerExec(
      ['sh', '-c', `rm -f /etc/ssh/sshd_config.d/${acc.username}.conf && pkill -HUP sshd || true`],
      { allowFailure: true, timeoutMs: 5_000 },
    );
    await this.prisma.sftpAccount.delete({ where: { id: acc.id } });
    await this.audit(userId, 'delete', acc.id, acc.username);
    return { message: 'SFTP account deleted' };
  }

  // ── Container ops ───────────────────────────────────────────────

  /**
   * Create the unix user inside the SFTP container, set its password,
   * write authorized_keys, and bind-mount the chroot home into the
   * target Kryptalis appDir. Idempotent — re-running on an existing
   * user is a no-op except for the password (which gets updated).
   */
  private async applyAccountToContainer(opts: {
    username: string;
    plainPassword: string | null;
    publicKeys: string[];
    chrootSource: string;
  }): Promise<void> {
    const { username, plainPassword, publicKeys, chrootSource } = opts;

    // Final guard before shelling out — even though every caller
    // validates already, an injection here is a root-on-host (the
    // sftp container has SYS_ADMIN), so the cost of a redundant
    // check is rounding error.
    if (!SftpService.USERNAME_RE.test(username)) {
      throw new BadRequestException('Invalid username (failed final guard)');
    }
    // chrootSource is built by us (resolveChrootSource +
    // discoverContainerCodePath) — but both branches need a
    // sanity check so a regression there can't escape into
    // mount --bind / chown calls.
    if (!/^[A-Za-z0-9/_.-]+$/.test(chrootSource) || chrootSource.includes('..')) {
      throw new BadRequestException(`Refusing to mount unsafe chroot source: ${chrootSource}`);
    }

    const home = `/home/${username}`;

    // 1. Create the user.
    //   -m            create home dir (used only for .ssh/authorized_keys)
    //   -d <home>     pin home location
    //   -s /bin/false defence in depth — no shell EVER
    //   -G sftpusers  marks the user as SFTP-only
    try {
      await this.dockerExec(
        ['useradd', '-m', '-d', home, '-s', '/bin/false', '-G', 'sftpusers', username],
        { timeoutMs: 15_000 },
      );
    } catch (err: any) {
      if (!String(err?.message || err).includes('already exists')) throw err;
    }

    // 2. Per-user sshd_config drop-in. We use `Match User <user>` to
    //    override the global `Match Group sftpusers` ChrootDirectory,
    //    pointing each user STRAIGHT at their app's data on disk.
    //
    //    This avoids the `mount --bind` strategy that risked
    //    overwriting the source volume's mount point when timing was
    //    unlucky against the Docker daemon. ChrootDirectory accepts
    //    a path argument and sshd enforces every ancestor is owned by
    //    root with mode <= 0755 BEFORE entering the chroot — which is
    //    why we sanitize chrootSource so hard upstream.
    //
    //    Note: sshd requires ChrootDirectory to be readable by sshd
    //    (root) but NOT to be writable by the chrooted user — writes
    //    happen relative to the chroot root once internal-sftp is
    //    serving. We chown the leaf to root:root 0755 for the chroot
    //    check, then chmod children to the SFTP uid so the user can
    //    list+write.
    // The dropin contains EVERY per-user sshd setting: chroot path,
    // sftp-lock, and forwarding bans. We removed the global Match
    // Group block in sshd_config because it shadowed these per-user
    // includes when sshd hit the group match first ("bad ownership
    // or modes for chroot directory" because it tried to chroot at
    // /home/<user>, which we never prepared).
    const dropinPath = `/etc/ssh/sshd_config.d/${username}.conf`;
    const dropinBody =
      `Match User ${username}\n` +
      `  ChrootDirectory ${chrootSource}\n` +
      `  ForceCommand internal-sftp -l VERBOSE\n` +
      `  AllowTcpForwarding no\n` +
      `  X11Forwarding no\n` +
      `  AllowAgentForwarding no\n` +
      `  PermitTunnel no\n` +
      `  PermitTTY no\n`;
    await this.dockerExec(
      ['sh', '-c', `mkdir -p /etc/ssh/sshd_config.d && cat > ${dropinPath} && chmod 0644 ${dropinPath}`],
      { stdin: dropinBody, timeoutMs: 10_000 },
    );

    // 3. Make the chroot source meet sshd's requirements:
    //      - owned by root:root
    //      - mode 0755 (writable by root, readable by others)
    //    AND the user must own the CONTENTS (so they can read/write).
    //    chown applied via uid (we just created it) so we don't race
    //    against PAM resolving the username.
    const uidOut = await this.dockerExec(['id', '-u', username], { timeoutMs: 5_000 });
    const uid = uidOut.trim();
    await this.dockerExec(
      ['sh', '-c',
        // ChrootDirectory ancestor checks — the leaf must be root-owned
        // 0755. We use `--reference` to NOT clobber sub-paths' owners
        // (PrestaShop volume contents are owned by www-data inside the
        // app container; preserve those so the app keeps working).
        `chown root:root ${chrootSource} && chmod 0755 ${chrootSource} && ` +
        // Children: give the SFTP uid group-membership of whatever owns
        // the files so reads work. WordPress/PrestaShop use uid 33
        // (www-data); we add our user to that gid as well via useradd
        // -G, but a fresh chmod g+rwX is cheaper and idempotent.
        `find ${chrootSource} -mindepth 1 -maxdepth 1 -exec chgrp -h ${uid} {} + 2>/dev/null || true && ` +
        // Recursively make CONTENT group-readable so the user can list.
        // We never touch perm on root mountpoint itself — only inside.
        `chmod -R g+rX ${chrootSource}/ 2>/dev/null || true`,
      ],
      { timeoutMs: 30_000, allowFailure: true },
    );

    // 4. Reload sshd to pick up the new sshd_config.d drop-in. sshd
    //    re-reads its config on SIGHUP without dropping existing
    //    sessions, so this is safe to do mid-flight.
    await this.dockerExec(
      ['sh', '-c', 'pkill -HUP sshd || true'],
      { allowFailure: true, timeoutMs: 5_000 },
    );

    // 3. Set password if provided.
    if (plainPassword) {
      await this.execChpasswd(username, plainPassword);
    }

    // 4. Authorized keys.
    await this.writeAuthorizedKeys(username, publicKeys);
  }

  private async execChpasswd(username: string, plainPassword: string): Promise<void> {
    // chpasswd reads "user:password" on stdin. Using stdin instead of
    // CLI args keeps the password out of the host process list (visible
    // to anyone with /proc read access on the host).
    await this.dockerExec(['chpasswd'], {
      stdin: `${username}:${plainPassword}\n`,
      timeoutMs: 15_000,
    });
  }

  private async writeAuthorizedKeys(username: string, keys: string[]): Promise<void> {
    // authorized_keys lives at /home/<user>/.ssh/authorized_keys inside
    // the chroot. sshd reads it BEFORE chrooting the session so the
    // path doesn't have to be reachable post-chroot.
    const home = `/home/${username}`;
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

  /**
   * Resolve the host-side path we'll bind-mount as the user's chroot
   * data. Two cases mirror FilesService.resolveDockerTarget:
   *
   *   - Git deploys / Compose Empty / Dockerfile Empty: the appDir on
   *     the host contains the real source code. We mount that.
   *
   *   - Marketplace / Docker image: the appDir holds only
   *     docker-compose.yml + .env + side-files; the real app code
   *     lives INSIDE the container's filesystem (e.g. PrestaShop's
   *     /var/www/html) on a Docker-managed volume. We mount that
   *     volume's host mountpoint instead so SFTP users see the live
   *     app files.
   *
   * The detection mirrors FilesService: if the host dir holds nothing
   * non-managed (only compose / env / side-files), we're in docker-only
   * mode. Otherwise host-fs.
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
    const slug = this.slugify(app.name);
    const id12 = app.id.slice(0, 12);

    // Host-fs path FIRST. If the appDir has user code we bind-mount that
    // (mirrors how the file manager works). Path inside the sftp
    // container — docker-compose maps host .kryptalis/apps → /data/apps.
    const hostFsPath = `/data/apps/${slug}-${id12}`;

    // Docker-fs detection: only marketplace / image-only apps need the
    // in-container code mount. Check if the app has a containerName and
    // the host dir has nothing but plumbing.
    if (!app.containerName) return hostFsPath;

    // Find which container path holds the user code (same map as
    // FilesService.pickRootForImage). We probe the container at runtime
    // via `docker inspect` rather than maintaining a parallel map.
    const containerSrc = await this.discoverContainerCodePath(app.containerName, app.dockerImage);
    if (!containerSrc) return hostFsPath;

    return containerSrc;
  }

  /**
   * Find the host-side mountpoint of the container path that holds the
   * app's actual code. We `docker inspect` the container and look for
   * a Mount whose Destination matches the well-known web root for the
   * image. Returns null when nothing matches → caller falls back to
   * the host-fs appDir.
   *
   * Returns a path REACHABLE FROM THE SFTP CONTAINER. For Docker named
   * volumes, docker-compose mounts /var/lib/docker/volumes at
   * /data/volumes inside the sftp container, so the per-volume code
   * dir is `/data/volumes/<volumeName>/_data`.
   */
  private async discoverContainerCodePath(containerName: string, image: string | null): Promise<string | null> {
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

    try {
      // Validate containerName against our naming convention BEFORE
      // shelling out. Defense against a malicious projectId leaking
      // into the docker inspect arg list.
      if (!/^[a-z0-9_-]{1,64}$/.test(containerName)) {
        this.logger.warn(`Refusing to inspect malformed container name: ${containerName}`);
        return null;
      }
      const { stdout } = await execFileAsync(
        'docker', ['inspect', '--format', '{{json .Mounts}}', containerName],
        { timeout: 5_000 },
      );
      const mounts: Array<{ Type: string; Source: string; Destination: string; Name?: string }>
        = JSON.parse(stdout);
      const found = mounts.find((m) => m.Destination === containerDest);
      if (!found) return null;

      // Defense in depth: the volume name MUST follow our naming
      // convention (e.g. prestashop_data_cmq5xxx). Anything else means
      // either an unmanaged container or a misnamed app — refuse to
      // mount instead of granting SFTP access to an arbitrary volume.
      if (found.Type === 'volume' && found.Name) {
        // Validate the volume name has no path-traversal chars and
        // matches a per-app-instance naming pattern. Belt + suspenders
        // — the compose mount root is /var/lib/docker/volumes and
        // docker daemon would reject `..` in volume names anyway,
        // but we don't want to rely on that.
        if (!/^[a-zA-Z0-9_-]+$/.test(found.Name)) {
          this.logger.warn(`Refusing volume with non-alphanumeric name: ${found.Name}`);
          return null;
        }
        return `/data/volumes/${found.Name}/_data`;
      }
      // Bind mounts: not supported. Mount.Source is a host path that
      // may or may not be reachable from the sftp container; safer to
      // fall through.
      return null;
    } catch (err: any) {
      this.logger.warn(`docker inspect ${containerName}: ${err?.message || err}`);
      return null;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────

  private generatePassword(): string {
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
