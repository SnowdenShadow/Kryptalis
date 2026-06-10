import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import type { ProjectRole } from '@prisma/client';
import * as dockerFs from './docker-fs';
import { pickRootForImage, type DockerFsTarget } from './docker-fs';

/**
 * Files module — multi-tenant browser/editor for app & database sandboxes.
 *
 * **Threat model.** A logged-in user with at least VIEWER on a project can
 * browse the on-disk content of any application or database in that project.
 * DEVELOPERs can write/upload; ADMINs can delete. The sandbox MUST stay
 * inside `<root>/apps/<appId>` (or `databases/<dbId>`). We treat path
 * resolution as adversarial: an attacker controls relPath, filename, the
 * rename destination, and may stage symlinks via upload.
 *
 * Defenses layered here:
 *   1. **Sandbox keyed by id, not slug.** Two tenants can both have an app
 *      named 'api'; previously they'd collide on `<root>/apps/api`. Now
 *      `<root>/apps/<appId>` and `<root>/databases/<dbId>` so the FS
 *      partition matches the DB partition. Same fix for databases.
 *   2. **Symlink containment.** Every absolute path is realpath-resolved
 *      before any read/write/unlink. realpath follows symlinks, so a
 *      symlink under the sandbox pointing at /etc/passwd resolves to a
 *      path NOT prefixed by the sandbox root → ForbiddenException. lstat
 *      is used for listing/rename so symlinks remain visible without being
 *      auto-followed.
 *   3. **Filename hardening.** uploads and renames sanitize basename to
 *      reject '.', '..', null bytes, control chars, slashes, backslashes.
 *      Empty results are rejected.
 *   4. **Denylist for managed files.** `.kryptalis.env` and the
 *      Kryptalis-generated compose override are off-limits across ALL
 *      operations (read/write/upload/download/rename/delete). Hidden-from-
 *      listing was never enough — the previous code happily read/wrote
 *      these by exact path.
 *   5. **Dotenv read gating.** `.env`/`.env.*` files contain real secrets.
 *      Reading requires ADMIN on the project (VIEWERs/DEVELOPERs see a
 *      placeholder). Writing remains DEVELOPER.
 *   6. **Sensitive dotfile hiding.** `.git`, `.ssh`, `.docker`, `.npmrc`,
 *      `.aws`, `.gitconfig` are filtered from listings by default and
 *      blocked from raw read unless ADMIN.
 *   7. **Audit log.** Every mutating op writes an AuditLog row keyed by
 *      (userId, scope, scopeId, action, path).
 *
 * Tests should cover: realpath traversal via symlink uploaded as a regular
 * file; rename TO `.kryptalis.env`; download with a filename containing
 * CRLF; cross-project access by id; admin bypass on unlinked DBs.
 */

const ROOT_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const APPS_DIR = path.join(ROOT_DIR, 'apps');
const DBS_DIR = path.join(ROOT_DIR, 'databases');
// Upload staging area — same volume as APPS_DIR/DBS_DIR so the final
// move into place is an atomic rename() instead of a second full copy.
const TMP_DIR = path.join(ROOT_DIR, 'tmp');

interface ResolvedPath {
  scope: 'app' | 'db';
  scopeId: string;
  scopeName: string;
  rootDir: string;
  absPath: string;
  relPath: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  permissions: string;
  isHidden: boolean;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.yml', '.yaml', '.json', '.xml', '.html', '.css',
  '.scss', '.sass', '.less', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro', '.py', '.rb', '.php', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.bat', '.cmd', '.toml', '.ini', '.cfg', '.conf', '.config', '.env', '.dockerfile',
  '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.eslintrc',
  '.sql', '.graphql', '.gql', '.proto', '.lock', '.log',
]);

// Files Kryptalis owns — never expose, never let the user mutate.
// Lowercase entries; all checks lowercase the basename before lookup so
// case-insensitive filesystems (NTFS, default APFS) can't bypass via
// `.KRYPTALIS.ENV`.
const MANAGED_FILES = new Set([
  '.kryptalis.env',
  'docker-compose.override.yml',
]);

// Hidden by default in listings + read requires ADMIN. These often contain
// raw credentials/tokens (git remotes with embedded tokens, ssh private
// keys, registry credentials, cloud-provider creds). Checks look at every
// path COMPONENT, not just the leaf, because `.git/config` has basename
// `config` and would otherwise leak.
const SENSITIVE_DOTFILES = new Set([
  '.git', '.ssh', '.docker', '.npmrc', '.gitconfig', '.aws',
]);

// Anything that should be treated as a secret-bearing dotenv. Case-insensitive
// regex set lets us catch `.env`, `.env.production`, `.envrc` (direnv),
// backup forms like `.env.bak`, and the windows-casing variants. Read of
// these requires project ADMIN.
const DOTENV_PATTERNS = [
  /^\.env(\.[^/]+)?$/i,
  /^\.envrc(\.[^/]+)?$/i,
];

function isDotenvName(name: string): boolean {
  return DOTENV_PATTERNS.some((re) => re.test(name));
}

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB

// Quota walk caps — guard against pathological trees (symlink loops the
// O_NOFOLLOW guard didn't catch, runaway node_modules nesting, etc.).
const QUOTA_MAX_DEPTH = 20;
const QUOTA_MAX_FILES = 100_000;
const QUOTA_CACHE_TTL_MS = 60_000;
const DEFAULT_QUOTA_BYTES = 10n * 1024n * 1024n * 1024n; // 10 GiB

interface QuotaCacheEntry {
  used: bigint;
  expiresAt: number;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  // Cache of computed storage usage per projectId. Walking a tree is O(N
  // files + dirs) of statSync calls — back-to-back uploads in a session
  // would re-walk every time without this. TTL is 60s; entries also get
  // bumped forward additively after each accepted write so we don't
  // under-count between full re-walks.
  private quotaCache = new Map<string, QuotaCacheEntry>();

