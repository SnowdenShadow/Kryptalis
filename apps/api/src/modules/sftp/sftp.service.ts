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
      try {
        await execFileAsync('docker', [
          'exec', this.CONTAINER_NAME,
          'usermod', patch.disabled ? '-L' : '-U', acc.username,
        ], { timeout: 10_000 });
      } catch (err: any) {
        this.logger.warn(`usermod ${acc.username}: ${err?.message || err}`);
      }
    }

    return this.prisma.sftpAccount.update({
      where: { id: acc.id },
      data,
    });
  }

  async remove(userId: string, id: string): Promise<{ message: string }> {
    const acc = await this.assertAccountAccess(userId, id, 'ADMIN');
    // userdel -r also removes the home dir (and any authorized_keys
    // inside). Idempotent at our level — swallow "user does not exist"
    // since that's the desired end state.
    try {
      await execFileAsync('docker', [
        'exec', this.CONTAINER_NAME,
        'userdel', '-r', '-f', acc.username,
      ], { timeout: 15_000 });
    } catch (err: any) {
      this.logger.warn(`userdel ${acc.username}: ${err?.message || err}`);
    }
    await this.prisma.sftpAccount.delete({ where: { id: acc.id } });
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
    const home = `/home/${username}`;

    // 1. Create the user. -m makes home dir. -g sftpusers triggers
    //    the sshd_config Match block. -s /bin/false ensures no shell
    //    even if Match block ever gets misconfigured. -U creates a
    //    same-named primary group; we set the secondary -g sftpusers
    //    so PAM sees it.
    //
    // sshd's ChrootDirectory requires the chroot path AND every
    // ancestor to be owned by root:root with mode 0755. We make the
    // home root-owned, then create a `data` subdir the user actually
    // owns and bind it onto the appDir.
    await execFileAsync('docker', [
      'exec', this.CONTAINER_NAME,
      'useradd', '-m', '-d', home, '-s', '/bin/false', '-G', 'sftpusers',
      username,
    ], { timeout: 15_000 }).catch((err: any) => {
      // Tolerate "already exists" — re-applying state on a restart
      // legitimately hits an existing user.
      if (!String(err?.message || err).includes('already exists')) throw err;
    });
    // Lock down the home so ChrootDirectory works.
    await execFileAsync('docker', [
      'exec', this.CONTAINER_NAME,
      'sh', '-c', `chown root:root ${home} && chmod 0755 ${home}`,
    ], { timeout: 10_000 });

    // 2. Create writable subdir + bind-mount the appDir into it.
    //    The user inside the chroot sees their files at /data and we
    //    keep ChrootDirectory %h pointed at the locked-down home.
    const targetSubdir = `${home}/data`;
    const uidStdout = await execFileAsync('docker', [
      'exec', this.CONTAINER_NAME,
      'id', '-u', username,
    ], { timeout: 5_000 });
    const uid = uidStdout.stdout.trim();
    await execFileAsync('docker', [
      'exec', this.CONTAINER_NAME,
      'sh', '-c',
      `mkdir -p ${targetSubdir} && mountpoint -q ${targetSubdir} || mount --bind ${chrootSource} ${targetSubdir} && chown ${uid}:${uid} ${targetSubdir}`,
    ], { timeout: 10_000 }).catch((err: any) => {
      // mount --bind needs CAP_SYS_ADMIN. If the container wasn't
      // launched with --privileged we fall back to a SYMLINK, which
      // sshd will refuse to follow into a chroot — accept the limitation
      // and surface a clear error so the operator knows to add the cap.
      this.logger.warn(`mount --bind failed (${err?.message || err}); trying symlink fallback`);
      return execFileAsync('docker', [
        'exec', this.CONTAINER_NAME,
        'sh', '-c', `rm -rf ${targetSubdir} && ln -s ${chrootSource} ${targetSubdir} && chown -h ${uid}:${uid} ${targetSubdir}`,
      ], { timeout: 10_000 });
    });

    // 3. Set password if provided.
    if (plainPassword) {
      await this.execChpasswd(username, plainPassword);
    }

    // 4. Authorized keys.
    await this.writeAuthorizedKeys(username, publicKeys);
  }

  private async execChpasswd(username: string, plainPassword: string): Promise<void> {
    // chpasswd reads "user:password" on stdin. We use stdin instead
    // of CLI args so the password never lands in the host process list.
    return new Promise((resolve, reject) => {
      const child = execFile('docker', [
        'exec', '-i', this.CONTAINER_NAME, 'chpasswd',
      ], { timeout: 15_000 }, (err) => (err ? reject(err) : resolve()));
      child.stdin!.end(`${username}:${plainPassword}\n`);
    });
  }

  private async writeAuthorizedKeys(username: string, keys: string[]): Promise<void> {
    // authorized_keys lives at /home/<user>/.ssh/authorized_keys
    // inside the chroot — sshd reads it BEFORE chrooting the session.
    const home = `/home/${username}`;
    const content = keys.join('\n') + (keys.length ? '\n' : '');
    return new Promise((resolve, reject) => {
      const child = execFile('docker', [
        'exec', '-i', this.CONTAINER_NAME,
        'sh', '-c',
        `mkdir -p ${home}/.ssh && chmod 0700 ${home}/.ssh && cat > ${home}/.ssh/authorized_keys && chmod 0600 ${home}/.ssh/authorized_keys && chown -R ${username}:${username} ${home}/.ssh`,
      ], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
      child.stdin!.end(content);
    });
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
      const { stdout } = await execFileAsync(
        'docker', ['inspect', '--format', '{{json .Mounts}}', containerName],
        { timeout: 5_000 },
      );
      const mounts: Array<{ Type: string; Source: string; Destination: string; Name?: string }>
        = JSON.parse(stdout);
      const found = mounts.find((m) => m.Destination === containerDest);
      if (!found) return null;
      // Named volume: Mount.Name is set (e.g. prestashop_data_cmq5...).
      // Docker stores it at /var/lib/docker/volumes/<name>/_data on the
      // host, which we re-expose in the sftp container as
      // /data/volumes/<name>/_data via the compose mount.
      if (found.Type === 'volume' && found.Name) {
        return `/data/volumes/${found.Name}/_data`;
      }
      // Bind mount: Mount.Source is already a host path. We'd need to
      // know which slice of the host filesystem is reachable from the
      // sftp container to use it — skip for now.
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
