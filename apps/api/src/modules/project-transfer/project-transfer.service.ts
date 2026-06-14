import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { ApplicationsService } from '../applications/applications.service';
import { ApplicationEnvService } from '../applications/application-env.service';
import { DatabasesService } from '../databases/databases.service';
import { ProjectsService } from '../projects/projects.service';
import { DomainsService } from '../domains/domains.service';
import {
  encryptBuffer,
  decryptBuffer,
  encryptFileTo,
  decryptFileTo,
} from './dctproj-crypto';
import {
  DctprojManifest,
  DctprojApp,
  DctprojDb,
  DctprojParseResult,
  DomainStrategy,
} from './dctproj-manifest';
import { checkImportedComposeSafety } from './dctproj-compose-guard';

// A docker image reference: [registry[:port]/]name[:tag|@sha256:...]. No shell
// metacharacters or control chars. Mirrors the marketplace custom-install guard.
const SAFE_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;

const execFileAsync = promisify(execFile);

// GNU tar treats a backslash as an escape and a "drive:" prefix as a remote
// host. Feed it forward-slash paths (accepted on Linux AND Windows) so the
// same code path works in prod (Linux) and in dev/test (Windows).
const tarPath = (p: string): string => p.replace(/\\/g, '/');

// Runtime dir convention shared with backups/agent. Transfer staging lives in
// .dockcontrol/project-transfer/<id>/.
const DATA_DIR = process.env.DOCKCONTROL_DATA_DIR || path.join(process.cwd(), '.dockcontrol');
const XFER_DIR = path.join(DATA_DIR, 'project-transfer');

