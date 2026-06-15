import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
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
import { slugify, resolveAppDir, findComposePath, APPS_DIR } from '../applications/applications.helpers';
import { appVolumePrefix } from '../agent/volume-naming.util';
import { resolveDbContainer, dumpPlan, restorePlan } from '../databases/db-dump.util';

// A docker image reference: [registry[:port]/]name[:tag|@sha256:...]. No shell
// metacharacters or control chars. Mirrors the marketplace custom-install guard.
const SAFE_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;

const execFileAsync = promisify(execFile);

// Cross-platform tar shim. In production the API runs on Alpine where `tar` is
// BusyBox, which does NOT understand GNU's `--force-local` (an unknown flag
// makes it exit non-zero → the whole export/import 500s). On Windows dev/test
// the path carries a drive letter (`C:\...`) that GNU tar mistakes for an rsh
// host, so there we DO need `--force-local` + forward-slash paths. Branch on
// the platform: Linux/Alpine gets the plain invocation backups already use.
const isWin = process.platform === 'win32';
const tarPath = (p: string): string => (isWin ? p.replace(/\\/g, '/') : p);
const tarArgs = (...rest: string[]): string[] => (isWin ? ['--force-local', ...rest] : rest);

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
        // A marketplace / compose app stores its docker-compose.yml ONLY on
        // disk (the DB column is null), so fall back to reading it from the
        // app dir — otherwise the import has no stack to recreate and the app
        // lands STOPPED. Reuse the same dir resolution lifecycle ops use.
        let composeFile = app.dockerComposeFile || undefined;
        if (!composeFile && app.framework === 'DOCKER_COMPOSE') {
          composeFile = this.readAppComposeFromDisk(app) || undefined;
        }
        // Apps whose compose mounts the docker socket / host paths cannot be
        // safely run from an untrusted archive on another install — flag them
        // so import skips with a clear warning (Portainer etc.).
        const requiresHostAccess = composeFile
          ? checkImportedComposeSafety(composeFile).length > 0
          : undefined;
        const entry: DctprojApp = {
          name: app.name,
          displayName: app.displayName || undefined,
          framework: app.framework,
          gitUrl: app.gitUrl || undefined,
          gitBranch: app.gitBranch || undefined,
          dockerImage: app.dockerImage || undefined,
          dockerComposeFile: composeFile,
          buildCommand: app.buildCommand || undefined,
          startCommand: app.startCommand || undefined,
          port: app.port ?? undefined,
          hostPort: app.hostPort ?? undefined,
          containerPort: app.containerPort ?? undefined,
          customPort: app.customPort ?? undefined,
          envEncrypted,
          volumeFiles: [],
          requiresHostAccess: requiresHostAccess || undefined,
        };
        // Data (volumes) are only carried for LOCAL-source apps in this v1 —
        // remote-source volume export would need the agent VOLUME_EXPORT chain,
        // which is deferred. Skip volume export for host-access apps (they are
        // not imported anyway).
        if (opts.includeData && !requiresHostAccess) {
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
          // Auto-imported (bundled) DBs live INSIDE their parent app's docker
          // volume — that volume tar already carries the full datadir and is
          // restored before the app's first boot. Emitting a SQL dump too
          // would be redundant and risk an inconsistent double-restore. Mark
          // it so the importer knows the data comes from the volume, not SQL.
          if (db.autoImported) {
            entry.dataInVolume = true;
          } else {
            const dumpRel = await this.dumpLocalDatabase(db, dir);
            if (dumpRel) entry.dumpFile = dumpRel;
          }
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
      await execFileAsync('tar', tarArgs('-czf', tarPath(plainTar), '-C', tarPath(dir), '.'), { maxBuffer: 64 * 1024 * 1024 });
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

  /**
   * Read a compose-app's docker-compose.yml off disk (the marketplace/custom
   * install path writes it there, never to the DB column). Mirrors the dir
   * resolution lifecycle ops use: resolveAppDir first, then a scan of APPS_DIR
   * for a dir ending in `-<id12>` (suffixed installs like "WordPress 2").
   * Returns the file contents, or null when no compose is found.
   */
  private readAppComposeFromDisk(app: { name: string; id: string }): string | null {
    try {
      const slug = slugify(app.name);
      let appDir = resolveAppDir(slug, app.id);
      let composePath = findComposePath(appDir);
      if (!composePath && fs.existsSync(APPS_DIR)) {
        const id12 = app.id.slice(0, 12);
        const match = fs.readdirSync(APPS_DIR)
          .find((d) => d.endsWith(`-${id12}`) && findComposePath(path.join(APPS_DIR, d)));
        if (match) {
          appDir = path.join(APPS_DIR, match);
          composePath = findComposePath(appDir);
        }
      }
      return composePath ? fs.readFileSync(composePath, 'utf8') : null;
    } catch {
      return null;
    }
  }

  /**
   * Tar each of a LOCAL app's docker volumes into the staging volumes/ dir.
   *
   * Records BOTH the legacy `volumeFiles` (path only) and the new `volumes`
   * descriptor carrying the REMAPPABLE key = the volume name with the
   * compose-project prefix stripped. On import the project prefix differs
   * (new app id), so the importer rebuilds `<targetPrefix>_<key>` to land the
   * data in the volume the freshly-deployed stack actually mounts.
   *
   * Uses the canonical appVolumePrefix() (the same resolveAppDir-based naming
   * Backups + remote volume enumeration use) instead of a local slug regex,
   * so source filtering can't drift from how compose actually names volumes.
   */
  private async exportLocalAppVolumes(app: { name: string; id: string }, dir: string, entry: DctprojApp): Promise<void> {
    try {
      const { stdout } = await execFileAsync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 15_000 });
      const prefix = appVolumePrefix(app.name, app.id); // `<slug>-<id12>_`
      const volumes = stdout.trim().split('\n').filter(Boolean).filter((v) => v.startsWith(prefix));
      entry.volumes = entry.volumes || [];
      for (const vol of volumes) {
        const rel = path.posix.join('volumes', `${path.basename(vol)}.tar.gz`);
        const out = path.join(dir, rel);
        // Stream `docker run busybox tar` stdout straight to the file (never
        // buffered in memory).
        await this.dockerTarVolumeToFile(vol, out);
        entry.volumeFiles.push(rel);
        entry.volumes.push({ file: rel, key: vol.slice(prefix.length) });
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

  /**
   * Dump a LOCAL standalone database to the staging databases/ dir, returns
   * the rel path (or null when the engine has no SQL dump, e.g. Redis whose
   * data rides its volume tar). Auto-imported (bundled) DBs are NOT dumped
   * here — they are filtered out by the caller (their data is in the parent
   * app's volume). So this always runs with autoImported=false / dumpAll=false.
   *
   * Command shapes + the gzip envelope come from the shared db-dump helper
   * (resolveDbContainer fixes the old `dockcontrol-db-<name>` assumption;
   * password rides a 0600 --env-file, never the host argv).
   */
  private async dumpLocalDatabase(
    db: { name: string; type: string; username: string; password: string; autoImported?: boolean; host?: string },
    dir: string,
  ): Promise<string | null> {
    const dumpable = {
      name: db.name, type: db.type, username: db.username, password: db.password,
      autoImported: false, host: db.host || '',
    };
    const container = resolveDbContainer(dumpable);
    const plan = dumpPlan(dumpable, container, { dumpAll: false });
    if (!plan) return null; // Redis/others — data rides the volume tar instead.
    const rel = path.posix.join('databases', `${db.name}.${plan.ext}.gz`);
    const out = path.join(dir, rel);

    let envFile: string | undefined;
    let argv = plan.argv;
    try {
      if (plan.prepArgv) await execFileAsync('docker', plan.prepArgv, { timeout: 300_000 });
      if (plan.envFileContent) {
        envFile = path.join(os.tmpdir(), `dockcontrol-xfer-dump-${crypto.randomBytes(8).toString('hex')}.env`);
        fs.writeFileSync(envFile, plan.envFileContent, { mode: 0o600 });
        argv = [plan.argv[0], '--env-file', envFile, ...plan.argv.slice(1)];
      }
      const { spawn } = await import('child_process');
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(out);
        const { createGzip } = require('zlib');
        const gz = createGzip();
        const child = spawn('docker', argv);
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
    } finally {
      if (envFile) { try { fs.unlinkSync(envFile); } catch {} }
    }
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
      await execFileAsync('tar', tarArgs('-xzf', tarPath(plainTar), '-C', tarPath(extractDir)), { maxBuffer: 64 * 1024 * 1024 });
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
      // Surface non-portable apps at the REVIEW step so the operator knows
      // before applying which apps won't come over.
      const hostApps = manifest.applications.filter((a) => a.requiresHostAccess).map((a) => a.name);
      if (hostApps.length) {
        warnings.push(`${hostApps.length} app(s) need host access (docker socket / host paths) and will be SKIPPED — reinstall from the marketplace here: ${hostApps.join(', ')}.`);
      }

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
      // New per-volume descriptors (cross-install remap). Optional — v1.0
      // archives carry only volumeFiles. Validate the tar path AND the key
      // (the key becomes part of a docker volume name → reject anything that
      // isn't a plain volume-name segment).
      if (a.volumes !== undefined) {
        if (!Array.isArray(a.volumes)) throw new BadRequestException('Malformed application volumes.');
        for (const v of a.volumes) {
          if (!v || !safeRel(v.file)) throw new BadRequestException('Unsafe volume path in archive.');
          if (typeof v.key !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(v.key)) {
            throw new BadRequestException('Unsafe volume key in archive.');
          }
        }
      }
      // CRITICAL: an imported compose is attacker-controlled. Screen it for
      // host bind-mounts / docker.sock / privileged BEFORE it can ever be
      // written to disk and run — create()'s parse-only check does NOT.
      // A legitimate-but-unsafe app (Portainer mounts docker.sock, etc.) is
      // NOT an attack — flag it requiresHostAccess so apply SKIPS it with a
      // warning, rather than failing the whole import. The flag is recomputed
      // here (don't trust the exporter's flag) so the safety check is authoritative.
      if (a.dockerComposeFile) {
        a.requiresHostAccess = checkImportedComposeSafety(a.dockerComposeFile).length > 0;
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
    opts: { passphrase: string; targetServerId?: string; domainStrategy?: DomainStrategy; allowHostAccess?: boolean; gitProviderMap?: Record<string, string> },
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

      // Restore artifacts (volume tars + standalone DB dumps) must outlive
      // this method: app deploys are async and consume them AFTER applyImport
      // returns, but the finally below wipes the staging dir. Move them to a
      // sibling restore dir that the TTL sweeper still reaps (it matches the
      // xfer_ prefix), and consumers self-delete each file once applied.
      const restoreDir = path.join(XFER_DIR, `${stagedId}-restore`);
      if (manifest.includesData) fs.mkdirSync(restoreDir, { recursive: true });
      // Park an artifact outside staging; returns the new absolute path.
      const park = (rel: string): string => {
        const src = path.join(extractDir, rel);
        const dst = path.join(restoreDir, path.basename(rel));
        fs.renameSync(src, dst);
        return dst;
      };

      // 2) Databases — recreate via the validated create path.
      //    BUNDLED (auto-imported, dataInVolume) DBs are NOT created here: they
      //    live inside their parent app's compose stack, so the app deploy's
      //    own importFromAppCompose re-registers them and the app's volume
      //    restore brings their data. Creating a standalone container for them
      //    would spawn a phantom DB. STANDALONE DBs are created + (optionally)
      //    replayed from their SQL dump.
      const dbNameToId: Record<string, string> = {};
      for (const db of manifest.databases) {
        if (db.dataInVolume) {
          // Data rides the parent app's volume tar — nothing to do here.
          continue;
        }
        try {
          const created = await this.databases.create(userId, {
            name: db.name,
            type: db.type,
            projectId: project.id,
            serverId: opts.targetServerId,
          } as any);
          const newDbId = (created as any).id;
          dbNameToId[db.name] = newDbId;
          if (manifest.includesData && db.dumpFile) {
            // Replay the dump once the fresh container accepts connections.
            // Fire-and-forget with self-cleanup: the container boot (pull +
            // initdb) can take minutes, so we must NOT block the import HTTP
            // request on it. restoreDbDump waits for readiness internally.
            const dumpPath = park(db.dumpFile);
            void this.databases
              .restoreDbDump(newDbId, dumpPath)
              .catch((e) => this.logger.warn(`restore dump for db ${db.name}: ${e?.message || e}`))
              .finally(() => { try { fs.unlinkSync(dumpPath); } catch {} });
            warnings.push(`db ${db.name}: data is being restored in the background once the container is ready — verify shortly after deploy.`);
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
        // Host-access apps (docker.sock / host bind-mounts, e.g. Portainer)
        // give whoever crafted the archive ROOT on this host. Import them ONLY
        // when the operator gave explicit consent (allowHostAccess) — they are
        // moving an app they trust. Without consent: skip with a clear warning
        // (an attacker's archive can't silently gain host control).
        if (app.requiresHostAccess && !opts.allowHostAccess) {
          warnings.push(`app ${app.name}: needs host access (mounts the docker socket or host paths) and was SKIPPED — re-import with "allow host access" checked if you trust this archive, or reinstall it from the marketplace.`);
          continue;
        }
        if (app.requiresHostAccess && opts.allowHostAccess) {
          warnings.push(`app ${app.name}: imported WITH host access (docker socket / host paths) per your explicit consent — it controls the host, treat it accordingly.`);
        }
        // An app with no deployable source can't be recreated — say so rather
        // than silently leaving a STOPPED row.
        if (!app.gitUrl && !app.dockerImage && !app.dockerComposeFile) {
          warnings.push(`app ${app.name}: has no recreatable source (no git URL, image, or compose) and was skipped.`);
          continue;
        }
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
          if (app.gitUrl) {
            dto.gitUrl = app.gitUrl;
            dto.gitBranch = app.gitBranch || 'main';
            // Git credentials never travel in the archive. For a private repo
            // the operator picks one of THEIR providers on this install; create()
            // then validates ownership + host and clones with that token. No
            // provider → anonymous clone (public repos).
            const providerId = opts.gitProviderMap?.[app.name];
            if (providerId) dto.gitProviderId = providerId;
          }
          else if (app.dockerImage) dto.dockerImage = app.dockerImage;
          else if (app.dockerComposeFile) dto.composeContent = app.dockerComposeFile;
          if (app.buildCommand) dto.buildCommand = app.buildCommand;
          if (app.startCommand) dto.startCommand = app.startCommand;
          if (app.port) dto.port = app.port;
          if (app.hostPort) dto.hostPort = app.hostPort;
          // Note: customPort is not a create-DTO field (it's derived from
          // hostPort/domain at deploy time). The published host port carried by
          // hostPort + the compose's own publish drives the URL after import.

          // Data restore: hand the compose deploy this app's volume seeds so it
          // populates them BEFORE `up` (bundled DBs boot on restored data, not
          // a fresh installer). Only compose apps carry volumes; `volumes`
          // (new) wins over legacy `volumeFiles` (path-only, no remap key).
          if (manifest.includesData && app.dockerComposeFile) {
            const vols = app.volumes && app.volumes.length
              ? app.volumes
              // Legacy v1.0 archive: derive the key from the tar basename by
              // stripping a leading `<slug>-<id>_` prefix if present; the
              // deploy rebuilds the target name from its own prefix anyway.
              : (app.volumeFiles || []).map((f) => {
                  const baseNoExt = path.basename(f).replace(/\.tar\.gz$/, '');
                  const us = baseNoExt.indexOf('_');
                  return { file: f, key: us >= 0 ? baseNoExt.slice(us + 1) : baseNoExt };
                });
            if (vols.length) {
              dto.restoreVolumes = vols.map((v) => ({ key: v.key, tarPath: park(v.file) }));
            }
          }
          const created = await this.applications.create(userId, dto);
          appNameToId[app.name] = (created as any).id;
        } catch (e: any) {
          const base = `app ${app.name}: ${e?.message || e}`;
          // A git app with no provider picked is the usual private-repo failure
          // — point the operator at the fix.
          const hint = app.gitUrl && !opts.gitProviderMap?.[app.name]
            ? ' (if this is a private repo, re-import and pick a connected git provider for this app)'
            : '';
          warnings.push(base + hint);
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
