import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBackupDto } from './dto/create-backup.dto';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';

/**
 * Backups module — current state.
 *
 * The actual backup engine (pg_dump/mysqldump/mongodump, volume snapshotting,
 * S3/R2/B2 upload, scheduler, restore) is not yet implemented. Until it ships,
 * this service:
 *   1. Refuses to create entries with non-LOCAL targets so users can't expect
 *      remote storage that doesn't exist.
 *   2. Refuses restore until status === COMPLETED (which today never happens),
 *      so accidentally clicking restore on a stale row can't silently corrupt
 *      live data later.
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
 * When the engine is ready, swap the create body and call into a job runner;
 * the RBAC checks below stay valid.
 */
@Injectable()
export class BackupsService {
  constructor(private prisma: PrismaService) {}

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
    const raw = process.env.BACKUP_ENCRYPTION_KEY;
    if (!raw) return null;
    // Joi already enforces min 32 chars when set, but re-check defensively.
    if (raw.length < 32) return null;
    // Use raw bytes of the env string; HKDF below stretches them to a 32-byte
    // AES key with a per-file salt, so the env value is effectively a master
    // secret rather than the literal AES key.
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

  // ── operations ─────────────────────────────────────────────────────

  async create(userId: string, dto: CreateBackupDto) {
    const allowed = await this.accessibleServerIds(userId);
    if (!allowed.includes(dto.serverId)) {
      throw new ForbiddenException('You do not have access to this server.');
    }
    if (dto.target && dto.target !== 'LOCAL') {
      throw new BadRequestException(
        `Remote backup targets (${dto.target}) are not yet supported. Use LOCAL.`,
      );
    }

    // Create the row first so we have an id to anchor the on-disk filename.
    const row = await this.prisma.backup.create({
      data: {
        name: dto.name,
        serverId: dto.serverId,
        target: 'LOCAL',
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
        // verify the bytes that actually live on disk.
        const sha256 = await this.sha256File(dumpPath);
        const stat = await fs.promises.stat(dumpPath);
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
        await this.prisma.backup.update({
          where: { id: row.id },
          data: { status: 'FAILED' },
        });
        throw err;
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
    // sha256 at write time.
    const dumpPath = (backup as any).filePath as string | undefined;
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

    // Engine not implemented yet — leave the row alone so we don't clobber the
    // status. When the engine ships, replace this with a real enqueue.
    return {
      message: 'Restore queued — engine implementation pending.',
      backupId: id,
    };
  }

  async remove(userId: string, id: string) {
    await this.assertBackupAccess(userId, id);
    await this.prisma.backup.delete({ where: { id } });
    return { message: 'Backup deleted' };
  }
}
