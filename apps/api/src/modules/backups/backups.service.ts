import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
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
import { EncryptionService } from '../../common/crypto/encryption.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateBackupDto } from './dto/create-backup.dto';
import { previousOccurrence, scheduledRunName } from './backup-schedule.util';
import {
  S3BackupConfig,
  backupS3Prefix,
  buildS3Key,
  isRemoteTarget,
  missingS3ConfigKeys,
  REMOTE_TARGETS,
} from './backup-storage.util';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { slugify, resolveAppDir } from '../applications/applications.helpers';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const execFileAsync = promisify(execFile);

// Same runtime-dir convention as databases/applications/files services.
const DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

/** Manifest written at the archive root — restore is driven entirely by it. */
interface BackupManifest {
  version: 1;
  backupId: string;
  serverId: string;
  createdAt: string;
  includes: { applications: boolean; databases: boolean; volumes: boolean };
  databases: Array<{
    id: string;
    name: string;
    type: string;
    container: string;
    file: string;
    /** True when the dump covers the whole instance (auto-imported rows
     *  whose logical database name isn't tracked) — restore targets the
     *  admin database instead of a single one. */
    dumpAll: boolean;
  }>;
  volumes: string[];
  applicationsExported: boolean;
}

/**
 * Backups module.
 *
 * The backup engine is implemented here: create() produces a tar.gz dump of
 * the targeted server (database dumps via `docker exec`, application volume
 * tars via `docker run busybox tar`, application metadata as JSON) in the
 * runtime dir (.kryptalis/backups/<id>.tar.gz), then runs the integrity /
 * encryption / upload flow. The dump runs asynchronously — create() returns
 * the row in PENDING and the job flips it to IN_PROGRESS → COMPLETED/FAILED.
 * restore() downloads/verifies/decrypts, extracts the archive and replays
 * database dumps + volume tars against the live containers.
 *
 * This service also:
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
 *     <filename>` and the local file is deleted. The object key is also
 *     re-resolvable deterministically from the row id (ListObjectsV2 on the
 *     per-backup prefix) for rows predating the filename column.
 *   - Restore downloads the object to a local temp file, then runs the same
 *     sha256-verify / decrypt gate as local restores, and cleans up the temp.
 *   - Delete removes remote objects best-effort — a dead bucket never blocks
 *     deleting the row.
 */
/** Scheduler tick cadence — checking due occurrences once a minute is plenty
 *  for a minute-granularity cron subset. */
const SCHEDULE_TICK_INTERVAL_MS = 60_000;