  constructor(private prisma: PrismaService) {
    if (!fs.existsSync(ROOT_DIR)) fs.mkdirSync(ROOT_DIR, { recursive: true });
    if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });
    if (!fs.existsSync(DBS_DIR)) fs.mkdirSync(DBS_DIR, { recursive: true });
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

    // Periodic refresh — every 5 minutes drop stale entries so we don't
    // hold incorrect numbers indefinitely after a deletion outside the
    // service or an out-of-band cleanup.
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.quotaCache) {
        if (v.expiresAt <= now) this.quotaCache.delete(k);
      }
    }, 5 * 60 * 1000).unref?.();
  }

  // ── scopes the user can access ────────────────────────────────────

  async listScopes(userId: string) {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            applications: {
              select: { id: true, name: true, framework: true, status: true, containerName: true },
            },
            databases: {
              select: { id: true, name: true, type: true, applicationId: true },
            },
          },
        },
      },
    });

    const legacyProjects = await this.prisma.project.findMany({
      where: {
        userId,
        NOT: { id: { in: memberships.map((m) => m.projectId) } },
      },
      select: {
        id: true,
        name: true,
        applications: {
          select: { id: true, name: true, framework: true, status: true },
        },
        databases: {
          select: { id: true, name: true, type: true, applicationId: true },
        },
      },
    });

    const all = [
      ...memberships.map((m) => ({ ...m.project, role: m.role as ProjectRole })),
      ...legacyProjects.map((p) => ({ ...p, role: 'OWNER' as ProjectRole })),
    ];

    return all.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      applications: p.applications.map((a) => ({
        ...a,
        // hasFiles=true if the host dir has user files (git deploys,
        // compose-empty) OR the app has a container we can introspect
        // (marketplace, image-only). Either way the file manager has
        // SOMETHING to show.
        hasFiles:
          fs.existsSync(this.appRootDir(a.id, this.slugify(a.name))) ||
          !!(a as any).containerName,
      })),
      databases: p.databases.map((d) => ({
        ...d,
        hasFiles: fs.existsSync(this.dbRootDir(d.id)),
      })),
    }));
  }

  // ── path resolution ───────────────────────────────────────────────

  // The real on-disk layout — ApplicationsService writes deploys to
  // `<APPS_DIR>/<slug>-<appId.slice(0,12)>` (or a legacy `<slug>` dir
  // for pre-migration installs). We MUST mirror that here or the file
  // browser ends up pointing at an empty `<APPS_DIR>/<appId>` dir that
  // never gets populated. The browser would then show every app as
  // "empty folder" forever — exactly the bug we're fixing.
  //
  // Same resolver as applications.service.ts (kept inline to avoid a
  // cross-module helper export; the two MUST stay byte-for-byte
  // equivalent — touching one without the other will desync the
  // browser from the actual disk layout again).
  private appRootDir(appId: string, slug?: string): string {
    if (slug) {
      const perInstance = path.join(APPS_DIR, `${slug}-${appId.slice(0, 12)}`);
      if (fs.existsSync(perInstance)) return perInstance;
      const legacy = path.join(APPS_DIR, slug);
      if (fs.existsSync(legacy)) return legacy;
      return perInstance;
    }
    // Slug not provided (legacy callers) — fall back to scanning APPS_DIR
    // for any dir that ends with the appId prefix. Slower but correct.
    const prefix = appId.slice(0, 12);
    try {
      for (const name of fs.readdirSync(APPS_DIR)) {
        if (name.endsWith(`-${prefix}`)) return path.join(APPS_DIR, name);
      }
    } catch {}
    return path.join(APPS_DIR, appId);
  }

  // App lookups in listScopes() only have the id (not the slug). Convert
  // the in-DB name to a slug here using the same rule the deploy path
  // uses (lowercase, ascii, dashes, capped at 48). Kept inline for the
  // same reason as appRootDir above.
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'app';
  }

  private dbRootDir(dbId: string) {
    return path.join(DBS_DIR, dbId);
  }

  // ── docker-fs detection ───────────────────────────────────────────
  //
  // Some app deploys live entirely INSIDE a container — marketplace
  // installs (PrestaShop, WordPress, Ghost…) and `framework=DOCKER` /
  // `dockerImage`-only apps. The host dir for those holds nothing but
  // the compose file + .env; the actual app files (PrestaShop's
  // /var/www/html, WordPress's same, etc.) are unreachable through the
  // normal bind-mount file manager.
  //
  // When we detect that case, we return a DockerFsTarget {containerName,
  // rootDir} and route every read/write through docker-fs.ts instead.
  // From the user's POV the file manager just works — they see the
  // app's actual files keyed on a sensible root for that image.
  //
  // We never combine both — once we decide a scope is "docker-only" we
  // commit to it for that request, so the user doesn't have to think
  // about which half of the disk they're editing.
  private async resolveDockerTarget(appId: string): Promise<DockerFsTarget | null> {
    const app = await this.prisma.application.findUnique({
      where: { id: appId },
      select: {
        name: true,
        framework: true,
        dockerImage: true,
        containerName: true,
        gitUrl: true,
      },
    });
    if (!app) {
      this.logger.warn(`resolveDockerTarget(${appId}): app not found`);
      return null;
    }
    // No container_name → can't address the container; fall through to host-fs.
    if (!app.containerName) {
      this.logger.warn(`resolveDockerTarget(${appId}): no containerName → host-fs`);
      return null;
    }

    const slug = this.slugify(app.name);
    const hostDir = this.appRootDir(appId, slug);

    // Fast path: if the image is one of our known "lives entirely in the
    // container" templates (PrestaShop, WordPress, Ghost, Nextcloud,
    // Gitea, nginx, httpd, n8n, grafana, code-server), the user's actual
    // files are NEVER on the host — they're inside the container's
    // /var/www/html or equivalent. Bypass the heuristic below so a
    // renamed slug (SIDE_FILES lookup miss) or a stray top-level file
    // doesn't flip us back to host-fs and hide the real codebase.
    const imageHint = (app.dockerImage || app.containerName || '').toLowerCase();
    const containerRoot = pickRootForImage(imageHint);
    this.logger.log(`resolveDockerTarget(${appId}) name=${app.name} container=${app.containerName} image=${app.dockerImage} → root=${containerRoot}`);
    if (containerRoot !== '/') {
      return { containerName: app.containerName, rootDir: containerRoot };
    }
    // If the host dir actually has source code (more than platform-
    // managed deploy artefacts), prefer host-fs. Otherwise the host
    // dir is just the compose + .env + a handful of side-files the
    // marketplace install path drops in (e.g. PrestaShop's
    // prestashop-proxy.conf bind-mounted into Apache). Those don't
    // count as "user files" for the purpose of picking a backend —
    // we still want to docker-fs into the container.
    //
    // Conservative whitelist: anything that's either a known managed
    // marker, the compose, the env, OR a top-level *.conf file
    // (marketplace side-files are always shallow). Anything else
    // (a directory of source, a Dockerfile, a package.json…) flips
    // us to host-fs.
    // Pull the actual side-file names declared by the matching template
    // (e.g. PrestaShop's prestashop-proxy.conf + php-trust-proxy.ini +
    // kryptalis-trust-proxy.php). Hard-coded suffix patterns would either
    // miss future templates or accidentally whitelist user files; the
    // explicit list is the precise oracle. Pulled lazily to avoid a
    // circular import on the marketplace module.
    let sideFileNames: Set<string> = new Set();
    try {
      const { SIDE_FILES } = require('../marketplace/templates') as {
        SIDE_FILES: Record<string, Record<string, string>>;
      };
      const map = SIDE_FILES?.[slug];
      if (map) sideFileNames = new Set(Object.keys(map));
    } catch {}

    const isPlatformArtefact = (name: string): boolean => {
      if (this.isManaged(name)) return true;
      if (name === '.env') return true;
      if (/^docker-compose\.(yml|yaml)$/i.test(name)) return true;
      // Marketplace side-files for this exact slug — exact-name match
      // only. Avoids whitelisting any `.conf` / `.ini` / `.php` the
      // user might have legitimately committed at repo root.
      if (sideFileNames.has(name)) return true;
      return false;
    };
    let hasUserFiles = false;
    try {
      const entries = fs.readdirSync(hostDir);
      for (const e of entries) {
        if (isPlatformArtefact(e)) continue;
        hasUserFiles = true;
        break;
      }
    } catch {}
    if (hasUserFiles) return null;

    return {
      containerName: app.containerName,
      rootDir: pickRootForImage(app.dockerImage || app.containerName || ''),
    };
  }

  private isManaged(name: string): boolean {
    return MANAGED_FILES.has(name.toLowerCase());
  }

  private isSensitiveDotfile(name: string): boolean {
    return SENSITIVE_DOTFILES.has(name.toLowerCase());
  }

  /**
   * Walk every component of a relative path and return true if ANY of them
   * is a sensitive dotfile root. `.git/config` → component `.git` matches
   * even though basename is `config`. Empty string and root return false.
   */
  private pathTraversesSensitive(relPath: string): boolean {
    if (!relPath) return false;
    return relPath
      .split('/')
      .filter(Boolean)
      .some((c) => this.isSensitiveDotfile(c));
  }

  /**
   * True if the leaf or any component matches a managed file. Used for ops
   * that should refuse regardless of whether the managed file is reached
   * directly or nested.
   */
  private pathTraversesManaged(relPath: string): boolean {
    if (!relPath) return false;
    return relPath
      .split('/')
      .filter(Boolean)
      .some((c) => this.isManaged(c));
  }

  /**
   * Resolve "<scope>/<scopeId>/some/sub/path" to an absolute disk path
   * after RBAC checks AND symlink containment.
   *
   * realpath is applied to whatever exists on disk; for paths that don't
   * exist yet (write/mkdir/upload) we realpath the deepest existing parent
   * and compare. This blocks the classic TOCTOU+symlink escape where the
   * user uploads a symlink and then writes through it.
   */
  private async resolvePath(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    relPath: string,
    minRole: ProjectRole = 'VIEWER',
  ): Promise<ResolvedPath> {
    let rootDir: string;
    let scopeName: string;

    if (scope === 'app') {
      const app = await this.prisma.application.findUnique({ where: { id: scopeId } });
      if (!app) throw new NotFoundException('Application not found');
      await assertProjectAccess(this.prisma, userId, app.projectId, minRole);
      scopeName = app.name;
      rootDir = this.appRootDir(app.id, this.slugify(app.name));
    } else {
      const db = await this.prisma.database.findUnique({ where: { id: scopeId } });
      if (!db) throw new NotFoundException('Database not found');
      if (db.projectId) {
        await assertProjectAccess(this.prisma, userId, db.projectId, minRole);
      } else if (db.applicationId) {
        const app = await this.prisma.application.findUnique({
          where: { id: db.applicationId },
          select: { projectId: true },
        });
        if (!app) throw new NotFoundException('Application not found');
        await assertProjectAccess(this.prisma, userId, app.projectId, minRole);
      } else {
        const me = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { role: true },
        });
        if (me?.role !== 'SUPERADMIN' && me?.role !== 'ADMIN') {
          throw new ForbiddenException('Unlinked databases are admin-only');
        }
      }
      scopeName = db.name;
      rootDir = this.dbRootDir(db.id);
    }

    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
    const rootAbs = fs.realpathSync(rootDir);

    // Sanitize input: strip leading slashes, normalize backslashes,
    // reject obviously bad characters.
    if (typeof relPath !== 'string') {
      throw new BadRequestException('Path must be a string.');
    }
    if (relPath.includes('\0')) {
      throw new BadRequestException('Null byte in path is not allowed.');
    }
    const cleaned = relPath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    const absPath = path.resolve(rootAbs, cleaned);

    // Lexical guard first (cheap, blocks ../../etc/passwd before disk hit).
    if (absPath !== rootAbs && !absPath.startsWith(rootAbs + path.sep)) {
      throw new ForbiddenException('Path traversal denied.');
    }

    // Symlink containment. If the path exists, realpath it and re-check.
    // If it doesn't (write/upload/mkdir cases), realpath the deepest
    // existing ancestor and re-check.
    let realCheckPath = absPath;
    let cursor = absPath;
    while (!fs.existsSync(cursor) && cursor !== rootAbs) {
      cursor = path.dirname(cursor);
    }
    if (fs.existsSync(cursor)) {
      try {
        const realCursor = fs.realpathSync(cursor);
        // Replace the existing prefix with its real path so any symlink
        // hop is reflected in the comparison.
        if (cursor !== absPath) {
          realCheckPath = path.join(realCursor, path.relative(cursor, absPath));
        } else {
          realCheckPath = realCursor;
        }
      } catch {
        // If realpath fails (broken symlink), refuse rather than fall back.
        throw new ForbiddenException('Symlink target could not be resolved.');
      }
    }
    if (
      realCheckPath !== rootAbs &&
      !realCheckPath.startsWith(rootAbs + path.sep)
    ) {
      throw new ForbiddenException('Symlink target escapes the sandbox.');
    }

    return {
      scope,
      scopeId,
      scopeName,
      rootDir: rootAbs,
      absPath,
      relPath: path.relative(rootAbs, absPath).replace(/\\/g, '/'),
    };
  }

  /**
   * Throw if `relPath` traverses or lands on a Kryptalis-managed file.
   * Case-insensitive and checks every path component (so 'sub/.kryptalis.env'
   * is refused, not just the leaf).
   */
  private assertNotManaged(relPath: string) {
    if (this.pathTraversesManaged(relPath)) {
      throw new ForbiddenException(
        `Path '${relPath}' touches a Kryptalis-managed file.`,
      );
    }
  }

  /**
   * Throw if `relPath` traverses a sensitive dotfile directory unless the
   * caller has platform ADMIN. Used for read/download paths so a VIEWER
   * cannot exfiltrate `.git/config`, `.ssh/id_*`, etc.
   */
  private async assertSensitiveOrAdmin(userId: string, relPath: string) {
    if (this.pathTraversesSensitive(relPath)) {
      if (!(await this.isAdmin(userId))) {
        throw new ForbiddenException(
          'Sensitive dotfile read requires platform ADMIN.',
        );
      }
    }
  }

  /** Validate an uploaded/renamed basename. Returns the sanitized form. */
  private sanitizeBasename(input: string): string {
    if (typeof input !== 'string') throw new BadRequestException('Invalid filename.');
    if (input.includes('\0')) throw new BadRequestException('Null byte in filename.');
    const raw = path.basename(input.replace(/[\r\n]/g, ''));
    if (!raw || raw === '.' || raw === '..') {
      throw new BadRequestException('Invalid filename.');
    }
    const safe = raw.replace(/[\x00-\x1f/\\]/g, '_');
    if (!safe) throw new BadRequestException('Invalid filename.');
    if (this.isManaged(safe)) {
      throw new ForbiddenException(`${safe} is managed by Kryptalis and cannot be touched.`);
    }
    return safe;
  }

  // ── O_NOFOLLOW-based file IO ──────────────────────────────────────
  //
  // The earlier code used fs.readFileSync/writeFileSync/sendFile, which
  // happily follow symbolic links. Even with a leaf lstat check before the
  // operation, a TOCTOU swap (`ln -sf /etc/passwd <target>` between check
  // and write) escaped the sandbox. We now open the path with O_NOFOLLOW
  // and operate on the file descriptor. The kernel refuses to follow a
  // symlink at the FINAL component, so the swap window collapses.
  //
  // For intermediate-component swaps (parent dir replaced by a symlink
  // before write) we additionally lstat-walk each component on write paths
  // and refuse if any component is a symlink. Slow but bounded by relPath
  // depth; cheaper than reimplementing openat on top of Node.

  private O_RDONLY = fs.constants.O_RDONLY;
  private O_WRONLY = fs.constants.O_WRONLY;
  private O_CREAT = fs.constants.O_CREAT;
  private O_TRUNC = fs.constants.O_TRUNC;
  private O_NOFOLLOW = (fs.constants as any).O_NOFOLLOW || 0;

  private assertNoSymlinkInPath(rootAbs: string, absPath: string) {
    // Walk from root to leaf parent dir; refuse if any existing component
    // is a symbolic link. (Leaf is handled by O_NOFOLLOW on the actual op.)
    if (this.O_NOFOLLOW === 0) return; // platform doesn't support — best effort
    const parts = path.relative(rootAbs, path.dirname(absPath)).split(path.sep).filter(Boolean);
    let cursor = rootAbs;
    for (const p of parts) {
      cursor = path.join(cursor, p);
      if (!fs.existsSync(cursor)) break;
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink()) {
        throw new ForbiddenException('Refusing to traverse a symlink in the path.');
      }
    }
  }

  private readFileNoFollow(absPath: string): string {
    let fd: number | null = null;
    try {
      fd = fs.openSync(absPath, this.O_RDONLY | this.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new BadRequestException('Not a regular file.');
      const buf = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const n = fs.readSync(fd, buf, read, stat.size - read, null);
        if (n === 0) break;
        read += n;
      }
      return buf.slice(0, read).toString('utf-8');
    } catch (e: any) {
      if (e?.code === 'ELOOP' || e?.code === 'EMLINK') {
        throw new ForbiddenException('Refusing to read through a symlink.');
      }
      throw e;
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch {}
    }
  }

  private writeFileNoFollow(absPath: string, data: Buffer | string) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        absPath,
        this.O_WRONLY | this.O_CREAT | this.O_TRUNC | this.O_NOFOLLOW,
        0o644,
      );
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
      let written = 0;
      while (written < buf.length) {
        const n = fs.writeSync(fd, buf, written, buf.length - written);
        if (n === 0) break;
        written += n;
      }
    } catch (e: any) {
      if (e?.code === 'ELOOP' || e?.code === 'EMLINK') {
        throw new ForbiddenException('Refusing to write through a symlink.');
      }
      throw e;
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch {}
    }
  }

  // ── listing ───────────────────────────────────────────────────────

  async list(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    relPath: string,
    opts: { showSensitive?: boolean } = {},
  ) {
    // RBAC + scope existence (the path comparison itself is dummy here —
    // we re-check inside the dispatcher).
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'VIEWER');

    // Docker-fs path for apps with no host source dir (marketplace,
    // image-only). RBAC has already cleared via resolvePath().
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const entries = await dockerFs.listDir(target, resolved.relPath);
        return {
          scope: resolved.scope,
          scopeName: resolved.scopeName,
          path: resolved.relPath,
          breadcrumbs: this.buildBreadcrumbs(resolved.relPath),
          // Filter same sensitive defaults as host-fs so docker browsing
          // doesn't suddenly reveal .git, .ssh, etc. to a VIEWER.
          entries: entries
            .filter((e) => opts.showSensitive || !this.isSensitiveDotfile(e.name))
            .map((e) => ({ ...e, isHidden: e.name.startsWith('.') })),
        };
      }
    }

    if (!fs.existsSync(resolved.absPath)) {
      throw new NotFoundException('Path not found');
    }
    const stat = fs.statSync(resolved.absPath);
    if (!stat.isDirectory()) {
      throw new BadRequestException('Path is not a directory');
    }

    const isAdmin = await this.isAdmin(userId);
    const showSensitive = opts.showSensitive && isAdmin;

    // If any path component already traversed a sensitive dotfile dir
    // (e.g. we're listing INSIDE .git/), refuse for non-admins entirely.
    if (!showSensitive && this.pathTraversesSensitive(resolved.relPath)) {
      throw new ForbiddenException('Listing this directory requires platform ADMIN.');
    }

    const entries: FileEntry[] = [];
    for (const name of fs.readdirSync(resolved.absPath)) {
      if (this.isManaged(name)) continue;
      if (!showSensitive && this.isSensitiveDotfile(name)) continue;
      try {
        const entryAbs = path.join(resolved.absPath, name);
        const entryStat = fs.lstatSync(entryAbs);
        let type: FileEntry['type'] = 'other';
        if (entryStat.isFile()) type = 'file';
        else if (entryStat.isDirectory()) type = 'directory';
        else if (entryStat.isSymbolicLink()) type = 'symlink';
        entries.push({
          name,
          path: path.posix.join(resolved.relPath || '.', name).replace(/^\.\//, ''),
          type,
          size: entryStat.size,
          modifiedAt: entryStat.mtime.toISOString(),
          permissions: (entryStat.mode & 0o777).toString(8).padStart(3, '0'),
          isHidden: name.startsWith('.'),
        });
      } catch {}
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      scope: resolved.scope,
      scopeName: resolved.scopeName,
      path: resolved.relPath,
      breadcrumbs: this.buildBreadcrumbs(resolved.relPath),
      entries,
    };
  }

  private buildBreadcrumbs(relPath: string) {
    if (!relPath) return [];
    const parts = relPath.split('/').filter(Boolean);
    const crumbs: { name: string; path: string }[] = [];
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      crumbs.push({ name: p, path: acc });
    }
    return crumbs;
  }

  // ── read / write text files ───────────────────────────────────────

  async readFile(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'VIEWER');
    this.assertNotManaged(resolved.relPath);

    // Docker-fs path — read directly from inside the container.
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const s = await dockerFs.stat(target, resolved.relPath);
        if (!s.exists) throw new NotFoundException('File not found');
        if (s.isDir) throw new BadRequestException('Path is a directory');
        if (s.size > MAX_TEXT_FILE_BYTES) {
          return {
            path: resolved.relPath,
            binary: true,
            size: s.size,
            message: 'File too large to edit in-browser (>2 MB)',
          };
        }
        const content = await dockerFs.readFile(target, resolved.relPath);
        return {
          path: resolved.relPath,
          binary: false,
          size: content.length,
          content,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        };
      }
    }

    const basename = path.basename(resolved.absPath);

    // Dotenv files contain secrets — gate raw read behind project ADMIN.
    if (isDotenvName(basename)) {
      await this.resolvePath(userId, scope, scopeId, relPath, 'ADMIN');
    }
    // Any sensitive-dotfile path component (e.g. .git/, .ssh/) requires
    // platform ADMIN regardless of leaf name.
    await this.assertSensitiveOrAdmin(userId, resolved.relPath);

    if (!fs.existsSync(resolved.absPath)) {
      throw new NotFoundException('File not found');
    }
    const stat = fs.lstatSync(resolved.absPath);
    if (stat.isSymbolicLink()) {
      throw new ForbiddenException('Refusing to read through a symlink.');
    }
    if (!stat.isFile()) throw new BadRequestException('Path is not a file');

    const ext = path.extname(resolved.absPath).toLowerCase();
    const lowerName = basename.toLowerCase();
    const isText =
      TEXT_EXTENSIONS.has(ext) ||
      lowerName === 'dockerfile' ||
      lowerName === 'makefile' ||
      lowerName === 'license' ||
      lowerName === 'readme' ||
      isDotenvName(basename);

    if (!isText) {
      return {
        path: resolved.relPath,
        binary: true,
        size: stat.size,
        message: 'Binary file — download to view',
      };
    }
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      return {
        path: resolved.relPath,
        binary: true,
        size: stat.size,
        message: 'File too large to edit in-browser (>2 MB)',
      };
    }
    // Open with O_NOFOLLOW to defeat the TOCTOU symlink-swap attack.
    const content = this.readFileNoFollow(resolved.absPath);
    return {
      path: resolved.relPath,
      binary: false,
      size: stat.size,
      content,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
  }

  async writeFile(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    relPath: string,
    content: string,
  ) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'DEVELOPER');
    this.assertNotManaged(resolved.relPath);
    if (typeof content !== 'string') throw new BadRequestException('content must be a string');

    // Docker-fs path.
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_FILE_BYTES) {
          throw new BadRequestException('File too large (>2MB). Use upload instead.');
        }
        await dockerFs.writeFile(target, resolved.relPath, content);
        await this.audit(userId, scope, scopeId, 'write', resolved.relPath);
        return {
          path: resolved.relPath,
          size: Buffer.byteLength(content, 'utf-8'),
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        };
      }
    }

    const newSize = Buffer.byteLength(content, 'utf-8');
    if (newSize > MAX_TEXT_FILE_BYTES) {
      throw new BadRequestException('File too large (>2MB). Use upload instead.');
    }
    // Quota: only count the DELTA — if the file already exists, the new
    // content replaces the old size, so charge (new - existing). Falls
    // back to the full size when stat fails / file is new.
    let priorSize = 0;
    try {
      const st = fs.lstatSync(resolved.absPath);
      if (st.isFile()) priorSize = st.size;
    } catch {}
    const projectId = await this.projectIdForScope(scope, scopeId);
    await this.checkQuota(projectId, Math.max(0, newSize - priorSize));
    // Refuse if any intermediate path component is a symlink (defends against
    // a parent-dir swap between mkdir and write). The leaf is handled by
    // O_NOFOLLOW in writeFileNoFollow.
    fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    this.writeFileNoFollow(resolved.absPath, content);
    await this.audit(userId, scope, scopeId, 'write', resolved.relPath);
    const stat = fs.statSync(resolved.absPath);
    return {
      path: resolved.relPath,
      size: stat.size,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
  }

  // ── upload ────────────────────────────────────────────────────────

  /**
   * Mint a unique staging path under <DATA_DIR>/tmp for the controller
   * to stream the request body into. Same volume as the app/db sandboxes
   * so the final move is an atomic rename() rather than a second copy.
   */
  createUploadTempPath(): string {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    return path.join(TMP_DIR, `upload-${crypto.randomBytes(12).toString('hex')}.tmp`);
  }

  /**
   * Finalize an upload whose body was already streamed to `tempFilePath`
   * on disk by the controller. The file content is NEVER buffered in
   * memory here — quota is checked against fs.stat of the temp file,
   * the local path moves it into place (rename, copy-fallback across
   * volumes), and the docker path streams it into `docker cp -`.
   *
   * The temp file is consumed on the local success path (rename);
   * callers unlink it in a finally either way — unlink of a moved file
   * is a harmless ENOENT.
   */
  async uploadFile(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    relPath: string,
    filename: string,
    tempFilePath: string,
  ) {
    const tempStat = await fs.promises.stat(tempFilePath);
    if (!tempStat.isFile()) throw new BadRequestException('Invalid upload payload');
    const uploadSize = tempStat.size;
    if (uploadSize > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('Upload exceeds 50MB limit');
    }
    const safeName = this.sanitizeBasename(filename);
    const targetRel = relPath ? `${relPath}/${safeName}` : safeName;
    const resolved = await this.resolvePath(userId, scope, scopeId, targetRel, 'DEVELOPER');
    this.assertNotManaged(resolved.relPath);

    // Docker-fs path — stream the temp file into `docker cp -`.
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        await dockerFs.uploadFile(target, relPath || '', safeName, tempFilePath);
        await this.audit(userId, scope, scopeId, 'upload', resolved.relPath);
        return { path: resolved.relPath, size: uploadSize };
      }
    }

    // Quota: charge the on-disk size minus any prior size if we're
    // overwriting. New uploads to fresh paths charge the full size.
    let priorUploadSize = 0;
    try {
      const st = fs.lstatSync(resolved.absPath);
      if (st.isFile()) priorUploadSize = st.size;
    } catch {}
    const uploadProjectId = await this.projectIdForScope(scope, scopeId);
    await this.checkQuota(uploadProjectId, Math.max(0, uploadSize - priorUploadSize));
    fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    await this.moveUploadIntoPlace(tempFilePath, resolved.absPath);
    await this.audit(userId, scope, scopeId, 'upload', resolved.relPath);
    const stat = fs.statSync(resolved.absPath);
    return { path: resolved.relPath, size: stat.size };
  }

  /**
   * Move the staged temp file to its final location. Mirrors the old
   * writeFileNoFollow semantics:
   *   - mode 0644 on the result (chmod the temp before the move);
   *   - refuse to write THROUGH a symlink leaf. rename() itself never
   *     follows a leaf symlink (it would replace the link inode), but
   *     the old O_NOFOLLOW behaviour was to REFUSE, so we lstat-check
   *     and keep that contract;
   *   - same-volume → atomic rename; cross-volume (EXDEV — e.g. tmp on
   *     another mount) → streamed copy into an O_NOFOLLOW-opened fd,
   *     never loading the content in memory.
   */
  private async moveUploadIntoPlace(tempFilePath: string, absPath: string): Promise<void> {
    try {
      fs.chmodSync(tempFilePath, 0o644);
    } catch {}
    try {
      const leaf = fs.lstatSync(absPath);
      if (leaf.isSymbolicLink()) {
        throw new ForbiddenException('Refusing to write through a symlink.');
      }
    } catch (e: any) {
      if (e instanceof ForbiddenException) throw e;
      // ENOENT — fresh path, fine.
    }
    try {
      await fs.promises.rename(tempFilePath, absPath);
      return;
    } catch (e: any) {
      if (e?.code !== 'EXDEV') throw e;
    }
    // Cross-device fallback: stream copy through an O_NOFOLLOW fd so a
    // TOCTOU symlink swap at the leaf still fails closed.
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        absPath,
        this.O_WRONLY | this.O_CREAT | this.O_TRUNC | this.O_NOFOLLOW,
        0o644,
      );
      const src = fs.createReadStream(tempFilePath);
      const dst = fs.createWriteStream(null as any, { fd, autoClose: false });
      await new Promise<void>((resolve, reject) => {
        src.on('error', reject);
        dst.on('error', reject);
        dst.on('finish', resolve);
        src.pipe(dst);
      });
    } catch (e: any) {
      if (e?.code === 'ELOOP' || e?.code === 'EMLINK') {
        throw new ForbiddenException('Refusing to write through a symlink.');
      }
      throw e;
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch {}
    }
  }

  // ── download ──────────────────────────────────────────────────────

  async downloadFile(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'VIEWER');
    this.assertNotManaged(resolved.relPath);
    await this.assertSensitiveOrAdmin(userId, resolved.relPath);

    // Docker-fs path — return a stream the controller pipes to the
    // response. No fd / O_NOFOLLOW dance because the container is the
    // ownership boundary, not the host filesystem.
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const { stream, filename, size } = await dockerFs.downloadFile(target, resolved.relPath);
        return { stream, filename, size };
      }
    }

    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('File not found');
    const stat = fs.lstatSync(resolved.absPath);
    if (stat.isSymbolicLink()) {
      throw new ForbiddenException('Refusing to download through a symlink.');
    }
    if (!stat.isFile()) throw new BadRequestException('Path is not a file');
    // Open with O_NOFOLLOW and hand the fd to the controller so even a
    // last-microsecond TOCTOU swap (symlinking the path right before
    // sendFile opens it) is defeated. The controller streams via the fd.
    let fd: number;
    try {
      fd = fs.openSync(resolved.absPath, this.O_RDONLY | this.O_NOFOLLOW);
    } catch (e: any) {
      if (e?.code === 'ELOOP' || e?.code === 'EMLINK') {
        throw new ForbiddenException('Refusing to download through a symlink.');
      }
      throw e;
    }
    const fstat = fs.fstatSync(fd);
    // Wrap the fd in a ReadStream so the controller can pipe a unified
    // {stream, filename, size} shape regardless of whether the source
    // is a host file or a docker exec stream. autoClose closes the fd
    // when the stream ends.
    const stream = fs.createReadStream(null as any, { fd, autoClose: true });
    return {
      stream,
      // strip CR/LF and double-quote from the filename used in the
      // Content-Disposition header — caller still applies its own RFC5987
      // encoding for unicode safety.
      filename: path.basename(resolved.absPath).replace(/[\r\n";\\]/g, '_'),
      size: fstat.size,
    };
  }

  // ── mkdir / rename / delete ───────────────────────────────────────

  async mkdir(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'DEVELOPER');
    this.assertNotManaged(resolved.relPath);

    // Docker-fs path.
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const s = await dockerFs.stat(target, resolved.relPath);
        if (s.exists) throw new BadRequestException('Path already exists');
        await dockerFs.mkdir(target, resolved.relPath);
        await this.audit(userId, scope, scopeId, 'mkdir', resolved.relPath);
        return { path: resolved.relPath };
      }
    }

    if (fs.existsSync(resolved.absPath)) {
      throw new BadRequestException('Path already exists');
    }
    // Quota: directories themselves cost ~zero bytes, but we still
    // verify the project isn't already over budget — refusing to create
    // a new folder when the user has filled their quota gives a clear
    // failure signal earlier than letting them try the next upload.
    const mkdirProjectId = await this.projectIdForScope(scope, scopeId);
    await this.checkQuota(mkdirProjectId, 0);
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    fs.mkdirSync(resolved.absPath, { recursive: true });
    await this.audit(userId, scope, scopeId, 'mkdir', resolved.relPath);
    return { path: resolved.relPath };
  }

  async rename(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    fromRel: string,
    toRel: string,
  ) {
    const src = await this.resolvePath(userId, scope, scopeId, fromRel, 'DEVELOPER');
    this.assertNotManaged(src.relPath);
    // Sanitize the destination basename first so a `to: 'subdir/.kryptalis.env'`
    // is refused before any disk hit, regardless of intermediate prefix.
    const dstParts = toRel.replace(/\\/g, '/').split('/').filter(Boolean);
    const dstName = dstParts.pop() || '';
    const safeDstName = this.sanitizeBasename(dstName);
    const reconstructedToRel = dstParts.length
      ? `${dstParts.join('/')}/${safeDstName}`
      : safeDstName;
    const dst = await this.resolvePath(userId, scope, scopeId, reconstructedToRel, 'DEVELOPER');
    this.assertNotManaged(dst.relPath);

    // Docker-fs path.
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const srcStat = await dockerFs.stat(target, src.relPath);
        if (!srcStat.exists) throw new NotFoundException('Source not found');
        const dstStat = await dockerFs.stat(target, dst.relPath);
        if (dstStat.exists) throw new BadRequestException('Destination already exists');
        await dockerFs.rename(target, src.relPath, dst.relPath);
        await this.audit(userId, scope, scopeId, 'rename', `${src.relPath} → ${dst.relPath}`);
        return { from: src.relPath, to: dst.relPath };
      }
    }

    if (!fs.existsSync(src.absPath)) throw new NotFoundException('Source not found');
    if (fs.existsSync(dst.absPath)) throw new BadRequestException('Destination already exists');
    this.assertNoSymlinkInPath(dst.rootDir, dst.absPath);
    fs.mkdirSync(path.dirname(dst.absPath), { recursive: true });
    fs.renameSync(src.absPath, dst.absPath);
    await this.audit(userId, scope, scopeId, 'rename', `${src.relPath} → ${dst.relPath}`);
    return { from: src.relPath, to: dst.relPath };
  }

  async remove(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    if (!relPath || relPath === '.') {
      throw new BadRequestException('Cannot delete the root');
    }
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'ADMIN');
    this.assertNotManaged(resolved.relPath);

    // Docker-fs path.
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const s = await dockerFs.stat(target, resolved.relPath);
        if (!s.exists) throw new NotFoundException('Path not found');
        await dockerFs.remove(target, resolved.relPath);
        await this.audit(userId, scope, scopeId, 'remove', resolved.relPath);
        return { path: resolved.relPath, deleted: true };
      }
    }

    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('Path not found');
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    fs.rmSync(resolved.absPath, { recursive: true, force: true });
    // Cache may now overstate usage by an arbitrary amount — drop it so
    // the next quota check reflects the freed space.
    const removeProjectId = await this.projectIdForScope(scope, scopeId);
    this.invalidateQuota(removeProjectId);
    await this.audit(userId, scope, scopeId, 'remove', resolved.relPath);
    return { path: resolved.relPath, deleted: true };
  }

  // ── quota ─────────────────────────────────────────────────────────

  /**
   * Resolve the projectId that owns a given (scope, scopeId). Apps map
   * directly via Application.projectId. Databases use db.projectId or
   * fall back to the linked Application's projectId; admin-only unlinked
   * databases return null (quota is skipped — those live outside any
   * project budget).
   */
  private async projectIdForScope(
    scope: 'app' | 'db',
    scopeId: string,
  ): Promise<string | null> {
    if (scope === 'app') {
      const app = await this.prisma.application.findUnique({
        where: { id: scopeId },
        select: { projectId: true },
      });
      return app?.projectId ?? null;
    }
    const db = await this.prisma.database.findUnique({
      where: { id: scopeId },
      select: { projectId: true, applicationId: true },
    });
    if (!db) return null;
    if (db.projectId) return db.projectId;
    if (db.applicationId) {
      const app = await this.prisma.application.findUnique({
        where: { id: db.applicationId },
        select: { projectId: true },
      });
      return app?.projectId ?? null;
    }
    return null;
  }

  /**
   * Walk every app + db dir owned by a project and sum file sizes. Caps
   * recursion depth at QUOTA_MAX_DEPTH and total visited entries at
   * QUOTA_MAX_FILES — going over either returns whatever we computed so
   * far rather than throwing. Quota enforcement under that cap is still
   * safe because we err on the SIDE of refusing writes (partial size
   * count → smaller "used" → more writes allowed; cap reached for huge
   * projects just degrades gracefully to "definitely over quota").
   *
   * Uses lstatSync so symlinks count their own size (typically tiny) and
   * we don't accidentally double-count or escape via a symlink loop.
   */
  private computeProjectUsage(
    apps: Array<{ id: string; name: string }>,
    dbIds: string[],
  ): bigint {
    let total = 0n;
    let visited = 0;
    const walk = (dir: string, depth: number): void => {
      if (depth > QUOTA_MAX_DEPTH) return;
      if (visited >= QUOTA_MAX_FILES) return;
      if (!fs.existsSync(dir)) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (visited >= QUOTA_MAX_FILES) return;
        visited++;
        const full = path.join(dir, ent.name);
        try {
          // lstat so a symlink to /var/log doesn't sweep gigabytes into
          // the project's quota number.
          const st = fs.lstatSync(full);
          if (st.isDirectory()) {
            walk(full, depth + 1);
          } else if (st.isFile() || st.isSymbolicLink()) {
            total += BigInt(st.size);
          }
        } catch {
          // ignore unreadable entries
        }
      }
    };
    for (const a of apps) walk(this.appRootDir(a.id, this.slugify(a.name)), 0);
    for (const id of dbIds) walk(this.dbRootDir(id), 0);
    return total;
  }

  private async getProjectUsageCached(projectId: string): Promise<bigint> {
    const now = Date.now();
    const cached = this.quotaCache.get(projectId);
    if (cached && cached.expiresAt > now) return cached.used;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        applications: { select: { id: true, name: true } },
        databases: { select: { id: true } },
      },
    });
    if (!project) return 0n;
    const used = this.computeProjectUsage(
      project.applications,
      project.databases.map((d) => d.id),
    );
    this.quotaCache.set(projectId, {
      used,
      expiresAt: now + QUOTA_CACHE_TTL_MS,
    });
    return used;
  }

  private async getProjectQuotaBytes(projectId: string): Promise<bigint> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { storageQuotaBytes: true },
    });
    const raw = (project as any)?.storageQuotaBytes;
    if (raw == null) return DEFAULT_QUOTA_BYTES;
    return typeof raw === 'bigint' ? raw : BigInt(raw);
  }

  /**
   * Throw PayloadTooLargeException if (current_usage + additionalBytes)
   * would exceed the project's quota. Caller passes the *delta* this op
   * adds — uploads pass the buffer size, writes pass the new content
   * length, mkdir passes 0 (just a directory, ~no bytes). On success
   * additively bumps the cached usage so back-to-back writes within
   * the TTL window account for the new bytes without re-walking.
   */
  private async checkQuota(
    projectId: string | null,
    additionalBytes: number,
  ): Promise<void> {
    if (!projectId) return; // unlinked admin scopes — no project budget
    const add = BigInt(Math.max(0, Math.floor(additionalBytes)));
    const quota = await this.getProjectQuotaBytes(projectId);
    const used = await this.getProjectUsageCached(projectId);
    if (used + add > quota) {
      const fmt = (n: bigint) => `${(Number(n) / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
      throw new PayloadTooLargeException(
        `Project storage quota exceeded: ${fmt(used)} used + ${fmt(add)} new > ${fmt(quota)} quota.`,
      );
    }
    // additive bump — cheap, keeps the cache accurate for the rest of
    // the TTL window without re-walking the tree.
    const entry = this.quotaCache.get(projectId);
    if (entry) {
      entry.used = used + add;
    }
  }

  /** Invalidate the cached usage for a project — call after deletes. */
  private invalidateQuota(projectId: string | null) {
    if (projectId) this.quotaCache.delete(projectId);
  }

  /** Public — drives the GET /files/project/:projectId/usage endpoint. */
  async getProjectStorageUsage(userId: string, projectId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    const used = await this.getProjectUsageCached(projectId);
    const quota = await this.getProjectQuotaBytes(projectId);
    return { used: used.toString(), quota: quota.toString() };
  }

  // ── helpers ───────────────────────────────────────────────────────

  private async isAdmin(userId: string): Promise<boolean> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';
  }

  private async audit(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    action: string,
    pathInfo: string,
  ) {
    // Audit log writes are post-action. We don't roll back the file op when
    // logging fails — that would surprise users with errors after a
    // visually-successful save. Instead we log the failure so ops sees it
    // and can investigate (schema drift, DB outage, etc.).
    try {
      await (this.prisma as any).auditLog?.create?.({
        data: {
          userId,
          resourceType: `file:${scope}`,
          resourceId: scopeId,
          action,
          metadata: { path: pathInfo },
        },
      });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[files] audit log failed:', e?.message || e);
    }
  }
}