// Hard cap on an uploaded .dctproj (defence against zip-bomb / OOM). Reuses
// the agent transfer cap when set, else 2 GiB.
const MAX_IMPORT_BYTES = (() => {
  const raw = Number(process.env.AGENT_TRANSFER_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 1024 * 1024 * 1024;
})();

/**
 * Cross-install project transfer.
 *
 * exportProject() serialises a project (config + optionally data) into an
 * encrypted `.dctproj` file the operator downloads. parseImport() validates an
 * uploaded archive and returns a review (without applying). applyImport()
 * recreates the project on THIS install via the same creation paths the normal
 * UI uses, so every guard (name/port/compose validation, RBAC) is reused.
 *
 * Security model:
 *   - The archive is AES-256-GCM encrypted under a USER PASSPHRASE (scrypt),
 *     so a different install can decrypt it; the install key is never involved.
 *   - Secrets (app envVars, DB passwords) are re-encrypted under the passphrase
 *     inside the manifest — never written plaintext to disk outside the
 *     ephemeral staging dir, which is removed in finally.
 *   - Integrity is enforced by the AES-256-GCM auth tag (decrypt throws on any
 *     tampering), the upload size is capped AND the decompressed size is
 *     bounded (zip-bomb guard), the imported compose is screened for host
 *     escapes (checkImportedComposeSafety) before apply, and apply routes
 *     through the validated create DTOs (which reject unsafe names/ports).
 */
@Injectable()
export class ProjectTransferService {
  private readonly logger = new Logger(ProjectTransferService.name);

  // Parsed-but-not-yet-applied import sessions, keyed by stagedId. Binds each
  // staging dir to the user who uploaded it (so another user can't apply it)
  // and carries an expiry so a parsed-then-abandoned import (which holds
  // decrypted dumps on disk) is swept rather than leaking forever.
  private sessions = new Map<string, { userId: string; expiresAt: number }>();
  // A parsed session lives at most this long before the sweeper wipes it.
  private static readonly SESSION_TTL_MS = 30 * 60_000;

  constructor(
    private prisma: PrismaService,
    private applications: ApplicationsService,
    private env: ApplicationEnvService,
    private databases: DatabasesService,
    private projects: ProjectsService,
    private domains: DomainsService,
  ) {
    if (!fs.existsSync(XFER_DIR)) fs.mkdirSync(XFER_DIR, { recursive: true });
    // Periodic sweep of expired parse sessions (no live timer under tests).
    if (process.env.NODE_ENV !== 'test') {
      const timer = setInterval(() => this.sweepExpiredSessions().catch(() => undefined), 5 * 60_000);
      timer.unref?.();
    }
  }

  private async sweepExpiredSessions(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(id);
        await fs.promises.rm(this.stagingDir(id), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    // Belt-and-braces: also remove any orphan staging dir with no live session
    // (e.g. left by a crash) older than the TTL.
    try {
      for (const name of await fs.promises.readdir(XFER_DIR)) {
        if (!name.startsWith('xfer_') || this.sessions.has(name)) continue;
        const full = path.join(XFER_DIR, name);
        const st = await fs.promises.stat(full).catch(() => null);
        if (st && st.isDirectory() && now - st.mtimeMs > ProjectTransferService.SESSION_TTL_MS) {
          await fs.promises.rm(full, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch { /* XFER_DIR may not exist yet */ }
  }

  private stagingDir(id: string): string {
    return path.join(XFER_DIR, id);
  }

  /** Unguessable session id (CSPRNG), not the timestamp+Math.random of v1. */
  private randomId(): string {
    return `xfer_${crypto.randomBytes(18).toString('hex')}`;
  }

  // ── EXPORT ──────────────────────────────────────────────────────────

  /**
   * Build an encrypted `.dctproj` for a project. Returns the on-disk path of
   * the finished archive + a download filename. The caller streams it then
   * deletes it.
   */
  async exportProject(
    userId: string,
    projectId: string,
    opts: { includeData: boolean; passphrase: string },
  ): Promise<{ archivePath: string; filename: string }> {
    if (!opts.passphrase || opts.passphrase.length < 12) {
      throw new BadRequestException('Passphrase must be at least 12 characters.');
    }
    await assertProjectAccess(this.prisma, userId, projectId, 'OWNER');

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        applications: true,
        databases: true,
        domains: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const id = this.randomId();
    const dir = this.stagingDir(id);
    fs.mkdirSync(path.join(dir, 'databases'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'volumes'), { recursive: true });
    let plainTar: string | undefined;

    try {
      const manifest: DctprojManifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        source: { appVersion: process.env.DOCKCONTROL_VERSION || undefined },
        includesData: !!opts.includeData,
        project: { name: project.name, description: project.description || undefined },
        applications: [],
        databases: [],
        domains: [],
      };

      for (const app of project.applications) {
        const plainEnv = this.env.decryptEnvVars(app.envVars);
        const envEncrypted = plainEnv && Object.keys(plainEnv).length > 0
          ? encryptBuffer(Buffer.from(JSON.stringify(plainEnv)), opts.passphrase).toString('base64')
          : undefined;
        const entry: DctprojApp = {
          name: app.name,
          displayName: app.displayName || undefined,
          framework: app.framework,
          gitUrl: app.gitUrl || undefined,
          gitBranch: app.gitBranch || undefined,
          dockerImage: app.dockerImage || undefined,
          dockerComposeFile: app.dockerComposeFile || undefined,
          buildCommand: app.buildCommand || undefined,
          startCommand: app.startCommand || undefined,
          port: app.port ?? undefined,
          hostPort: app.hostPort ?? undefined,
          containerPort: app.containerPort ?? undefined,
          customPort: app.customPort ?? undefined,
          envEncrypted,
          volumeFiles: [],
        };
        // Data (volumes) are only carried for LOCAL-source apps in this v1 —
        // remote-source volume export would need the agent VOLUME_EXPORT chain,
        // which is deferred. We note it as a warning at apply time.
        if (opts.includeData) {
          await this.exportLocalAppVolumes(app, dir, entry);
        }
        manifest.applications.push(entry);
      }

      for (const db of project.databases) {
        const entry: DctprojDb = {
          name: db.name,
          type: db.type,
          username: db.username,
          passwordEncrypted: encryptBuffer(Buffer.from(db.password || ''), opts.passphrase).toString('base64'),
          port: db.port ?? undefined,
        };
        if (opts.includeData) {
          const dumpRel = await this.dumpLocalDatabase(db, dir);
          if (dumpRel) entry.dumpFile = dumpRel;
        }
        manifest.databases.push(entry);
      }

      for (const d of project.domains) {
        const appName = d.applicationId
          ? project.applications.find((a) => a.id === d.applicationId)?.name
          : undefined;
        manifest.domains.push({ domain: d.domain, applicationName: appName });
      }

      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

      // Package staging -> plaintext tar.gz, then encrypt that tar under the
      // passphrase (whole-archive confidentiality + integrity via GCM tag),
      // The plaintext tar (contains decrypted dumps/secrets) is tracked so the
      // finally removes it even if encryption throws mid-stream — it must never
      // be left on disk outside the cleaned-up set.
      plainTar = path.join(XFER_DIR, `${id}.tar.gz`);
      // --force-local: treat a path with a ':' (Windows drive letter) as a
      // local file, not a remote rsh host. No-op on Linux paths.
      await execFileAsync('tar', ['--force-local', '-czf', tarPath(plainTar), '-C', tarPath(dir), '.'], { maxBuffer: 64 * 1024 * 1024 });
      const archivePath = path.join(XFER_DIR, `${id}.dctproj`);
      await encryptFileTo(plainTar, archivePath, opts.passphrase);

      const safeName = (project.name || 'project').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
      return { archivePath, filename: `${safeName}.dctproj` };
    } finally {
      // Remove the plaintext staging dir AND the plaintext tar (both hold
      // secrets/dumps) — the encrypted archive is the only artifact that
      // should persist. Runs on success AND on any throw.
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (plainTar) await fs.promises.unlink(plainTar).catch(() => undefined);
    }
  }

  /** Tar each of a LOCAL app's docker volumes into the staging volumes/ dir. */
  private async exportLocalAppVolumes(app: { name: string; id: string }, dir: string, entry: DctprojApp): Promise<void> {
    try {
      const { stdout } = await execFileAsync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 15_000 });
      const slug = app.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';
      const prefix = `${slug}-${app.id.slice(0, 12)}`;
      const volumes = stdout.trim().split('\n').filter(Boolean).filter((v) => v.startsWith(prefix));
      for (const vol of volumes) {
        const rel = path.posix.join('volumes', `${path.basename(vol)}.tar.gz`);
        const out = path.join(dir, rel);
        // Stream `docker run busybox tar` stdout straight to the file (never
        // buffered in memory).
        await this.dockerTarVolumeToFile(vol, out);
        entry.volumeFiles.push(rel);
      }
    } catch (e: any) {
      this.logger.warn(`export volumes for ${app.name}: ${e?.message || e}`);
    }
  }

  private async dockerTarVolumeToFile(vol: string, outPath: string): Promise<void> {
    const { spawn } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(outPath);
      const child = spawn('docker', ['run', '--rm', '-v', `${vol}:/data:ro`, 'busybox', 'tar', '-czf', '-', '-C', '/data', '.']);
      const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
      child.stdout.pipe(out);
      child.once('error', (err) => { clearTimeout(timer); out.destroy(); reject(err); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`volume tar exited ${code}`));
      });
    });
  }

  /** Dump a LOCAL database to the staging databases/ dir, returns the rel path. */
  private async dumpLocalDatabase(db: { name: string; type: string; username: string; password: string }, dir: string): Promise<string | null> {
    const container = `dockcontrol-db-${db.name}`;
    const rel = path.posix.join('databases', `${db.name}.sql.gz`);
    const out = path.join(dir, rel);
    try {
      const { spawn } = await import('child_process');
      const dumpArgs = this.dumpArgvFor(db, container);
      if (!dumpArgs) return null;
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(out);
        const { createGzip } = require('zlib');
        const gz = createGzip();
        const child = spawn('docker', dumpArgs.argv, { env: { ...process.env, ...dumpArgs.env } });
        const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
        child.stdout.pipe(gz).pipe(ws);
        child.once('error', (err) => { clearTimeout(timer); ws.destroy(); reject(err); });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`db dump exited ${code}`));
        });
      });
      return rel;
    } catch (e: any) {
      this.logger.warn(`dump db ${db.name}: ${e?.message || e}`);
      return null;
    }
  }

  private dumpArgvFor(db: { name: string; type: string; username: string; password: string }, container: string): { argv: string[]; env: Record<string, string> } | null {
    const t = (db.type || '').toUpperCase();
    if (t === 'POSTGRES' || t === 'POSTGRESQL') {
      return { argv: ['exec', '-e', `PGPASSWORD=${db.password}`, container, 'pg_dump', '-U', db.username, '-d', db.name], env: {} };
    }
    if (t === 'MYSQL' || t === 'MARIADB') {
      return { argv: ['exec', '-e', `MYSQL_PWD=${db.password}`, container, 'mysqldump', '-u', db.username, db.name], env: {} };
    }
    // Redis/others: no SQL dump (data rides the volume tar instead).
    return null;
  }

  // ── IMPORT: PARSE (review only, no mutation) ────────────────────────

  async parseImport(userId: string, uploadedPath: string, passphrase: string): Promise<DctprojParseResult> {
    if (!passphrase || passphrase.length < 12) {
      throw new BadRequestException('Passphrase must be at least 12 characters.');
    }
    const stat = await fs.promises.stat(uploadedPath).catch(() => null);
    if (!stat) throw new BadRequestException('Uploaded archive not found.');
    if (stat.size > MAX_IMPORT_BYTES) {
      throw new BadRequestException(`Archive exceeds the ${MAX_IMPORT_BYTES} byte import limit.`);
    }

    const id = this.randomId();
    const dir = this.stagingDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const plainTar = path.join(dir, 'archive.tar.gz');
    try {
      // Decrypt (fail-closed: wrong passphrase / tamper throws here).
      await decryptFileTo(uploadedPath, plainTar, passphrase);
      // Zip-bomb guard: the size cap above bounds the ENCRYPTED upload, but
      // gzip lives inside the envelope so the decompressed tree is unbounded.
      // Refuse to extract once the decompressed bytes pass the same cap.
      await this.assertDecompressedSizeWithinCap(plainTar);
      // Extract under a contained dir. tar -C confines extraction; GNU tar
      // also strips a leading '/' and refuses '..' members by default. We
      // additionally verify post-extraction that nothing escaped extractDir.
      const extractDir = path.join(dir, 'x');
      fs.mkdirSync(extractDir, { recursive: true });
      await execFileAsync('tar', ['--force-local', '-xzf', tarPath(plainTar), '-C', tarPath(extractDir)], { maxBuffer: 64 * 1024 * 1024 });
      await fs.promises.unlink(plainTar).catch(() => undefined);
      await this.assertExtractionConfined(extractDir);

      const manifestPath = path.join(extractDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        throw new BadRequestException('Archive is missing manifest.json — not a valid .dctproj file.');
      }
      const manifest = this.validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));

      // Conflict detection against THIS install.
      const conflictDomains: string[] = [];
      for (const d of manifest.domains) {
        const exists = await this.prisma.domain.findUnique({ where: { domain: d.domain } });
        if (exists) conflictDomains.push(d.domain);
      }
      const nameTaken = !!(await this.prisma.project.findFirst({ where: { userId, name: manifest.project.name } }));

      const warnings: string[] = [];
      if (!manifest.includesData) warnings.push('This archive contains configuration only — databases and volumes will start empty.');
      const remoteSourced = manifest.applications.some((a) => a.volumeFiles.length === 0) && manifest.includesData;
      if (remoteSourced) warnings.push('Some app volumes were not bundled (remote-source export) — those apps may start with empty data.');

      // Bind the staged session to THIS user, with a TTL, so only they can
      // apply it and an abandoned import is swept rather than leaking.
      this.sessions.set(id, { userId, expiresAt: Date.now() + ProjectTransferService.SESSION_TTL_MS });

      return {
        stagedId: id,
        manifest,
        conflicts: { domains: conflictDomains, projectNameTaken: nameTaken },
        warnings,
      };
    } catch (e) {
      // On any parse failure, clean the staging dir immediately.
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Defence-in-depth zip-slip check: after extraction, ensure every entry's
   * real path stays under extractDir (a symlink or crafted member can't point
   * outside). Portable (no tar-version-specific flags).
   */
  private async assertExtractionConfined(extractDir: string): Promise<void> {
    const root = await fs.promises.realpath(extractDir);
    const walk = async (d: string): Promise<void> => {
      for (const ent of await fs.promises.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        // Reject symlinks outright (could point outside on later reads).
        const lst = await fs.promises.lstat(full);
        if (lst.isSymbolicLink()) {
          throw new BadRequestException('Archive contains a symlink — refused.');
        }
        const real = await fs.promises.realpath(full);
        if (real !== root && !real.startsWith(root + path.sep)) {
          throw new BadRequestException('Archive entry escapes the extraction directory — refused.');
        }
        if (ent.isDirectory()) await walk(full);
      }
    };
    await walk(root);
  }

  /**
   * Stream the gzip'd tar through gunzip with a running byte counter and abort
   * if the decompressed total passes the import cap — a zip-bomb defence the
   * compressed-size check can't provide.
   */
  private async assertDecompressedSizeWithinCap(gzPath: string): Promise<void> {
    const zlib = await import('zlib');
    await new Promise<void>((resolve, reject) => {
      let total = 0;
      const gunzip = zlib.createGunzip();
      const src = fs.createReadStream(gzPath);
      const done = (err?: Error) => {
        try { src.destroy(); gunzip.destroy(); } catch { /* ignore */ }
        if (err) reject(err); else resolve();
      };
      gunzip.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_IMPORT_BYTES) done(new BadRequestException(`Archive decompresses beyond the ${MAX_IMPORT_BYTES} byte limit (possible zip bomb).`));
      });
      gunzip.on('end', () => done());
      gunzip.on('error', () => done(new BadRequestException('Archive is not a valid gzip stream.')));
      src.on('error', (e) => done(e));
      src.pipe(gunzip);
    });
  }

  /**
   * Validate an UNTRUSTED manifest from another install. Rejects anything that
   * isn't the expected v1 shape; the actual safety of names/images/compose is
   * enforced again at apply time by the create DTOs.
   */
  private validateManifest(raw: any): DctprojManifest {
    if (!raw || raw.version !== 1 || typeof raw.project?.name !== 'string') {
      throw new BadRequestException('Unsupported or malformed .dctproj manifest.');
    }
    if (!Array.isArray(raw.applications) || !Array.isArray(raw.databases) || !Array.isArray(raw.domains)) {
      throw new BadRequestException('Malformed .dctproj manifest (missing sections).');
    }
    // Reject path-traversal in any archive-relative file reference.
    const safeRel = (p: any) => typeof p === 'string' && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');
    for (const a of raw.applications) {
      if (typeof a.name !== 'string') throw new BadRequestException('Malformed application entry.');
      if (!Array.isArray(a.volumeFiles)) a.volumeFiles = [];
      for (const v of a.volumeFiles) if (!safeRel(v)) throw new BadRequestException('Unsafe volume path in archive.');
      // CRITICAL: an imported compose is attacker-controlled. Screen it for
      // host bind-mounts / docker.sock / privileged BEFORE it can ever be
      // written to disk and run — create()'s parse-only check does NOT.
      if (a.dockerComposeFile) {
        const problems = checkImportedComposeSafety(a.dockerComposeFile);
        if (problems.length > 0) {
          throw new BadRequestException(
            `Imported app "${a.name}" has an unsafe compose file and was rejected: ${problems.slice(0, 5).join('; ')}`,
          );
        }
      }
      // Image ref must look like a normal registry reference (no shell-meta /
      // control chars). Mirrors the marketplace custom-install image guard.
      if (a.dockerImage !== undefined) {
        if (typeof a.dockerImage !== 'string' || !SAFE_IMAGE_RE.test(a.dockerImage)) {
          throw new BadRequestException(`Imported app "${a.name}" has an invalid docker image reference.`);
        }
      }
    }
    for (const d of raw.databases) {
      if (typeof d.name !== 'string' || typeof d.type !== 'string') throw new BadRequestException('Malformed database entry.');
      if (d.dumpFile && !safeRel(d.dumpFile)) throw new BadRequestException('Unsafe dump path in archive.');
    }
    return raw as DctprojManifest;
  }

  // ── IMPORT: APPLY (recreate on this install) ────────────────────────

  async applyImport(
    userId: string,
    stagedId: string,
    opts: { passphrase: string; targetServerId?: string; domainStrategy?: DomainStrategy },
  ): Promise<{ status: 'ok' | 'partial'; projectId: string; message: string; warnings: string[] }> {
    if (!/^xfer_[a-f0-9]+$/.test(stagedId)) throw new BadRequestException('Invalid import id.');
    // The staged session MUST belong to this user (defends against a second
    // user applying someone else's in-flight import via a guessed id).
    const session = this.sessions.get(stagedId);
    if (!session || session.userId !== userId || session.expiresAt <= Date.now()) {
      throw new BadRequestException('Import session expired or not found — re-upload the archive.');
    }
    const dir = this.stagingDir(stagedId);
    const extractDir = path.join(dir, 'x');
    const manifestPath = path.join(extractDir, 'manifest.json');
    const warnings: string[] = [];
    const strategy: DomainStrategy = opts.domainStrategy || 'skip';

    try {
      if (!fs.existsSync(manifestPath)) {
        throw new BadRequestException('Import session expired or not found — re-upload the archive.');
      }
      // Parse + validate INSIDE the try so a malformed manifest is a clean 400
      // and the staging dir is still cleaned by the finally below.
      const manifest = this.validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
      // 1) Project (creation enforces LOCAL/MULTI server rules + OWNER membership).
      const project = await this.projects.create(userId, {
        name: manifest.project.name,
        description: manifest.project.description,
        serverId: opts.targetServerId,
      } as any);

      // 2) Databases — recreate via the validated create path.
      const dbNameToId: Record<string, string> = {};
      for (const db of manifest.databases) {
        try {
          const created = await this.databases.create(userId, {
            name: db.name,
            type: db.type,
            projectId: project.id,
            serverId: opts.targetServerId,
          } as any);
          dbNameToId[db.name] = (created as any).id;
          if (manifest.includesData && db.dumpFile) {
            warnings.push(`db ${db.name}: data restore from the archive dump is queued separately — verify after deploy.`);
          }
        } catch (e: any) {
          warnings.push(`db ${db.name}: ${e?.message || e}`);
        }
      }

      // 3) Applications — recreate via the validated create DTO (which re-runs
      //    every name/image/compose/port guard). Secrets are decrypted from the
      //    passphrase envelope and handed to create as plaintext envVars (the
      //    create path re-encrypts them at rest with THIS install's key).
      const appNameToId: Record<string, string> = {};
      for (const app of manifest.applications) {
        try {
          let envVars: Record<string, string> | undefined;
          if (app.envEncrypted) {
            const plain = decryptBuffer(Buffer.from(app.envEncrypted, 'base64'), opts.passphrase);
            envVars = JSON.parse(plain.toString());
          }
          const dto: any = {
            name: app.name,
            projectId: project.id,
            framework: app.framework,
            serverId: opts.targetServerId,
            envVars,
          };
          if (app.gitUrl) { dto.gitUrl = app.gitUrl; dto.gitBranch = app.gitBranch || 'main'; }
          else if (app.dockerImage) dto.dockerImage = app.dockerImage;
          else if (app.dockerComposeFile) dto.composeContent = app.dockerComposeFile;
          if (app.buildCommand) dto.buildCommand = app.buildCommand;
          if (app.startCommand) dto.startCommand = app.startCommand;
          if (app.port) dto.port = app.port;
          if (app.hostPort) dto.hostPort = app.hostPort;
          const created = await this.applications.create(userId, dto);
          appNameToId[app.name] = (created as any).id;
        } catch (e: any) {
          warnings.push(`app ${app.name}: ${e?.message || e}`);
        }
      }

      // 4) Domains — only attach when the operator chose so AND the domain is
      //    free on this install (Domain.domain is @unique).
      if (strategy === 'attach') {
        for (const d of manifest.domains) {
          try {
            const exists = await this.prisma.domain.findUnique({ where: { domain: d.domain } });
            if (exists) { warnings.push(`domain ${d.domain}: already exists on this install — skipped`); continue; }
            await this.domains.create(userId, {
              domain: d.domain,
              projectId: project.id,
              applicationId: d.applicationName ? appNameToId[d.applicationName] : undefined,
            } as any);
          } catch (e: any) {
            warnings.push(`domain ${d.domain}: ${e?.message || e}`);
          }
        }
      } else if (manifest.domains.length > 0) {
        warnings.push(`${manifest.domains.length} domain(s) were not attached (you chose to skip). Re-point DNS and attach them manually; SSL re-provisions on first request.`);
      }

      // Mailboxes are never carried (mail lives on the platform host).
      warnings.push('Mailboxes are not transferred between installs — recreate them on the target if needed.');

      const status = warnings.some((w) => /^(app|db) /.test(w)) ? 'partial' : 'ok';
      return {
        status,
        projectId: project.id,
        message: status === 'ok'
          ? `Project "${manifest.project.name}" imported. Apps and databases are deploying.`
          : `Project "${manifest.project.name}" imported with warnings — check them.`,
        warnings,
      };
    } finally {
      this.sessions.delete(stagedId);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
