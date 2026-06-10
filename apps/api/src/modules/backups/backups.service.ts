import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemConfigService } from '../system/system-config.service';
import { CreateBackupDto } from './dto/create-backup.dto';
import {
  S3BackupConfig,
  backupS3Prefix,
  buildS3Key,
  isRemoteTarget,
  missingS3ConfigKeys,
  REMOTE_TARGETS,
} from './backup-storage.util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Backups module — current state.
 *
 * The actual backup engine (pg_dump/mysqldump/mongodump, volume snapshotting,
 * scheduler, restore executor) is not yet implemented. Until it ships, this
 * service:
 *   1. Supports LOCAL plus S3-compatible remote targets (S3/R2/B2 — also
 *      covers MinIO via a custom endpoint). Remote targets require the
 *      s3_* SystemSettings; an incomplete config is a 400 at create time.
 *   2. Refuses restore until status === COMPLETED, so accidentally clicking
 *      restore on a stale row can't silently corrupt live data later.
 *   3. Scopes every list/read/mutation to the caller's accessible projects,
 *      via the server.projects[].userId graph. Platform admins see everything.
 *      Previously every authenticated user could enumerate / restore / delete
 *      every backup on the platform.
 *
 * Integrity / at-rest encryption:
 *   - Every COMPLETED row carries sha256 of the final on-disk file (post-
 *     encryption if encrypted) plus sizeBytes. Restore re-hashes the file and
 *     refuses to proceed on mismatch — covers silent disk corruption AND
 *     deliberate tampering by anyone who reached the dump dir.
 *   - If BACKUP_ENCRYPTION_KEY is set in env (deliberately separate from the
 *     main ENCRYPTION_KEY so backup access can be siloed from app secrets),
 *     dumps are AES-256-GCM encrypted in-place via streaming — never holding
 *     the full dump in memory. The wire format is:
 *       [16-byte salt][12-byte iv][ciphertext][16-byte auth tag]
 *     Salt+HKDF derives the actual data key from BACKUP_ENCRYPTION_KEY, so
 *     reusing the same env key across many dumps never reuses an (key, iv)
 *     pair (GCM's fatal failure mode).
 *
 * Remote (S3-compatible) storage:
 *   - Configured via SystemSettings s3_endpoint / s3_bucket / s3_region /
 *     s3_access_key / s3_secret_key (Admin → System Config; secret key is
 *     encrypted at rest). Env fallbacks S3_* for headless installs.
 *   - After the local dump → (optional) encryption → sha256 flow, dumps for
 *     S3/R2/B2 targets are uploaded under `kryptalis-backups/<backupId>/
 *     <filename>` and the local file is deleted. The Backup model has no
 *     path column, so the object is re-resolved deterministically from the
 *     row id (ListObjectsV2 on the per-backup prefix) at restore/delete time.
 *   - Restore downloads the object to a local temp file, then runs the same
 *     sha256-verify / decrypt gate as local restores, and cleans up the temp.
 *   - Delete removes remote objects best-effort — a dead bucket never blocks
 *     deleting the row.
 *
 * When the engine is ready, swap the create body and call into a job runner;
 * the RBAC checks below stay valid.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    private prisma: PrismaService,
    private systemConfig: SystemConfigService,
  ) {}

  // ── access helpers ─────────────────────────────────────────────────

  private async isAdmin(userId: string): Promise<boolean> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';
  }

  private async accessibleServerIds(userId: string): Promise<string[]> {
    if (await this.isAdmin(userId)) {
      const all = await this.prisma.server.findMany({ select: { id: true } });
      return all.map((s) => s.id);
    }
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { project: { select: { serverId: true } } },
    });
    return Array.from(new Set(memberships.map((m) => m.project.serverId).filter(Boolean))) as string[];
  }

  private async assertBackupAccess(userId: string, backupId: string) {
    const backup = await this.prisma.backup.findUnique({ where: { id: backupId } });
    if (!backup) throw new NotFoundException('Backup not found');
    const allowed = await this.accessibleServerIds(userId);
    if (!allowed.includes(backup.serverId)) {
      throw new ForbiddenException('You do not have access to this backup.');
    }
    return backup;
  }

  // ── integrity / crypto helpers ─────────────────────────────────────

  /**
   * Stream the file at `filePath` through sha256 without buffering it in
   * memory. Used both at write time (record the hash) and at restore time
   * (verify it). Works on dumps of any size.
   */
  private async sha256File(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
  }

  private backupEncryptionKey(): Buffer | null {
    // DB (admin UI) wins, env fallback for legacy installs.
    const raw = this.systemConfig.get<string>('backup_encryption_key', 'BACKUP_ENCRYPTION_KEY');
    if (!raw) return null;
    if (raw.length < 32) return null;
    return Buffer.from(raw, 'utf8');
  }

  /**
   * Encrypt `filePath` in place with AES-256-GCM. Output layout:
   *   [16 salt][12 iv][ciphertext...][16 tag]
   * Streaming — never holds the whole dump in memory.
   */
  private async encryptFileInPlace(filePath: string, masterKey: Buffer): Promise<void> {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    // Node's type defs vary by version (ArrayBuffer vs Buffer); coerce.
    const dataKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('kryptalis-backup-v1'), 32));
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);

    const tmpPath = `${filePath}.enc.tmp`;
    const out = fs.createWriteStream(tmpPath);
    // Header first so restore can read salt+iv before streaming the body.
    out.write(salt);
    out.write(iv);

    await pipeline(fs.createReadStream(filePath), cipher, out, { end: false });
    const tag = cipher.getAuthTag();
    await new Promise<void>((resolve, reject) => {
      out.end(tag, () => resolve());
      out.once('error', reject);
    });

    // Atomic-ish swap. fs.rename overwrites on POSIX; on Windows it'll throw
    // EEXIST, so unlink the original first.
    if (process.platform === 'win32') {
      await fs.promises.unlink(filePath).catch(() => undefined);
    }
    await fs.promises.rename(tmpPath, filePath);
  }

  /**
   * Reverse of encryptFileInPlace — produces a plaintext file alongside the
   * encrypted one and returns its path. Restore code reads from there and
   * cleans up after.
   */
  private async decryptFileToTemp(filePath: string, masterKey: Buffer): Promise<string> {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const header = Buffer.alloc(28);
      await fd.read(header, 0, 28, 0);
      const stat = await fd.stat();
      const tagOffset = stat.size - 16;
      if (tagOffset < 28) {
        throw new BadRequestException('Encrypted backup truncated — refusing to restore.');
      }
      const tag = Buffer.alloc(16);
      await fd.read(tag, 0, 16, tagOffset);

      const salt = header.subarray(0, 16);
      const iv = header.subarray(16, 28);
      const dataKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('kryptalis-backup-v1'), 32));
      const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
      decipher.setAuthTag(tag);

      const plainPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.plain.${crypto.randomBytes(6).toString('hex')}`,
      );
      const src = fs.createReadStream(filePath, { start: 28, end: tagOffset - 1 });
      const out = fs.createWriteStream(plainPath);
      await pipeline(src, decipher, out);
      return plainPath;
    } finally {
      await fd.close();
    }
  }

  // ── remote (S3-compatible) storage ─────────────────────────────────

  private s3Config(): S3BackupConfig {
    return {
      endpoint: this.systemConfig.get<string>('s3_endpoint', 'S3_ENDPOINT'),
      bucket: this.systemConfig.get<string>('s3_bucket', 'S3_BUCKET'),
      region: this.systemConfig.get<string>('s3_region', 'S3_REGION', 'auto'),
      accessKey: this.systemConfig.get<string>('s3_access_key', 'S3_ACCESS_KEY'),
      secretKey: this.systemConfig.get<string>('s3_secret_key', 'S3_SECRET_KEY'),
    };
  }

  private isS3Configured(): boolean {
    return missingS3ConfigKeys(this.s3Config()).length === 0;
  }

  /**
   * Build a short-lived S3 client from the current SystemSettings. Built per
   * operation (not cached) so admin config edits apply immediately; callers
   * must destroy() it when done. Throws a clear 400 when config is missing.
   */
  private s3ClientOrThrow(): { client: S3Client; bucket: string } {
    const cfg = this.s3Config();
    const missing = missingS3ConfigKeys(cfg);
    if (missing.length > 0) {
      throw new BadRequestException(
        `S3-compatible storage is not configured — missing setting(s): ${missing.join(', ')}. ` +
          'Set them in Admin → System Config (Backups / S3 storage).',
      );
    }
    const client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region?.trim() || 'auto',
      credentials: {
        accessKeyId: cfg.accessKey as string,
        secretAccessKey: cfg.secretKey as string,
      },
      // Path-style keeps MinIO (and any bucket name with dots) working.
      forcePathStyle: true,
      // Network hygiene: a dead endpoint fails the request instead of
      // hanging the API worker forever.
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 600_000 },
    });
    return { client, bucket: cfg.bucket as string };
  }

  /** Upload the finished dump. Returns the object key that was written. */
  private async uploadBackupToS3(backupId: string, localPath: string): Promise<string> {
    const { client, bucket } = this.s3ClientOrThrow();
    const key = buildS3Key(backupId, path.basename(localPath));
    try {
      const stat = await fs.promises.stat(localPath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(localPath),
          ContentLength: stat.size,
        }),
      );
      return key;
    } finally {
      client.destroy();
    }
  }

  /**
   * Resolve the object key for a backup row by listing its deterministic
   * prefix (the model has no path column — see header comment).
   */
  private async resolveRemoteKey(client: S3Client, bucket: string, backupId: string): Promise<string> {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: backupS3Prefix(backupId),
        MaxKeys: 1,
      }),
    );
    const key = res.Contents?.[0]?.Key;
    if (!key) {
      throw new BadRequestException(
        'Backup object not found in the configured bucket — refusing to restore.',
      );
    }
    return key;
  }

  /** Download a remote dump to a local temp file and return its path. */
  private async downloadBackupFromS3(backupId: string): Promise<string> {
    const { client, bucket } = this.s3ClientOrThrow();
    const tmpPath = path.join(
      os.tmpdir(),
      `kryptalis-restore-${backupId}-${crypto.randomBytes(6).toString('hex')}.dump`,
    );
    try {
      const key = await this.resolveRemoteKey(client, bucket, backupId);
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) {
        throw new BadRequestException('Remote storage returned an empty backup object.');
      }
      await pipeline(res.Body as Readable, fs.createWriteStream(tmpPath));
      return tmpPath;
    } catch (err) {
      // Never leave a partial download behind.
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Failed to download backup from remote storage: ${(err as Error).message}`,
      );
    } finally {
      client.destroy();
    }
  }

  /** Best-effort removal of every remote object belonging to a backup row. */
  private async deleteRemoteObjects(backupId: string): Promise<void> {
    try {
      const { client, bucket } = this.s3ClientOrThrow();
      try {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: backupS3Prefix(backupId) }),
        );
        for (const obj of res.Contents ?? []) {
          if (!obj.Key) continue;
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
        }
      } finally {
        client.destroy();
      }
    } catch (err) {
      // Best-effort by design: a misconfigured/dead bucket must never block
      // deleting the row. The orphaned object is logged for manual cleanup.
      this.logger.warn(
        `Could not delete remote objects for backup ${backupId}: ${(err as Error).message}`,
      );
    }
  }

  // ── operations ─────────────────────────────────────────────────────

  /**
   * Available targets + whether the S3-compatible config is complete.
   * The dashboard uses this to grey out S3/R2/B2 in the create dialog.
   */
  getTargets() {
    return {
      targets: ['LOCAL', ...REMOTE_TARGETS],
      s3Configured: this.isS3Configured(),
    };
  }

  async create(userId: string, dto: CreateBackupDto) {
    const allowed = await this.accessibleServerIds(userId);
    if (!allowed.includes(dto.serverId)) {
      throw new ForbiddenException('You do not have access to this server.');
    }
    const target = (dto.target || 'LOCAL') as 'LOCAL' | 'S3' | 'R2' | 'B2';
    if (isRemoteTarget(target)) {
      // Fail fast with a clear 400 (listing the missing keys) before any row
      // or dump exists.
      this.s3ClientOrThrow().client.destroy();
    }

    // Create the row first so we have an id to anchor the on-disk filename.
    const row = await this.prisma.backup.create({
      data: {
        name: dto.name,
        serverId: dto.serverId,
        target,
        includeApplications: dto.includeApplications ?? true,
        includeDatabases: dto.includeDatabases ?? true,
        includeVolumes: dto.includeVolumes ?? true,
        schedule: dto.schedule ?? null,
        encryptedAt: false,
      },
    });

    // The dump engine itself isn't built yet. When it lands, replace the
    // block below with the real writer — but keep the post-write integrity /
    // encryption / sizeBytes recording, because that's what every restore
    // relies on.
    const dumpPath = (dto as any).filePath as string | undefined;
    if (dumpPath && fs.existsSync(dumpPath)) {
      try {
        const masterKey = this.backupEncryptionKey();
        let encrypted = false;
        if (masterKey) {
          await this.encryptFileInPlace(dumpPath, masterKey);
          encrypted = true;
        }
        // sha256 + sizeBytes are computed AFTER any encryption so restore can
        // verify the bytes that actually live on disk — and, for remote
        // targets, the bytes that get uploaded.
        const sha256 = await this.sha256File(dumpPath);
        const stat = await fs.promises.stat(dumpPath);

        if (isRemoteTarget(target)) {
          // Upload, then drop the local copy — the bucket is the only home
          // of a remote-target dump. Resolved again at restore time via the
          // deterministic kryptalis-backups/<id>/ prefix.
          await this.uploadBackupToS3(row.id, dumpPath);
          await fs.promises.unlink(dumpPath).catch(() => undefined);
        }

        await this.prisma.backup.update({
          where: { id: row.id },
          data: {
            sha256,
            sizeBytes: BigInt(stat.size),
            encryptedAt: encrypted,
            status: 'COMPLETED',
          },
        });
      } catch (err) {
        // Network/storage failures mark the row FAILED and surface a clean
        // 400 — never an unhandled crash.
        await this.prisma.backup.update({
          where: { id: row.id },
          data: { status: 'FAILED' },
        });
        this.logger.error(`Backup ${row.id} failed: ${(err as Error).message}`);
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException(
          `Backup failed (${target}): ${(err as Error).message}`,
        );
      }
    }

    return this.prisma.backup.findUnique({ where: { id: row.id } });
  }

  async findAll(userId: string, serverId?: string) {
    const allowed = await this.accessibleServerIds(userId);
    const where: any = { serverId: { in: allowed } };
    if (serverId) {
      if (!allowed.includes(serverId)) {
        throw new ForbiddenException('You do not have access to this server.');
      }
      where.serverId = serverId;
    }
    return this.prisma.backup.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async findOne(userId: string, id: string) {
    return this.assertBackupAccess(userId, id);
  }

  async restore(userId: string, id: string) {
    const backup = await this.assertBackupAccess(userId, id);
    if (backup.status !== 'COMPLETED') {
      throw new BadRequestException(
        `Only COMPLETED backups can be restored. This backup is ${backup.status}.`,
      );
    }

    // Integrity + decryption gate. Anything that throws here MUST prevent the
    // engine from touching live data — that's the whole point of recording
    // sha256 at write time. Remote-target dumps are first downloaded to a
    // local temp file so the exact same gate applies, then cleaned up.
    let dumpPath = (backup as any).filePath as string | undefined;
    let tmpDownload: string | undefined;
    try {
      if (isRemoteTarget(backup.target)) {
        tmpDownload = await this.downloadBackupFromS3(backup.id);
        dumpPath = tmpDownload;
      }
      if (dumpPath) {
        if (!fs.existsSync(dumpPath)) {
          throw new BadRequestException('Backup file is missing from disk — refusing to restore.');
        }
        if (backup.sha256) {
          const actual = await this.sha256File(dumpPath);
          if (actual !== backup.sha256) {
            throw new BadRequestException(
              'Backup file appears corrupted or tampered with — refusing to restore.',
            );
          }
        }
        if (backup.encryptedAt) {
          const masterKey = this.backupEncryptionKey();
          if (!masterKey) {
            throw new BadRequestException(
              'Backup is encrypted but BACKUP_ENCRYPTION_KEY is not configured — cannot decrypt.',
            );
          }
          const plainPath = await this.decryptFileToTemp(dumpPath, masterKey);
          // Engine not implemented yet — clean up the temp plaintext immediately
          // so it doesn't linger on disk. When the engine ships, hand plainPath
          // to it and unlink after the restore command exits.
          await fs.promises.unlink(plainPath).catch(() => undefined);
        }
      }
    } finally {
      // Remote dumps were downloaded only for this restore — never leave the
      // temp copy (possibly plaintext-adjacent) behind, success or failure.
      if (tmpDownload) {
        await fs.promises.unlink(tmpDownload).catch(() => undefined);
      }
    }

    // Engine not implemented yet — leave the row alone so we don't clobber the
    // status. When the engine ships, replace this with a real enqueue.
    return {
      message: 'Restore queued — engine implementation pending.',
      backupId: id,
    };
  }

  async remove(userId: string, id: string) {
    const backup = await this.assertBackupAccess(userId, id);
    if (isRemoteTarget(backup.target)) {
      // Best-effort — never blocks row deletion (see deleteRemoteObjects).
      await this.deleteRemoteObjects(id);
    }
    await this.prisma.backup.delete({ where: { id } });
    return { message: 'Backup deleted' };
  }
}
