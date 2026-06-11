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
import { AgentService, AgentTaskCompletion } from '../agent/agent.service';
import { deterministicVolumeNames } from '../agent/volume-naming.util';
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
 * Remote (agent-managed) servers:
 *   - create() on a remote server enqueues a BACKUP agent task instead of
 *     running the dump engine locally. The task payload carries the resolved
 *     database credentials (same container names as dumpDatabases; passwords
 *     ride ENCRYPTED in the stored payload and are decrypted by
 *     AgentService.poll() when served to the authenticated agent — the
 *     agent_tasks Json column never holds plaintext credentials),
 *     the deterministic volume list, an uploadName and the
 *     backupId — the agent dumps everything host-side, tars it and streams
 *     the archive back through POST /agent/transfers/<taskId>/upload. The
 *     row stays IN_PROGRESS until the task result arrives; the BACKUP
 *     completion handler (registered with AgentService) then moves the
 *     archive from transfers/ into BACKUPS_DIR and replays the exact local
 *     finalize flow (encrypt → sha256 → S3 upload for remote targets →
 *     COMPLETED + notification). A FAILED task fails the row.
 *     Volume coverage note: the API cannot run `docker volume ls` on a
 *     remote host, so the volume list is built deterministically from the
 *     compose-project naming convention (<appDir>_data / <dbName>_data via
 *     volume-naming.util). Stacks declaring differently-named volumes are
 *     NOT covered by remote dumps. Application metadata (applications.json)
 *     is also not included in remote dumps — it lives in the API DB anyway.
 *   - restore() of a backup whose server is remote stages the verified (and
 *     decrypted, if applicable) archive under transfers/<local-id>/ and
 *     enqueues a RESTORE task ({downloadName, sourceTaskId, databases,
 *     volumes}) on that server, returning "queued" immediately. The async
 *     task result is only logged (RESTORE completion handler) — the row is
 *     not mutated; the generic transfer cleanup removes the staged archive
 *     when the task terminates.
 *   - The scheduler still skips remote servers (template gate unchanged).
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
    private agent: AgentService,
  ) {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }

  onModuleInit() {
    // Remote-backup finalizer + remote-restore logger — must be registered
    // even in test runs (specs exercise the handlers directly).
    this.agent.registerTaskCompletionHandler('BACKUP', (task) =>
      this.onRemoteBackupTaskResult(task),
    );
    this.agent.registerTaskCompletionHandler('RESTORE', async (task) => {
      // Remote restores are fire-and-forget: nothing to mutate, just log the
      // outcome so operators can correlate (documented in restore()).
      if (task.status === 'COMPLETED') {
        this.logger.log(`Remote restore task ${task.id} completed.`);
      } else {
        this.logger.error(`Remote restore task ${task.id} failed: ${task.error ?? 'unknown error'}`);
      }
    });

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
      select: {
        project: {
          select: {
            serverId: true,
            // Per-app placement: include servers where the member's apps run.
            applications: { select: { serverId: true } },
          },
        },
      },
    });
    const ids = new Set<string>();
    for (const m of memberships) {
      if (m.project.serverId) ids.add(m.project.serverId);
      for (const a of m.project.applications ?? []) {
        if (a.serverId) ids.add(a.serverId);
      }
    }
    return Array.from(ids);
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

        // Double-run guard: skip while the template's own initial dump or a
        // previously spawned child is still PENDING / IN_PROGRESS. For
        // remote servers this also covers in-flight agent dumps — the
        // Backup row stays IN_PROGRESS until onRemoteBackupTaskResult
        // flips it, so the same status check suffices. Belt-and-braces:
        // also skip while a BACKUP agent task is QUEUED/RUNNING on the
        // server (covers a row/task state divergence after an API crash).
        const running = await this.prisma.backup.findFirst({
          where: {
            serverId: tpl.serverId,
            status: { in: ['PENDING', 'IN_PROGRESS'] },
            OR: [{ id: tpl.id }, { schedule: null, name: { startsWith: `${tpl.name} (` } }],
          },
          select: { id: true },
        });
        if (running) continue;
        if (!isLocalHost(tpl.server.host)) {
          const inflightTask = await this.prisma.agentTask.findFirst({
            where: { serverId: tpl.serverId, type: 'BACKUP', status: { in: ['QUEUED', 'RUNNING'] } },
            select: { id: true },
          });
          if (inflightTask) continue;
        }

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

    // Remote (agent-managed) server → delegate the whole dump to the agent.
    // The row stays IN_PROGRESS until the BACKUP task result arrives (see
    // onRemoteBackupTaskResult). Enqueue failures fail the row immediately.
    if (!isLocalHost(backup.server.host)) {
      try {
        await this.enqueueRemoteBackup(backup);
        this.logger.log(`Backup ${backupId} delegated to remote agent on server ${backup.serverId}.`);
      } catch (err) {
        await this.failBackup(backup, (err as Error).message);
      }
      return;
    }

    const filename = `${backupId}.tar.gz`;
    const archivePath = path.join(BACKUPS_DIR, filename);
    const stagingDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kryptalis-backup-'));
    try {
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

      await this.finalizeBackupArchive(backup, archivePath, filename);
    } catch (err) {
      await fs.promises.unlink(archivePath).catch(() => undefined);
      await this.failBackup(backup, (err as Error).message);
    } finally {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Shared tail of every backup job (local dump OR remote agent dump): the
   * raw archive already sits at `archivePath` inside BACKUPS_DIR — encrypt
   * in place when a key is configured, hash + stat the final bytes, upload
   * to S3 for remote targets (dropping the local copy), then flip the row
   * to COMPLETED and notify.
   */
  private async finalizeBackupArchive(
    backup: { id: string; name: string; serverId: string; target: string },
    archivePath: string,
    filename: string,
  ): Promise<void> {
    const backupId = backup.id;
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
  }

  /** Flip the row to FAILED + notify — shared by local and remote paths. */
  private async failBackup(
    backup: { id: string; name: string; serverId: string },
    message: string,
  ): Promise<void> {
    await this.prisma.backup
      .update({ where: { id: backup.id }, data: { status: 'FAILED' } })
      .catch(() => undefined);
    this.logger.error(`Backup ${backup.id} failed: ${message}`);
    this.notifications
      .sendBackupResult({
        backupId: backup.id,
        name: backup.name,
        serverId: backup.serverId,
        status: 'FAILED',
        error: message,
      })
      .catch(() => {});
  }

  // ── remote (agent-managed) servers ─────────────────────────────────

  /**
   * Resolve the database-dump descriptors for a remote BACKUP task — the
   * same container names / credentials / dumpAll semantics dumpDatabases
   * derives, but handed to the agent instead of executed via local
   * `docker exec`.
   *
   * SECURITY: the password rides ENCRYPTED in the task payload (the
   * agent_tasks row is plain Json in the DB) — AgentService.poll() decrypts
   * it transparently at the moment the task is served to the authenticated
   * agent. decrypt-then-encrypt guarantees a v1 ciphertext even for legacy
   * plaintext password columns.
   */
  private async remoteBackupDatabases(serverId: string) {
    const dbs = await this.prisma.database.findMany({ where: { serverId } });
    return dbs.map((db) => ({
      id: db.id,
      type: db.type,
      container: this.dbContainerName(db),
      username: db.username,
      password: this.encryption.encrypt(this.encryption.decrypt(db.password)),
      name: db.name,
      dumpAll: db.autoImported,
    }));
  }

  /**
   * Deterministic volume list for a remote server. We can't `docker volume
   * ls` over there, so derive `<composeProject>_data` names from the same
   * resolveAppDir/DBS_DIR conventions the deploy paths use. DOCUMENTED
   * LIMITATION: volumes that don't follow the `_data` naming (multi-volume
   * stacks, marketplace instance-suffixed keys, user compose files) are not
   * enumerated and therefore not covered by remote dumps.
   */
  private async remoteBackupVolumes(serverId: string): Promise<string[]> {
    const [apps, dbs] = await Promise.all([
      this.prisma.application.findMany({
        where: { project: { serverId } },
        select: { id: true, name: true },
      }),
      this.prisma.database.findMany({
        where: { serverId },
        select: { name: true, autoImported: true },
      }),
    ]);
    return deterministicVolumeNames(apps, dbs);
  }

  /**
   * Enqueue a BACKUP task on the remote agent. The agent dumps the listed
   * databases + volumes, builds `<uploadName>` (tar.gz with the same
   * manifest layout as the local engine) and uploads it under its own
   * taskId via /agent/transfers. backupId rides in the payload so the
   * completion handler can find the row — no schema change needed.
   */
  private async enqueueRemoteBackup(backup: {
    id: string;
    serverId: string;
    includeDatabases: boolean;
    includeVolumes: boolean;
  }): Promise<void> {
    const databases = backup.includeDatabases
      ? await this.remoteBackupDatabases(backup.serverId)
      : [];
    const volumes = backup.includeVolumes
      ? await this.remoteBackupVolumes(backup.serverId)
      : [];
    await this.agent.enqueueTask(backup.serverId, 'BACKUP', {
      backupId: backup.id,
      databases,
      volumes,
      uploadName: `${backup.id}.tar.gz`,
    });
  }

  /**
   * BACKUP agent-task completion handler (registered in onModuleInit).
   * COMPLETED → move the uploaded archive from transfers/<taskId>/ into
   * BACKUPS_DIR/<backupId>.tar.gz and replay the local finalize flow
   * (encrypt → sha256 → S3 → COMPLETED + notification). FAILED → row FAILED.
   * The transfers dir itself is cleaned up by the agent service's generic
   * post-terminal sweep.
   */
  async onRemoteBackupTaskResult(task: AgentTaskCompletion): Promise<void> {
    const backupId = task.payload?.backupId;
    if (typeof backupId !== 'string' || !backupId) return; // not ours
    const backup = await this.prisma.backup.findUnique({ where: { id: backupId } });
    if (!backup) {
      this.logger.warn(`BACKUP task ${task.id} completed but backup row ${backupId} is gone.`);
      return;
    }
    if (backup.status !== 'IN_PROGRESS' && backup.status !== 'PENDING') {
      return; // already finalized (duplicate/stale report)
    }

    if (task.status === 'FAILED') {
      await this.failBackup(backup, task.error || 'Remote agent backup task failed');
      return;
    }

    const uploadName = path.basename(String(task.payload?.uploadName || `${backupId}.tar.gz`));
    const uploadedPath = path.join(this.agent.transferDir(task.id), uploadName);
    const filename = `${backupId}.tar.gz`;
    const archivePath = path.join(BACKUPS_DIR, filename);
    try {
      if (!fs.existsSync(uploadedPath)) {
        throw new Error('Agent reported success but the uploaded archive is missing from transfers/.');
      }
      // rename() fails across devices/volumes — fall back to copy+unlink.
      try {
        await fs.promises.rename(uploadedPath, archivePath);
      } catch {
        await fs.promises.copyFile(uploadedPath, archivePath);
        await fs.promises.unlink(uploadedPath).catch(() => undefined);
      }
      await this.finalizeBackupArchive(backup, archivePath, filename);
    } catch (err) {
      await fs.promises.unlink(archivePath).catch(() => undefined);
      await this.failBackup(backup, (err as Error).message);
    }
  }

  /**
   * Remote restore: stage the verified (and already-decrypted) archive under
   * transfers/<local-id>/, then enqueue a RESTORE task carrying the manifest's
   * database descriptors (re-resolved against live rows for fresh container
   * names; credentials ride encrypted in the stored payload — see
   * remoteBackupDatabases) and volume list. The agent downloads the
   * archive via /agent/transfers (sourceTaskId) and replays it host-side.
   */
  private async queueRemoteRestore(
    backup: { id: string; serverId: string },
    archivePath: string,
    manifest: BackupManifest,
  ) {
    const databases: Array<{
      id: string;
      type: string;
      container: string;
      username: string;
      password: string;
      name: string;
      dumpAll: boolean;
      file: string;
    }> = [];
    for (const entry of manifest.databases ?? []) {
      const db = await this.prisma.database.findUnique({ where: { id: entry.id } });
      if (!db) {
        throw new BadRequestException(
          `Restore failed: database "${entry.name}" no longer exists in the registry — recreate it first, then restore.`,
        );
      }
      databases.push({
        id: db.id,
        type: db.type,
        container: this.dbContainerName(db),
        username: db.username,
        // Encrypted in the stored payload (agent_tasks is plain Json);
        // AgentService.poll() decrypts when serving the task to the agent.
        password: this.encryption.encrypt(this.encryption.decrypt(db.password)),
        name: db.name,
        dumpAll: entry.dumpAll,
        file: entry.file,
      });
    }

    // Stage the plaintext archive where the agent can download it. The id is
    // a local transfer id (no AgentTask row) — the RESTORE task's
    // payload.sourceTaskId authorizes the agent's cross-id download.
    const sourceTaskId = this.agent.newLocalTransferId();
    const downloadName = `${backup.id}.tar.gz`;
    const stagedDir = this.agent.transferDir(sourceTaskId);
    await fs.promises.mkdir(stagedDir, { recursive: true });
    await fs.promises.copyFile(archivePath, path.join(stagedDir, downloadName));

    let task;
    try {
      task = await this.agent.enqueueTask(backup.serverId, 'RESTORE', {
        downloadName,
        sourceTaskId,
        databases,
        volumes: manifest.volumes ?? [],
      });
    } catch (err) {
      // No consumer will ever pull the staged copy — drop it now.
      await this.agent.cleanupTransfers(sourceTaskId);
      throw new BadRequestException(
        `Failed to queue remote restore: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `Backup ${backup.id} restore queued on remote server ${backup.serverId} (task ${task.id}).`,
    );
    return {
      message: 'Restore queued on remote server — the agent will apply it asynchronously.',
      backupId: backup.id,
      taskId: task.id,
      databasesQueued: databases.length,
      volumesQueued: (manifest.volumes ?? []).length,
    };
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
    const server = await this.prisma.server.findUnique({
      where: { id: backup.serverId },
      select: { host: true },
    });

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

      // Remote (agent-managed) server → the verified/decrypted archive is
      // staged under transfers/<local-id>/ and a RESTORE task is enqueued;
      // the agent downloads it and replays the dumps host-side. We return
      // immediately ("queued") — the async task result is only logged (see
      // the RESTORE completion handler in onModuleInit); the row is not
      // mutated. The staged archive is removed by the generic transfer
      // cleanup when the task terminates.
      if (server && !isLocalHost(server.host)) {
        return await this.queueRemoteRestore(backup, archivePath, manifest);
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