@Injectable()
export class BackupsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupsService.name);
  private scheduleTimer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    private systemConfig: SystemConfigService,
    private encryption: EncryptionService,
    // Injected from the @Global NotificationsModule (same as monitoring/auth).
    private notifications: NotificationsService,
  ) {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }

  onModuleInit() {
    // Same convention as MonitoringService: no live interval in test runs.
    if (process.env.NODE_ENV === 'test') return;
    this.scheduleTimer = setInterval(
      () => void this.runScheduledBackups().catch((e) =>
        this.logger.error(`Backup schedule tick crashed: ${(e as Error).message}`),
      ),
      SCHEDULE_TICK_INTERVAL_MS,
    );
    this.scheduleTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
  }

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

  // ── scheduler ──────────────────────────────────────────────────────
  //
  // A Backup row with a non-null `schedule` acts as a TEMPLATE. One row ==
  // one dump (sha256/filename/status), so re-running the job on the template
  // itself would overwrite its history — instead every due occurrence spawns
  // a NEW child row (same serverId/target/include*, schedule null, name
  // suffixed with the occurrence time) and runs the dump engine on that.
  // The template's lastRunAt records the occurrence that was honoured.

  /** One scheduler pass — called every SCHEDULE_TICK_INTERVAL_MS. */
  async runScheduledBackups(now: Date = new Date()): Promise<void> {
    const templates = await this.prisma.backup.findMany({
      where: { schedule: { not: null } },
      include: { server: { select: { host: true } } },
    });

    for (const tpl of templates) {
      // Per-template isolation: one bad template never stops the loop.
      try {
        const occurrence = previousOccurrence(tpl.schedule as string, now);
        if (!occurrence) continue; // legacy/unsupported expression

        // Due when the latest occurrence hasn't been honoured yet. Fall back
        // to createdAt so a fresh template (whose initial dump may still be
        // running or have failed) doesn't fire immediately.
        const last = tpl.lastRunAt ?? tpl.createdAt;
        if (last.getTime() >= occurrence.getTime()) continue;

        // The dump engine is local-only — same gate as runBackupJob.
        if (!isLocalHost(tpl.server.host)) {
          this.logger.warn(
            `Scheduled backup "${tpl.name}" skipped — remote (agent-managed) servers are not supported.`,
          );
          continue;
        }

        // Double-run guard: skip while the template's own initial dump or a
        // previously spawned child is still PENDING / IN_PROGRESS.
        const running = await this.prisma.backup.findFirst({
          where: {
            serverId: tpl.serverId,
            status: { in: ['PENDING', 'IN_PROGRESS'] },
            OR: [{ id: tpl.id }, { schedule: null, name: { startsWith: `${tpl.name} (` } }],
          },
          select: { id: true },
        });
        if (running) continue;

        // Mark the occurrence as honoured BEFORE launching the job so a
        // slow dump can't be re-triggered by the next tick.
        await this.prisma.backup.update({
          where: { id: tpl.id },
          data: { lastRunAt: occurrence },
        });

        const child = await this.prisma.backup.create({
          data: {
            name: scheduledRunName(tpl.name, occurrence),
            serverId: tpl.serverId,
            target: tpl.target,
            includeApplications: tpl.includeApplications,
            includeDatabases: tpl.includeDatabases,
            includeVolumes: tpl.includeVolumes,
            schedule: null,
            encryptedAt: false,
          },
        });
        this.logger.log(
          `Scheduled backup "${tpl.name}" due (${tpl.schedule}) — spawned run ${child.id}.`,
        );
        void this.runBackupJob(child.id).catch((err) => {
          this.logger.error(`Scheduled backup job ${child.id} crashed: ${(err as Error).message}`);
        });
      } catch (err) {
        this.logger.error(
          `Scheduled backup "${tpl.name}" (${tpl.id}) failed to launch: ${(err as Error).message}`,
        );
      }
    }
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
   * prefix (works for rows predating the filename column too).
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

  // ── docker plumbing ────────────────────────────────────────────────
  //
  // execFile / spawn with argv arrays (never a shell) — container names,
  // usernames and database names come from the DB and must not be
  // interpretable. Large dumps stream stdout straight to disk instead of
  // buffering in memory.

  private runCommandToFile(
    cmd: string,
    args: string[],
    outPath: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(outPath);
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 8192) stderr += d.toString();
      });
      child.stdout.pipe(out);
      child.once('error', (err) => {
        clearTimeout(timer);
        out.destroy();
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        out.close(() => {
          if (code === 0) resolve();
          else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        });
      });
    });
  }

  private runCommandWithInputFile(
    cmd: string,
    args: string[],
    inPath: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 8192) stderr += d.toString();
      });
      const src = fs.createReadStream(inPath);
      src.once('error', (err) => {
        child.kill('SIGKILL');
        clearTimeout(timer);
        reject(err);
      });
      src.pipe(child.stdin);
      // A container process that exits early (e.g. auth failure) closes its
      // stdin — swallow the resulting EPIPE; the exit code carries the error.
      child.stdin.once('error', () => undefined);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
      });
    });
  }

  // ── backup job (dump engine) ───────────────────────────────────────

  private dbContainerName(db: { name: string; host: string; autoImported: boolean }): string {
    // Auto-imported rows store the real container_name in `host`; manually
    // provisioned rows use the kryptalis-db-<name> scheme (databases.service).
    return db.autoImported ? db.host : `kryptalis-db-${db.name}`;
  }

  private async dumpDatabases(
    stagingDir: string,
    serverId: string,
    manifest: BackupManifest,
  ): Promise<void> {
    const dbs = await this.prisma.database.findMany({ where: { serverId } });
    if (dbs.length === 0) return;
    const dir = path.join(stagingDir, 'databases');
    await fs.promises.mkdir(dir, { recursive: true });

    for (const db of dbs) {
      const container = this.dbContainerName(db);
      const password = this.encryption.decrypt(db.password);
      // Auto-imported rows don't track the logical database name (name is a
      // display label) — dump the whole instance instead.
      const dumpAll = db.autoImported;
      let file: string;
      switch (db.type) {
        case 'POSTGRESQL': {
          file = `${db.id}.sql`;
          const args = dumpAll
            ? ['exec', container, 'pg_dumpall', '-U', db.username, '--clean', '--if-exists']
            : ['exec', container, 'pg_dump', '-U', db.username, '--clean', '--if-exists', '-d', db.name];
          await this.runCommandToFile('docker', args, path.join(dir, file), 1_800_000);
          break;
        }
        case 'MYSQL':
        case 'MARIADB': {
          file = `${db.id}.sql`;
          const args = [
            'exec', '-e', `MYSQL_PWD=${password}`, container,
            'mysqldump', '-u', db.username,
            ...(dumpAll ? ['--all-databases'] : ['--databases', db.name]),
          ];
          await this.runCommandToFile('docker', args, path.join(dir, file), 1_800_000);
          break;
        }
        case 'MONGODB': {
          file = `${db.id}.archive`;
          const args = [
            'exec', container,
            'mongodump', '--archive', '--quiet',
            '--username', db.username, '--password', password,
            '--authenticationDatabase', 'admin',
            ...(dumpAll ? [] : ['--db', db.name]),
          ];
          await this.runCommandToFile('docker', args, path.join(dir, file), 1_800_000);
          break;
        }
        case 'REDIS':
        case 'KEYDB': {
          file = `${db.id}.rdb`;
          // REDISCLI_AUTH instead of -a so the password never shows up in
          // the host's process list (same reason mysqldump gets MYSQL_PWD).
          const envArgs = password ? ['-e', `REDISCLI_AUTH=${password}`] : [];
          await execFileAsync(
            'docker',
            ['exec', ...envArgs, container, 'redis-cli', 'SAVE'],
            { timeout: 300_000 },
          );
          await this.runCommandToFile(
            'docker',
            ['exec', container, 'cat', '/data/dump.rdb'],
            path.join(dir, file),
            600_000,
          );
          break;
        }
        default:
          // DRAGONFLY / CLICKHOUSE have no portable exec-based dump path yet;
          // their data is still covered by includeVolumes.
          this.logger.warn(
            `Backup: skipping database "${db.name}" — no dump strategy for type ${db.type}.`,
          );
          continue;
      }
      manifest.databases.push({
        id: db.id,
        name: db.name,
        type: db.type,
        container,
        file: `databases/${file}`,
        dumpAll,
      });
    }
  }

  /**
   * Volume names belonging to the server's application compose stacks.
   * Compose names volumes `<project>_<volume>` where the project name is the
   * compose dir basename (resolveAppDir handles per-instance vs legacy dirs).
   */
  private async listAppVolumes(serverId: string): Promise<string[]> {
    const apps = await this.prisma.application.findMany({
      where: { project: { serverId } },
      select: { id: true, name: true },
    });
    if (apps.length === 0) return [];
    const { stdout } = await execFileAsync(
      'docker',
      ['volume', 'ls', '--format', '{{.Name}}'],
      { timeout: 15_000 },
    );
    const volumes = stdout.trim().split('\n').filter(Boolean);
    const prefixes = apps.map(
      (app) => `${path.basename(resolveAppDir(slugify(app.name), app.id))}_`,
    );
    return volumes.filter((v) => prefixes.some((p) => v.startsWith(p)));
  }

  private async dumpVolumes(
    stagingDir: string,
    serverId: string,
    manifest: BackupManifest,
  ): Promise<void> {
    const volumes = await this.listAppVolumes(serverId);
    if (volumes.length === 0) return;
    const dir = path.join(stagingDir, 'volumes');
    await fs.promises.mkdir(dir, { recursive: true });
    for (const vol of volumes) {
      await this.runCommandToFile(
        'docker',
        ['run', '--rm', '-v', `${vol}:/data:ro`, 'busybox', 'tar', '-czf', '-', '-C', '/data', '.'],
        path.join(dir, `${vol}.tar.gz`),
        1_800_000,
      );
      manifest.volumes.push(vol);
    }
  }

  private async exportApplications(stagingDir: string, serverId: string): Promise<void> {
    const apps = await this.prisma.application.findMany({
      where: { project: { serverId } },
      include: {
        domains: true,
        project: { select: { id: true, name: true } },
      },
    });
    // envVars are exported in their encrypted-at-rest form — the archive must
    // never hold plaintext app secrets (it may itself be unencrypted).
    const json = JSON.stringify(
      apps,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
    await fs.promises.writeFile(path.join(stagingDir, 'applications.json'), json);
  }

  private async runBackupJob(backupId: string): Promise<void> {
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      include: { server: { select: { host: true } } },
    });
    if (!backup) return;
    await this.prisma.backup.update({
      where: { id: backupId },
      data: { status: 'IN_PROGRESS' },
    });

    const filename = `${backupId}.tar.gz`;
    const archivePath = path.join(BACKUPS_DIR, filename);
    const stagingDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kryptalis-backup-'));
    try {
      if (!isLocalHost(backup.server.host)) {
        throw new Error(
          'Backups for remote (agent-managed) servers are not supported yet — only the local server can be backed up.',
        );
      }

      const manifest: BackupManifest = {
        version: 1,
        backupId,
        serverId: backup.serverId,
        createdAt: new Date().toISOString(),
        includes: {
          applications: backup.includeApplications,
          databases: backup.includeDatabases,
          volumes: backup.includeVolumes,
        },
        databases: [],
        volumes: [],
        applicationsExported: false,
      };

      if (backup.includeDatabases) {
        await this.dumpDatabases(stagingDir, backup.serverId, manifest);
      }
      if (backup.includeVolumes) {
        await this.dumpVolumes(stagingDir, backup.serverId, manifest);
      }
      if (backup.includeApplications) {
        await this.exportApplications(stagingDir, backup.serverId);
        manifest.applicationsExported = true;
      }
      await fs.promises.writeFile(
        path.join(stagingDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
      );

      await execFileAsync('tar', ['-czf', archivePath, '-C', stagingDir, '.'], {
        timeout: 1_800_000,
        maxBuffer: 8 * 1024 * 1024,
      });

      const masterKey = this.backupEncryptionKey();
      let encrypted = false;
      if (masterKey) {
        await this.encryptFileInPlace(archivePath, masterKey);
        encrypted = true;
      }
      // sha256 + sizeBytes are computed AFTER any encryption so restore can
      // verify the bytes that actually live on disk — and, for remote
      // targets, the bytes that get uploaded.
      const sha256 = await this.sha256File(archivePath);
      const stat = await fs.promises.stat(archivePath);

      if (isRemoteTarget(backup.target)) {
        // Upload, then drop the local copy — the bucket is the only home
        // of a remote-target dump.
        await this.uploadBackupToS3(backupId, archivePath);
        await fs.promises.unlink(archivePath).catch(() => undefined);
      }

      await this.prisma.backup.update({
        where: { id: backupId },
        data: {
          sha256,
          sizeBytes: BigInt(stat.size),
          size: BigInt(stat.size),
          encryptedAt: encrypted,
          filename,
          status: 'COMPLETED',
          lastRunAt: new Date(),
        },
      });
      this.logger.log(
        `Backup ${backupId} completed (${stat.size} bytes, target=${backup.target}, encrypted=${encrypted})`,
      );
      // Fire-and-forget — a broken SMTP/webhook must never fail the job.
      this.notifications
        .sendBackupResult({
          backupId,
          name: backup.name,
          serverId: backup.serverId,
          status: 'COMPLETED',
        })
        .catch(() => {});
    } catch (err) {
      await fs.promises.unlink(archivePath).catch(() => undefined);
      await this.prisma.backup
        .update({ where: { id: backupId }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      this.logger.error(`Backup ${backupId} failed: ${(err as Error).message}`);
      this.notifications
        .sendBackupResult({
          backupId,
          name: backup.name,
          serverId: backup.serverId,
          status: 'FAILED',
          error: (err as Error).message,
        })
        .catch(() => {});
    } finally {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── restore engine ─────────────────────────────────────────────────

  private async restoreDatabase(
    extractDir: string,
    entry: BackupManifest['databases'][number],
  ): Promise<void> {
    const db = await this.prisma.database.findUnique({ where: { id: entry.id } });
    if (!db) {
      throw new Error(
        `database "${entry.name}" no longer exists in the registry — recreate it first, then restore.`,
      );
    }
    const container = this.dbContainerName(db);
    const password = this.encryption.decrypt(db.password);
    const file = path.join(extractDir, 'databases', path.basename(entry.file));
    if (!fs.existsSync(file)) {
      throw new Error(`dump file for database "${entry.name}" is missing from the archive.`);
    }

    switch (db.type) {
      case 'POSTGRESQL': {
        const targetDb = entry.dumpAll ? 'postgres' : db.name;
        await this.runCommandWithInputFile(
          'docker',
          ['exec', '-i', container, 'psql', '-U', db.username, '-d', targetDb],
          file,
          1_800_000,
        );
        break;
      }
      case 'MYSQL':
      case 'MARIADB': {
        await this.runCommandWithInputFile(
          'docker',
          ['exec', '-i', '-e', `MYSQL_PWD=${password}`, container, 'mysql', '-u', db.username],
          file,
          1_800_000,
        );
        break;
      }
      case 'MONGODB': {
        await this.runCommandWithInputFile(
          'docker',
          [
            'exec', '-i', container,
            'mongorestore', '--archive', '--drop',
            '--username', db.username, '--password', password,
            '--authenticationDatabase', 'admin',
          ],
          file,
          1_800_000,
        );
        break;
      }
      case 'REDIS':
      case 'KEYDB': {
        await execFileAsync(
          'docker',
          ['cp', file, `${container}:/data/dump.rdb`],
          { timeout: 300_000 },
        );
        await execFileAsync('docker', ['restart', container], { timeout: 120_000 });
        break;
      }
      default:
        throw new Error(`no restore strategy for database type ${db.type}.`);
    }
  }

  private async restoreVolume(extractDir: string, volumeName: string): Promise<void> {
    const file = path.join(extractDir, 'volumes', `${path.basename(volumeName)}.tar.gz`);
    if (!fs.existsSync(file)) {
      throw new Error(`tar for volume "${volumeName}" is missing from the archive.`);
    }
    // Idempotent — succeeds when the volume already exists.
    await execFileAsync('docker', ['volume', 'create', volumeName], { timeout: 15_000 });
    await this.runCommandWithInputFile(
      'docker',
      ['run', '--rm', '-i', '-v', `${volumeName}:/data`, 'busybox', 'tar', '-xzf', '-', '-C', '/data'],
      file,
      1_800_000,
    );
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

    // Dumps can take minutes — run the job in the background and return the
    // PENDING row immediately. The job flips status to IN_PROGRESS →
    // COMPLETED/FAILED; the dashboard polls the row.
    void this.runBackupJob(row.id).catch((err) => {
      this.logger.error(`Backup job ${row.id} crashed: ${(err as Error).message}`);
    });

    return row;
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
    let dumpPath: string;
    let tmpDownload: string | undefined;
    let plainPath: string | undefined;
    let extractDir: string | undefined;
    try {
      if (isRemoteTarget(backup.target)) {
        tmpDownload = await this.downloadBackupFromS3(backup.id);
        dumpPath = tmpDownload;
      } else {
        if (!backup.filename) {
          throw new BadRequestException(
            'This backup row has no archive on record (created before the dump engine existed) — it cannot be restored.',
          );
        }
        dumpPath = path.join(BACKUPS_DIR, path.basename(backup.filename));
      }
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
      let archivePath = dumpPath;
      if (backup.encryptedAt) {
        const masterKey = this.backupEncryptionKey();
        if (!masterKey) {
          throw new BadRequestException(
            'Backup is encrypted but BACKUP_ENCRYPTION_KEY is not configured — cannot decrypt.',
          );
        }
        plainPath = await this.decryptFileToTemp(dumpPath, masterKey);
        archivePath = plainPath;
      }

      extractDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kryptalis-restore-'));
      await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], {
        timeout: 1_800_000,
        maxBuffer: 8 * 1024 * 1024,
      });

      const manifestPath = path.join(extractDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        throw new BadRequestException(
          'Backup archive has no manifest.json — not a Kryptalis backup archive.',
        );
      }
      let manifest: BackupManifest;
      try {
        manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      } catch (err) {
        throw new BadRequestException(
          `Backup manifest is unreadable: ${(err as Error).message}`,
        );
      }

      let databasesRestored = 0;
      for (const entry of manifest.databases ?? []) {
        try {
          await this.restoreDatabase(extractDir, entry);
          databasesRestored++;
        } catch (err) {
          throw new BadRequestException(
            `Restore failed at database "${entry.name}": ${(err as Error).message}`,
          );
        }
      }

      let volumesRestored = 0;
      for (const vol of manifest.volumes ?? []) {
        try {
          await this.restoreVolume(extractDir, vol);
          volumesRestored++;
        } catch (err) {
          throw new BadRequestException(
            `Restore failed at volume "${vol}" (after ${databasesRestored} database(s) restored): ${(err as Error).message}`,
          );
        }
      }

      this.logger.log(
        `Backup ${id} restored: ${databasesRestored} database(s), ${volumesRestored} volume(s).`,
      );
      return {
        message: 'Restore completed.',
        backupId: id,
        databasesRestored,
        volumesRestored,
      };
    } finally {
      if (extractDir) {
        await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
      }
      // The decrypted plaintext and any downloaded temp copy must never
      // outlive the restore — success or failure.
      if (plainPath) {
        await fs.promises.unlink(plainPath).catch(() => undefined);
      }
      if (tmpDownload) {
        await fs.promises.unlink(tmpDownload).catch(() => undefined);
      }
    }
  }

  async remove(userId: string, id: string) {
    const backup = await this.assertBackupAccess(userId, id);
    if (isRemoteTarget(backup.target)) {
      // Best-effort — never blocks row deletion (see deleteRemoteObjects).
      await this.deleteRemoteObjects(id);
    } else if (backup.filename) {
      await fs.promises
        .unlink(path.join(BACKUPS_DIR, path.basename(backup.filename)))
        .catch(() => undefined);
    }
    await this.prisma.backup.delete({ where: { id } });
    return { message: 'Backup deleted' };
  }
}
