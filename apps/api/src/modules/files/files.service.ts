import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
  HttpException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DATA_DIR, APPS_DIR, DBS_DIR, TMP_DIR } from '../../common/paths';
import { assertProjectAccess } from '../../common/rbac/project-access';
import type { ProjectRole } from '@prisma/client';
import * as dockerFs from './docker-fs';
import { pickRootForImage, buildFixWebPermsScript, isWwwDataRoot, type DockerFsTarget } from './docker-fs';
import {
  decodeArchive,
  detectArchiveFormat,
  encodeArchive,
  type CompressFormat,
  type ExtractedFile,
} from './zip-extract';
import { parseChmodMode, parseChownOwner } from './perms-util';
import { AgentService } from '../agent/agent.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { remoteAppSlug, slugify as appSlugify } from '../applications/applications.helpers';

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
 *   4. **Denylist for managed files.** `.dockcontrol.env` and the
 *      DockControl-generated compose override are off-limits across ALL
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
 * file; rename TO `.dockcontrol.env`; download with a filename containing
 * CRLF; cross-project access by id; admin bypass on unlinked DBs.
 */

// Runtime paths from the shared common/paths module (single source of truth).
// TMP_DIR is the upload staging area — same volume as APPS_DIR/DBS_DIR so the
// final move into place is an atomic rename() instead of a second full copy.
const ROOT_DIR = DATA_DIR;

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

// Files DockControl owns — never expose, never let the user mutate.
// Lowercase entries; all checks lowercase the basename before lookup so
// case-insensitive filesystems (NTFS, default APFS) can't bypass via
// `.DOCKCONTROL.ENV`.
const MANAGED_FILES = new Set([
  '.dockcontrol.env',
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
// Caps for "compress selection" — the whole archive is built in memory, so
// bound how much we read (anti-DoS). Big transfers should use SFTP/backup.
const MAX_COMPRESS_BYTES = 500 * 1024 * 1024; // 500MB total uncompressed read
const MAX_COMPRESS_ENTRIES = 20_000;
// Cap entries touched by a recursive chmod/chown (anti-DoS on huge trees).
const MAX_PERMS_ENTRIES = 100_000;
// Standard "web app" permission preset (the Fix-permissions button): dirs are
// group-writable + traversable, files group-writable + readable. Unblocks
// PrestaShop/WordPress/Laravel without making anything world-writable.
const WEB_DIR_MODE = 0o775;
const WEB_FILE_MODE = 0o664;
// Default owner the Fix-permissions button applies so the web-server process
// actually OWNS the tree (775 alone leaves a root-owned dir unwritable by
// www-data — the #1 cause of PrestaShop's "mkdir var/cache: Permission denied").
// 33:33 = www-data on Debian/Ubuntu, which is what the official PrestaShop,
// WordPress, and php/apache images use. Numeric so no fragile name lookup is
// needed. Callers can override (e.g. Alpine www-data is 82) via the `owner` arg.
const WEB_DEFAULT_OWNER = '33:33';

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

  constructor(
    private prisma: PrismaService,
    private agent: AgentService,
  ) {
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
              select: {
                id: true, name: true, framework: true, status: true, containerName: true, dockerImage: true,
                server: { select: { host: true } },
              },
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
          select: {
            id: true, name: true, framework: true, status: true, containerName: true, dockerImage: true,
            server: { select: { host: true } },
          },
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
      applications: p.applications
        .map((a) => {
          const serverHost = (a as any).server?.host;
          const isRemote = !!serverHost && !isLocalHost(serverHost);
          const hostHasFiles = !isRemote && fs.existsSync(this.appRootDir(a.id, this.slugify(a.name)));
          const hasContainer = !!(a as any).containerName;
          // Shell-less images (Portainer & friends) can't be exec'd into —
          // the web browser would fail on every click. Detected by image
          // name: the curated list mirrors what we actually know ships
          // distroless. Their data is still reachable over SFTP.
          const imageHint = `${(a as any).dockerImage || ''} ${(a as any).containerName || ''}`.toLowerCase();
          const shellLess = /portainer/.test(imageHint);
          // Strip the nested relations from the response (UI doesn't need
          // them and they leak server hosts to project members).
          const { server: _s, ...rest } = a as any;
          return {
            ...rest,
            // Remote apps are browsed through the agent (FILE_LIST) — the
            // agent-side dir always exists once deployed.
            hasFiles: isRemote || hostHasFiles || hasContainer,
            remote: isRemote,
            // browsable=false → the dashboard hides the entry entirely.
            // Host files always win (compose/.env are editable even for a
            // shell-less app's host dir).
            browsable: isRemote || hostHasFiles || (hasContainer && !shellLess),
          };
        })
        .filter((a) => a.browsable),
      databases: p.databases
        .map((d) => ({
          ...d,
          hasFiles: fs.existsSync(this.dbRootDir(d.id)),
        }))
        // DB engines keep their state in docker volumes (binary formats —
        // nothing a file browser can usefully show). Only list the rare
        // DB that actually has an on-disk config dir.
        .filter((d) => d.hasFiles),
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
    // dockcontrol-trust-proxy.php). Hard-coded suffix patterns would either
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
   * Throw if `relPath` traverses or lands on a DockControl-managed file.
   * Case-insensitive and checks every path component (so 'sub/.dockcontrol.env'
   * is refused, not just the leaf).
   */
  private assertNotManaged(relPath: string) {
    if (this.pathTraversesManaged(relPath)) {
      throw new ForbiddenException(
        `Path '${relPath}' touches a DockControl-managed file.`,
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
      throw new ForbiddenException(`${safe} is managed by DockControl and cannot be touched.`);
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
    //
    // This lstat-walk does NOT depend on O_NOFOLLOW — it works on every
    // platform. When O_NOFOLLOW is unavailable (so the open() can't refuse a
    // leaf symlink), this walk becomes the ONLY symlink defense, so it must
    // stay mandatory: we deliberately do NOT early-return on O_NOFOLLOW === 0.
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
    return this.readFileNoFollowBuffer(absPath).toString('utf-8');
  }

  /**
   * Read a regular file through an O_NOFOLLOW fd, returning raw bytes. The
   * O_NOFOLLOW flag is set on the FINAL open() so a symlink swapped in after an
   * earlier lstat() (the classic TOCTOU window) cannot redirect the read to a
   * file outside the sandbox — open() fails with ELOOP instead. Used by every
   * read path (download, file view, AND compress) so none of them follows a
   * symlink at the leaf. Buffer-returning so binary files survive intact.
   */
  private readFileNoFollowBuffer(absPath: string): Buffer {
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
      return buf.subarray(0, read);
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

  // ── remote-app routing ────────────────────────────────────────────

  /**
   * When the app is placed on a REMOTE server, file ops must go through
   * the agent (the local disk has nothing). Returns the routing info or
   * null for local apps / db scope.
   */
  private async resolveRemoteFsTarget(
    scope: 'app' | 'db',
    scopeId: string,
  ): Promise<{ serverId: string; slug: string; legacySlug: string } | null> {
    if (scope !== 'app') return null; // standalone DBs keep host-fs for now
    const app = await this.prisma.application.findUnique({
      where: { id: scopeId },
      select: {
        name: true,
        server: { select: { id: true, host: true } },
      },
    });
    const server = app?.server;
    if (!app || !server || isLocalHost(server.host)) return null;
    return {
      serverId: server.id,
      slug: remoteAppSlug(app.name, scopeId),
      legacySlug: appSlugify(app.name),
    };
  }

  /**
   * For a CONTAINERIZED remote app (PrestaShop/WordPress/Nextcloud/… running on
   * an official web image), the user's files live INSIDE the container at a
   * known docroot — NOT in the host app dir the agent walks. fix-permissions
   * must therefore run via `docker exec` on the agent, not a host-fs walk.
   *
   * Returns `{ containerName, rootDir }` ONLY for a www-data-served docroot
   * (the fix-permissions preset chowns to 33:33, which would break a non-
   * www-data app like Grafana/Gitea). Else null → host-fs FILE_FIXPERMS path.
   * DB read only — never touches the host disk.
   */
  private async resolveRemoteContainer(
    scopeId: string,
  ): Promise<{ containerName: string; rootDir: string } | null> {
    const app = await this.prisma.application.findUnique({
      where: { id: scopeId },
      select: { containerName: true, dockerImage: true },
    });
    if (!app?.containerName) return null;
    const rootDir = pickRootForImage(app.dockerImage || app.containerName);
    // Gate to www-data docroots only: chowning e.g. /var/lib/grafana or /data
    // to 33:33 would break those containers. Non-www-data apps fall back to the
    // host walk (harmless / no-op for stateless apps).
    if (!isWwwDataRoot(rootDir)) return null;
    return { containerName: app.containerName, rootDir };
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

    // Remote app → list via the agent's FILE_LIST task. Same sensitive-
    // dotfile filtering as local listing.
    const remote = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remote) {
      const task = await this.agent.enqueueAndWait(
        remote.serverId,
        'FILE_LIST',
        { slug: remote.slug, legacySlug: remote.legacySlug, path: resolved.relPath || '.' },
        30_000,
      );
      if (task.status === 'FAILED') {
        throw new BadRequestException(task.error || 'Remote file listing failed');
      }
      const r: any = task.result || {};
      if (!r.exists) throw new NotFoundException('Path not found');
      const entries = ((r.entries || []) as Array<{ name: string; isDir: boolean; size: number; mtime: string }>)
        .filter((e) => opts.showSensitive || !this.isSensitiveDotfile(e.name))
        .filter((e) => !this.isManaged(e.name))
        .map((e) => ({
          name: e.name,
          path: path.posix.join(resolved.relPath || '.', e.name).replace(/^\.\//, ''),
          type: (e.isDir ? 'directory' : 'file') as FileEntry['type'],
          size: e.size,
          modifiedAt: e.mtime || new Date(0).toISOString(),
          permissions: '644',
          isHidden: e.name.startsWith('.'),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return {
        scope: resolved.scope,
        scopeName: resolved.scopeName,
        path: resolved.relPath,
        breadcrumbs: this.buildBreadcrumbs(resolved.relPath),
        entries,
        remote: true,
      };
    }

    // Docker-fs path for apps with no host source dir (marketplace,
    // image-only). RBAC has already cleared via resolvePath().
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        let entries: Awaited<ReturnType<typeof dockerFs.listDir>>;
        try {
          entries = await dockerFs.listDir(target, resolved.relPath);
        } catch (e: any) {
          // Curated stories first: missing/stopped container (app still
          // deploying — PrestaShop's image pull takes minutes) and
          // shell-less images (Portainer/distroless). Both are 400s with
          // the human explanation; the dashboard renders them in place.
          if (e instanceof dockerFs.ContainerNotRunningError || e instanceof dockerFs.NoShellError) {
            throw new BadRequestException(e.message);
          }
          if (e instanceof NotFoundException || e instanceof BadRequestException) throw e;
          // Any other docker-exec failure (dockerd hiccup, unexpected
          // error phrasing) → still a 400 with the actual reason. A raw
          // 500 reads as "platform broken" when the real story is "this
          // container can't be browsed right now".
          this.logger.warn(`docker-fs listing failed for ${target.containerName}: ${e?.stderr || e?.message}`);
          throw new BadRequestException(
            `Cannot browse inside container '${target.containerName}': ${String(e?.stderr || e?.message || 'docker exec failed').slice(0, 300)}`,
          );
        }
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

    // Remote app → FILE_READ via the agent. Dotenv secret-gating applies
    // the same as local (project ADMIN required for raw .env reads).
    const remoteRead = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remoteRead) {
      if (isDotenvName(path.basename(resolved.relPath))) {
        await this.resolvePath(userId, scope, scopeId, relPath, 'ADMIN');
      }
      await this.assertSensitiveOrAdmin(userId, resolved.relPath);
      const task = await this.agent.enqueueAndWait(
        remoteRead.serverId,
        'FILE_READ',
        { slug: remoteRead.slug, legacySlug: remoteRead.legacySlug, file: resolved.relPath },
        30_000,
      );
      if (task.status === 'FAILED') {
        throw new BadRequestException(task.error || 'Remote file read failed');
      }
      const r: any = task.result || {};
      if (!r.exists) throw new NotFoundException('File not found');
      const content = String(r.content ?? '');
      if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_FILE_BYTES) {
        return {
          path: resolved.relPath,
          binary: true,
          size: Buffer.byteLength(content, 'utf-8'),
          message: 'File too large to edit in-browser (>2 MB)',
        };
      }
      return {
        path: resolved.relPath,
        binary: false,
        size: Buffer.byteLength(content, 'utf-8'),
        content,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      };
    }

    // Docker-fs path — read directly from inside the container.
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        // Same secret gating as the host-fs path below: dotenv files hold
        // secrets (gate raw read behind project ADMIN) and any sensitive
        // dotfile component (.git/, .ssh/, .docker/) requires platform
        // ADMIN. Without this a VIEWER could read container-app secrets.
        if (isDotenvName(path.basename(resolved.relPath))) {
          await this.resolvePath(userId, scope, scopeId, relPath, 'ADMIN');
        }
        await this.assertSensitiveOrAdmin(userId, resolved.relPath);
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

    // Remote app → FILE_WRITE via the agent.
    const remoteWrite = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remoteWrite) {
      if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_FILE_BYTES) {
        throw new BadRequestException('File too large (>2MB). Use upload instead.');
      }
      const task = await this.agent.enqueueAndWait(
        remoteWrite.serverId,
        'FILE_WRITE',
        { slug: remoteWrite.slug, legacySlug: remoteWrite.legacySlug, file: resolved.relPath, content },
        30_000,
      );
      if (task.status === 'FAILED') {
        throw new BadRequestException(task.error || 'Remote file write failed');
      }
      await this.audit(userId, scope, scopeId, 'write', resolved.relPath);
      return {
        path: resolved.relPath,
        size: Buffer.byteLength(content, 'utf-8'),
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      };
    }

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

    // Remote app → ship via FILE_WRITE. Payload travels base64 inside the
    // task JSON, so cap remote uploads at 8 MB (config files, dumps, certs
    // — fine; big artifacts should ride git/registry, not the file manager).
    const remoteUp = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remoteUp) {
      const REMOTE_UPLOAD_MAX = 8 * 1024 * 1024;
      if (uploadSize > REMOTE_UPLOAD_MAX) {
        throw new BadRequestException(
          'Uploads to apps on remote servers are limited to 8MB (config files). Use git or a registry image for larger artifacts.',
        );
      }
      const buf = await fs.promises.readFile(tempFilePath);
      const task = await this.agent.enqueueAndWait(
        remoteUp.serverId,
        'FILE_WRITE',
        {
          slug: remoteUp.slug,
          legacySlug: remoteUp.legacySlug,
          file: resolved.relPath,
          content: buf.toString('base64'),
          encoding: 'base64',
        },
        60_000,
      );
      await fs.promises.unlink(tempFilePath).catch(() => {});
      if (task.status === 'FAILED') {
        throw new BadRequestException(task.error || 'Remote upload failed');
      }
      await this.audit(userId, scope, scopeId, 'upload', resolved.relPath);
      return { path: resolved.relPath, size: uploadSize };
    }

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
        // Dotenv files hold secrets — gate raw download behind project
        // ADMIN, matching the host-fs read path. (assertSensitiveOrAdmin
        // above already covers .git/.ssh/.docker dotfile components.)
        if (isDotenvName(path.basename(resolved.relPath))) {
          await this.resolvePath(userId, scope, scopeId, relPath, 'ADMIN');
        }
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
    // Sanitize the destination basename first so a `to: 'subdir/.dockcontrol.env'`
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

    // Remote app → FILE_DELETE via the agent (confined to the app dir,
    // traversal re-checked agent-side).
    const remoteRm = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remoteRm) {
      const task = await this.agent.enqueueAndWait(
        remoteRm.serverId,
        'FILE_DELETE',
        { slug: remoteRm.slug, legacySlug: remoteRm.legacySlug, path: resolved.relPath },
        30_000,
      );
      if (task.status === 'FAILED') {
        if ((task.error || '').includes('not found')) throw new NotFoundException('Path not found');
        throw new BadRequestException(task.error || 'Remote delete failed');
      }
      await this.audit(userId, scope, scopeId, 'remove', resolved.relPath);
      return { path: resolved.relPath, deleted: true };
    }

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

  // ── permissions (chmod / chown) ────────────────────────────────────

  /**
   * chmod a file/dir. `mode` is an octal string ('755') or number; only the 9
   * rwx bits are allowed (parseChmodMode refuses setuid/setgid/sticky). Min role
   * DEVELOPER. Works in all 3 modes. `recursive` applies to directory trees.
   */
  async chmod(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    relPath: string,
    modeInput: string | number,
    recursive = false,
  ): Promise<{ path: string; mode: string }> {
    if (!relPath || relPath === '.') throw new BadRequestException('No path given');
    const mode = parseChmodMode(modeInput);
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'DEVELOPER');
    this.assertNotManaged(resolved.relPath);
    const octal = mode.toString(8).padStart(3, '0');

    const remote = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remote) {
      const task = await this.agent.enqueueAndWait(
        remote.serverId,
        'FILE_CHMOD',
        { slug: remote.slug, legacySlug: remote.legacySlug, path: resolved.relPath, mode, recursive },
        60_000,
      );
      if (task.status === 'FAILED') {
        if ((task.error || '').includes('not found')) throw new NotFoundException('Path not found');
        throw new BadRequestException(task.error || 'Remote chmod failed');
      }
      await this.audit(userId, scope, scopeId, 'chmod', `${resolved.relPath} → ${octal}`);
      return { path: resolved.relPath, mode: octal };
    }

    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const s = await dockerFs.stat(target, resolved.relPath);
        if (!s.exists) throw new NotFoundException('Path not found');
        await dockerFs.chmod(target, resolved.relPath, mode, recursive);
        await this.audit(userId, scope, scopeId, 'chmod', `${resolved.relPath} → ${octal}`);
        return { path: resolved.relPath, mode: octal };
      }
    }

    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('Path not found');
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    this.chmodLocal(resolved.absPath, mode, recursive);
    await this.audit(userId, scope, scopeId, 'chmod', `${resolved.relPath} → ${octal}`);
    return { path: resolved.relPath, mode: octal };
  }

  /** Local chmod, optionally recursive (walk skips symlinks; bounded). */
  private chmodLocal(absPath: string, mode: number, recursive: boolean): void {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) throw new ForbiddenException('Refusing to chmod a symlink');
    fs.chmodSync(absPath, mode);
    if (recursive && st.isDirectory()) {
      let count = 0;
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          if (++count > MAX_PERMS_ENTRIES) {
            throw new BadRequestException(`Too many entries for a recursive chmod (> ${MAX_PERMS_ENTRIES}).`);
          }
          const child = path.join(dir, name);
          const cst = fs.lstatSync(child);
          if (cst.isSymbolicLink()) continue; // never follow / chmod symlinks
          fs.chmodSync(child, mode);
          if (cst.isDirectory()) walk(child);
        }
      };
      walk(absPath);
    }
  }

  /**
   * chown a file/dir. `owner` is "user", "user:group", or numeric "uid[:gid]"
   * (parseChownOwner enforces a strict charset — no shell metacharacters). Names
   * are only honored in container/remote modes (a `chown` binary resolves them);
   * LOCAL host-fs requires NUMERIC uid:gid. Min role DEVELOPER.
   */
  async chown(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    relPath: string,
    ownerInput: string,
    recursive = false,
  ): Promise<{ path: string; owner: string }> {
    if (!relPath || relPath === '.') throw new BadRequestException('No path given');
    const owner = parseChownOwner(ownerInput);
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'DEVELOPER');
    this.assertNotManaged(resolved.relPath);

    const remote = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remote) {
      const task = await this.agent.enqueueAndWait(
        remote.serverId,
        'FILE_CHOWN',
        { slug: remote.slug, legacySlug: remote.legacySlug, path: resolved.relPath, owner: owner.raw, recursive },
        60_000,
      );
      if (task.status === 'FAILED') {
        if ((task.error || '').includes('not found')) throw new NotFoundException('Path not found');
        throw new BadRequestException(task.error || 'Remote chown failed');
      }
      await this.audit(userId, scope, scopeId, 'chown', `${resolved.relPath} → ${owner.raw}`);
      return { path: resolved.relPath, owner: owner.raw };
    }

    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const s = await dockerFs.stat(target, resolved.relPath);
        if (!s.exists) throw new NotFoundException('Path not found');
        await dockerFs.chown(target, resolved.relPath, owner.raw, recursive);
        await this.audit(userId, scope, scopeId, 'chown', `${resolved.relPath} → ${owner.raw}`);
        return { path: resolved.relPath, owner: owner.raw };
      }
    }

    // LOCAL host-fs: only numeric uid:gid (name resolution on the host is
    // fragile and out of scope). Reject names here with a clear message.
    if (!owner.numeric || owner.uid === undefined) {
      throw new BadRequestException(
        'chown by name is only supported for apps running in a container; on the local host use numeric "uid:gid".',
      );
    }
    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('Path not found');
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    // When no group is given, pass -1 → "leave the group unchanged" (matches
    // the `chown 1000` CLI), rather than forcing gid = uid.
    this.chownLocal(resolved.absPath, owner.uid, owner.gid ?? -1, recursive);
    await this.audit(userId, scope, scopeId, 'chown', `${resolved.relPath} → ${owner.raw}`);
    return { path: resolved.relPath, owner: owner.raw };
  }

  /** Local chown (numeric), optionally recursive; never follows symlinks. */
  private chownLocal(absPath: string, uid: number, gid: number, recursive: boolean): void {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) throw new ForbiddenException('Refusing to chown a symlink');
    fs.chownSync(absPath, uid, gid);
    if (recursive && st.isDirectory()) {
      let count = 0;
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          if (++count > MAX_PERMS_ENTRIES) {
            throw new BadRequestException(`Too many entries for a recursive chown (> ${MAX_PERMS_ENTRIES}).`);
          }
          const child = path.join(dir, name);
          const cst = fs.lstatSync(child);
          if (cst.isSymbolicLink()) continue;
          fs.chownSync(child, uid, gid);
          if (cst.isDirectory()) walk(child);
        }
      };
      walk(absPath);
    }
  }

  /**
   * Apply the standard "web app" permission preset to a directory tree:
   * directories → 0775, files → 0664 (group-writable, world-readable). This is
   * the de-facto layout that unblocks PrestaShop, WordPress, Laravel, etc. —
   * the web-server user (in its group) can write, nothing is world-writable.
   *
   * Applied to `relPath` RECURSIVELY (default: the whole app dir). Optionally
   * chowns to www-data in container/remote modes (best-effort; LOCAL skips).
   * Min role DEVELOPER. Works in all 3 modes. Returns how many entries changed.
   */
  async fixWebPermissions(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    relPath = '',
    owner?: string,
  ): Promise<{ path: string; dirs: number; files: number; owner: string | null }> {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'DEVELOPER');
    this.assertNotManaged(resolved.relPath);

    // Default to chowning the tree to www-data (33:33) — without it, a 775 dir
    // owned by root stays unwritable by the web-server process (the actual
    // PrestaShop "Permission denied" cause). Validate to reuse the strict
    // charset guard; an explicit owner from the caller overrides the default.
    const ownerSpec = parseChownOwner(owner || WEB_DEFAULT_OWNER);

    // ── REMOTE: dispatch to the agent. ──
    const remote = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remote) {
      // CONTAINERIZED remote app (PrestaShop/WordPress/…): the files live INSIDE
      // the container (a docker volume), not in the host app dir. Fix perms via
      // `docker exec` on the container docroot — a host-fs walk would touch the
      // wrong tree and leave the app's var/logs unwritable. Reuses the existing
      // EXEC task, so NO agent change/redeploy is needed.
      const container = await this.resolveRemoteContainer(scopeId);
      if (container) {
        const cmd = buildFixWebPermsScript(
          container.rootDir, WEB_DIR_MODE, WEB_FILE_MODE, ownerSpec.raw,
        );
        const task = await this.agent.enqueueAndWait(
          remote.serverId,
          'EXEC',
          { slug: remote.slug, containerName: container.containerName, command: cmd },
          5 * 60_000,
        );
        if (task.status === 'FAILED') {
          throw new BadRequestException(task.error || 'Remote fix-permissions failed');
        }
        const r: any = task.result || {};
        if ((r.exitCode ?? 0) !== 0) {
          throw new BadRequestException(
            `fix-permissions failed in container (exit ${r.exitCode}): ${String(r.output || '').slice(0, 300)}`,
          );
        }
        await this.audit(
          userId, scope, scopeId, 'fix-permissions',
          `container:${container.rootDir} → ${ownerSpec.raw}`,
        );
        return { path: container.rootDir, dirs: -1, files: -1, owner: ownerSpec.raw };
      }

      // Non-containerized remote app (PHP_SITE bind-mount, host-file compose):
      // walk the host app dir via FILE_FIXPERMS (chmod + chown in one pass).
      const task = await this.agent.enqueueAndWait(
        remote.serverId,
        'FILE_FIXPERMS',
        {
          slug: remote.slug,
          legacySlug: remote.legacySlug,
          path: resolved.relPath,
          dirMode: WEB_DIR_MODE,
          fileMode: WEB_FILE_MODE,
          owner: ownerSpec.raw,
        },
        5 * 60_000,
      );
      if (task.status === 'FAILED') {
        if ((task.error || '').includes('not found')) throw new NotFoundException('Path not found');
        throw new BadRequestException(task.error || 'Remote fix-permissions failed');
      }
      const r: any = task.result || {};
      const remoteOwner = r.chownFailed ? null : ownerSpec.raw;
      await this.audit(
        userId, scope, scopeId, 'fix-permissions',
        `${resolved.relPath || '.'}${remoteOwner ? ` → ${remoteOwner}` : ' (chmod only — agent not privileged for chown)'}`,
      );
      return { path: resolved.relPath || '.', dirs: r.dirs ?? 0, files: r.files ?? 0, owner: remoteOwner };
    }

    // ── DOCKER-FS: walk inside the container. ──
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const s = await dockerFs.stat(target, resolved.relPath);
        if (!s.exists) throw new NotFoundException('Path not found');
        await dockerFs.fixWebPerms(target, resolved.relPath, WEB_DIR_MODE, WEB_FILE_MODE);
        // chown to www-data inside the container — this is the part that
        // actually unblocks writes. Surfaces a real failure (not best-effort).
        await dockerFs.chown(target, resolved.relPath, ownerSpec.raw, true);
        await this.audit(userId, scope, scopeId, 'fix-permissions', `${resolved.relPath || '.'} → ${ownerSpec.raw}`);
        return { path: resolved.relPath || '.', dirs: -1, files: -1, owner: ownerSpec.raw };
      }
    }

    // ── LOCAL host fs. ──
    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('Path not found');
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    const counts = { dirs: 0, files: 0 };
    // chown the tree numerically when possible. On the host this needs the API
    // process to be privileged; if it can't (EPERM), the chmod still applies —
    // `chownFailed` records that so we report "chmod only" honestly.
    const chownUid = ownerSpec.numeric && ownerSpec.uid !== undefined ? ownerSpec.uid : -1;
    const chownGid = ownerSpec.numeric ? (ownerSpec.gid ?? -1) : -1;
    const state = { ...counts, chownFailed: false };
    this.fixWebPermsLocal(resolved.absPath, state, chownUid, chownGid);
    const ownerApplied = chownUid >= 0 && !state.chownFailed ? ownerSpec.raw : null;
    await this.audit(
      userId, scope, scopeId, 'fix-permissions',
      `${resolved.relPath || '.'}${ownerApplied ? ` → ${ownerApplied}` : ' (chmod only)'}`,
    );
    return { path: resolved.relPath || '.', dirs: state.dirs, files: state.files, owner: ownerApplied };
  }

  /**
   * LOCAL recursive web-perms walk: dirs→775, files→664; optionally chown to
   * uid/gid (-1 = skip). Skips symlinks and managed secret files. chmod is
   * authoritative; chown is best-effort (sets `chownFailed` on EPERM and stops
   * retrying it) so an unprivileged API process still applies the perms fix.
   */
  private fixWebPermsLocal(
    absPath: string,
    state: { dirs: number; files: number; chownFailed: boolean },
    uid = -1,
    gid = -1,
  ): void {
    // NEVER touch a managed file (.dockcontrol.env holds secrets at 0600;
    // docker-compose.override.yml). 664 would make them group/world-readable.
    // assertNotManaged only guards the TOP path, so we must re-check each child.
    if (this.isManaged(path.basename(absPath))) return;
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) return; // never touch symlinks
    const applyChown = () => {
      if (uid < 0 && gid < 0) return;
      if (state.chownFailed) return; // already denied — don't hammer
      try {
        fs.chownSync(absPath, uid, gid);
      } catch (e: any) {
        if (e?.code === 'EPERM' || e?.code === 'ENOSYS') state.chownFailed = true;
        else throw e;
      }
    };
    if (st.isDirectory()) {
      fs.chmodSync(absPath, WEB_DIR_MODE);
      applyChown();
      state.dirs++;
      for (const name of fs.readdirSync(absPath)) {
        if (state.dirs + state.files > MAX_PERMS_ENTRIES) {
          throw new BadRequestException(
            `Too many entries to fix (> ${MAX_PERMS_ENTRIES}). Fix a subfolder instead.`,
          );
        }
        this.fixWebPermsLocal(path.join(absPath, name), state, uid, gid);
      }
    } else if (st.isFile()) {
      fs.chmodSync(absPath, WEB_FILE_MODE);
      applyChown();
      state.files++;
    }
  }

  // ── extract (.zip) ─────────────────────────────────────────────────

  /**
   * Extract a .zip archive IN PLACE (into its parent directory), like a
   * classic `unzip`. Works in all three file-manager modes:
   *  - REMOTE app  → a single FILE_EXTRACT agent task (Go `archive/zip` with
   *    the same zip-slip guard the backups restore uses) — the archive is never
   *    shipped back over the wire.
   *  - DOCKER-FS   → copy the .zip out of the container, decode + validate it on
   *    the API, then push each entry back in via `docker cp` (no `unzip` needed
   *    inside the image).
   *  - LOCAL       → decode on the API and write each entry through the existing
   *    O_NOFOLLOW, symlink-checked writer.
   *
   * Security: every entry name is validated to a safe relative path BEFORE any
   * write (zip-slip), the total uncompressed size is capped against the
   * project's remaining quota (zip-bomb), and writes reuse the same symlink
   * defenses as upload. Min role DEVELOPER (same as upload/mkdir/write).
   */
  async extract(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    zipRelPath: string,
    opts: { deleteAfter?: boolean } = {},
  ): Promise<{ path: string; files: number; deletedArchive: boolean }> {
    if (!zipRelPath || zipRelPath === '.') {
      throw new BadRequestException('No archive path given');
    }
    const format = detectArchiveFormat(zipRelPath);
    if (!format) {
      throw new BadRequestException('Unsupported archive (.zip, .tar.gz, .tgz, .tar, .gz).');
    }
    const resolved = await this.resolvePath(userId, scope, scopeId, zipRelPath, 'DEVELOPER');
    this.assertNotManaged(resolved.relPath);
    // Destination = the archive's parent directory ("." when at the root).
    const destRel = resolved.relPath.includes('/')
      ? resolved.relPath.slice(0, resolved.relPath.lastIndexOf('/'))
      : '';
    const archiveBasename = resolved.relPath.includes('/')
      ? resolved.relPath.slice(resolved.relPath.lastIndexOf('/') + 1)
      : resolved.relPath;

    // ── REMOTE: delegate to the agent (Go-side extraction). ──
    const remote = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remote) {
      const task = await this.agent.enqueueAndWait(
        remote.serverId,
        'FILE_EXTRACT',
        {
          slug: remote.slug,
          legacySlug: remote.legacySlug,
          file: resolved.relPath,
          dest: destRel,
          format,
          deleteAfter: !!opts.deleteAfter,
        },
        5 * 60_000,
      );
      if (task.status === 'FAILED') {
        if ((task.error || '').includes('not found')) throw new NotFoundException('Archive not found');
        throw new BadRequestException(task.error || 'Remote extraction failed');
      }
      const r: any = task.result || {};
      await this.audit(userId, scope, scopeId, 'extract', resolved.relPath);
      return {
        path: destRel || '.',
        files: typeof r.files === 'number' ? r.files : 0,
        deletedArchive: !!opts.deleteAfter,
      };
    }

    // Cap uncompressed output at the project's remaining quota (or an absolute
    // ceiling), so an archive can't blow past the storage budget.
    const projectId = await this.projectIdForScope(scope, scopeId);
    const remaining = await this.remainingQuotaBytes(projectId);

    // ── DOCKER-FS: pull the zip out, decode on the API, push entries back. ──
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        const st = await dockerFs.stat(target, resolved.relPath);
        if (!st.exists || !st.isFile) throw new NotFoundException('Archive not found');
        const tmpZip = path.join(TMP_DIR, `dc-extract-${crypto.randomBytes(8).toString('hex')}`);
        // Stage the WHOLE decoded archive in one host temp dir, then push it in
        // a SINGLE `docker cp`. The old path did one `docker cp` per file — 44k
        // files = 44k process spawns = multi-minute extractions. One cp lets
        // docker's internal tar recreate the tree in seconds.
        const stageDir = path.join(TMP_DIR, `dc-stage-${crypto.randomBytes(8).toString('hex')}`);
        try {
          await dockerFs.copyOut(target, resolved.relPath, tmpZip);
          const zipBuf = await fs.promises.readFile(tmpZip);
          const files = decodeArchive(format, zipBuf, archiveBasename, remaining);
          fs.mkdirSync(stageDir, { recursive: true });
          const stageRoot = fs.realpathSync(stageDir);
          for (const f of files) {
            // Per-entry managed-file guard (parity with LOCAL mode) — an archive
            // entry must not overwrite a DockControl-managed file.
            this.assertNotManaged([destRel, f.path].filter(Boolean).join('/'));
            // Belt-and-suspenders containment: decodeArchive already strips `..`,
            // but re-confirm each staged path stays under the temp root before we
            // write (the entries become real host files momentarily).
            const abs = path.resolve(stageRoot, f.path);
            if (abs !== stageRoot && !abs.startsWith(stageRoot + path.sep)) {
              throw new BadRequestException(`Archive entry escapes staging: ${f.path}`);
            }
            if (f.isDir) {
              // Empty dir (e.g. var/logs/) — stage it so `docker cp` recreates it.
              fs.mkdirSync(abs, { recursive: true });
            } else {
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, f.data);
            }
          }
          // One docker cp: stageDir/. → <container>:<destRel> (creates subdirs).
          await dockerFs.copyInDir(target, destRel, stageRoot);
          if (opts.deleteAfter) await dockerFs.remove(target, resolved.relPath);
          await this.audit(userId, scope, scopeId, 'extract', resolved.relPath);
          return { path: destRel || '.', files: files.length, deletedArchive: !!opts.deleteAfter };
        } catch (e: any) {
          // Re-throw clean HTTP errors (quota, managed-file, not-found) as-is;
          // convert raw docker/fs failures into a clear 4xx instead of a 500.
          if (e instanceof HttpException) throw e;
          if (e instanceof dockerFs.ContainerNotRunningError || e instanceof dockerFs.NoShellError) {
            throw new BadRequestException(e.message);
          }
          this.logger.warn(`docker-fs extract failed for ${target.containerName}: ${e?.stderr || e?.message}`);
          throw new BadRequestException(
            `Extraction failed inside container '${target.containerName}': ${String(e?.stderr || e?.message || 'docker error').slice(0, 300)}`,
          );
        } finally {
          await fs.promises.unlink(tmpZip).catch(() => {});
          await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // ── LOCAL: decode on the API, write through the symlink-safe writer. ──
    if (!fs.existsSync(resolved.absPath) || !fs.lstatSync(resolved.absPath).isFile()) {
      throw new NotFoundException('Archive not found');
    }
    const zipBuf = await fs.promises.readFile(resolved.absPath);
    const files = decodeArchive(format, zipBuf, archiveBasename, remaining);
    // Charge the whole decompressed total against quota up front (one check).
    const totalBytes = files.reduce((n, f) => n + f.data.length, 0);
    await this.checkQuota(projectId, totalBytes);

    let written = 0;
    for (const f of files) {
      // Re-resolve EACH destination path through the sandbox (defence in depth
      // on top of decodeZipSafely's own validation).
      const entryRel = [destRel, f.path].filter(Boolean).join('/');
      const entryResolved = await this.resolvePath(userId, scope, scopeId, entryRel, 'DEVELOPER');
      this.assertNotManaged(entryResolved.relPath);
      if (f.isDir) {
        // Empty directory entry (e.g. PrestaShop's var/logs/) — create it so it
        // isn't lost; a missing writable dir breaks apps that expect it.
        fs.mkdirSync(entryResolved.absPath, { recursive: true });
        written++;
        continue;
      }
      fs.mkdirSync(path.dirname(entryResolved.absPath), { recursive: true });
      this.assertNoSymlinkInPath(entryResolved.rootDir, entryResolved.absPath);
      this.writeFileNoFollow(entryResolved.absPath, f.data);
      written++;
    }
    // The cached usage no longer reflects what we just wrote — drop it.
    this.invalidateQuota(projectId);

    let deletedArchive = false;
    if (opts.deleteAfter) {
      this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
      fs.rmSync(resolved.absPath, { force: true });
      deletedArchive = true;
    }
    await this.audit(userId, scope, scopeId, 'extract', resolved.relPath);
    return { path: destRel || '.', files: written, deletedArchive };
  }

  // ── compress (download selection as archive) ───────────────────────

  /**
   * Build a .zip or .tar.gz of the selected paths (files and/or directories,
   * recursively) and return it as a stream for download. Read-only → min role
   * VIEWER. Works in all three modes:
   *  - REMOTE app → a FILE_COMPRESS agent task tars the selection server-side
   *    and ships the blob back over the transfer channel.
   *  - DOCKER-FS  → read each file out of the container (`docker cp`), encode
   *    on the API.
   *  - LOCAL      → walk the host fs (symlink/managed-safe) and encode.
   *
   * Safety: every path is sandbox-resolved; symlinks and managed files are
   * refused; the total bytes read are capped (anti-DoS). Encoding is pure-JS
   * (fflate), so no system `zip`/`tar` is required.
   */
  async compress(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    paths: string[],
    format: CompressFormat,
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new BadRequestException('No files selected');
    }
    if (paths.length > 1000) {
      throw new BadRequestException('Too many items selected (max 1000).');
    }
    // VIEWER is enough — compression only READS. resolvePath enforces RBAC.
    const collected: ExtractedFile[] = [];
    let totalBytes = 0;
    const addFile = (relInArchive: string, data: Buffer) => {
      totalBytes += data.length;
      if (totalBytes > MAX_COMPRESS_BYTES) {
        throw new PayloadTooLargeException(
          `Selection exceeds the ${MAX_COMPRESS_BYTES} byte compression limit. Use SFTP for very large transfers.`,
        );
      }
      if (collected.length >= MAX_COMPRESS_ENTRIES) {
        throw new BadRequestException(`Too many files to compress (> ${MAX_COMPRESS_ENTRIES}).`);
      }
      collected.push({ path: relInArchive, data });
    };

    // Secret gating, identical to readFile/downloadFile: a dotenv file requires
    // project ADMIN, and any sensitive-dotfile component (.git/.ssh/.docker/…)
    // requires platform ADMIN. compress() READS full file CONTENT into the
    // archive, so without this a VIEWER could exfiltrate secrets by selecting
    // (or containing) .env/.git/.ssh. Applied per selected path in every mode.
    const gateSecret = async (relPath: string) => {
      if (isDotenvName(path.basename(relPath))) {
        await this.resolvePath(userId, scope, scopeId, relPath, 'ADMIN');
      }
      await this.assertSensitiveOrAdmin(userId, relPath);
    };

    const remote = await this.resolveRemoteFsTarget(scope, scopeId);
    if (remote) {
      // Validate each selected path before handing them to the agent.
      const rels: string[] = [];
      for (const p of paths) {
        const r = await this.resolvePath(userId, scope, scopeId, p, 'VIEWER');
        this.assertNotManaged(r.relPath);
        await gateSecret(r.relPath);
        rels.push(r.relPath);
      }
      // The agent builds the archive server-side and returns it base64 in the
      // task result. Bounded by REMOTE_COMPRESS_MAX on the agent — big remote
      // selections should use SFTP, not this path.
      const task = await this.agent.enqueueAndWait(
        remote.serverId,
        'FILE_COMPRESS',
        { slug: remote.slug, legacySlug: remote.legacySlug, paths: rels, format },
        10 * 60_000,
      );
      if (task.status === 'FAILED') {
        throw new BadRequestException(task.error || 'Remote compression failed');
      }
      const r: any = task.result || {};
      if (typeof r.archive !== 'string' || !r.archive) {
        throw new BadRequestException('Remote compression returned no archive');
      }
      const buffer = Buffer.from(r.archive, 'base64');
      await this.audit(userId, scope, scopeId, 'compress', rels.join(','));
      return { buffer, filename: this.compressFilename(format) };
    }

    // ── DOCKER-FS ──
    if (scope === 'app') {
      const target = await this.resolveDockerTarget(scopeId);
      if (target) {
        for (const p of paths) {
          const r = await this.resolvePath(userId, scope, scopeId, p, 'VIEWER');
          this.assertNotManaged(r.relPath);
          await gateSecret(r.relPath);
          await this.collectDockerEntries(target, r.relPath, addFile);
        }
        const buffer = encodeArchive(format, collected);
        await this.audit(userId, scope, scopeId, 'compress', paths.join(','));
        return { buffer, filename: this.compressFilename(format) };
      }
    }

    // ── LOCAL ──
    for (const p of paths) {
      const r = await this.resolvePath(userId, scope, scopeId, p, 'VIEWER');
      this.assertNotManaged(r.relPath);
      await gateSecret(r.relPath);
      this.collectLocalEntries(r.rootDir, r.absPath, r.relPath, addFile);
    }
    const buffer = encodeArchive(format, collected);
    await this.audit(userId, scope, scopeId, 'compress', paths.join(','));
    return { buffer, filename: this.compressFilename(format) };
  }

  /** Filename for a compressed download: archive-<date>.<ext>. */
  private compressFilename(format: CompressFormat): string {
    const ext = format === 'zip' ? 'zip' : 'tar.gz';
    const stamp = new Date().toISOString().slice(0, 10);
    return `archive-${stamp}.${ext}`;
  }

  /** Walk a LOCAL path (file or dir) collecting regular files; refuse symlinks. */
  private collectLocalEntries(
    rootDir: string,
    absPath: string,
    relPath: string,
    add: (rel: string, data: Buffer) => void,
    isRoot = true,
  ): void {
    // Never SWEEP a secret into the archive via a selected PARENT dir. Only
    // skip DESCENDANTS here (isRoot=false) — the explicitly-selected top path
    // was already authorized by gateSecret (an ADMIN may legitimately compress
    // a .env they selected directly). Children of a non-secret dir are not
    // separately gated, so we drop sensitive/dotenv/managed ones during the walk.
    if (
      !isRoot &&
      (this.pathTraversesSensitive(relPath) ||
        isDotenvName(path.basename(relPath)) ||
        this.isManaged(path.basename(relPath)))
    ) {
      return;
    }
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) {
      throw new ForbiddenException(`Refusing to compress a symlink: ${relPath}`);
    }
    if (st.isFile()) {
      this.assertNoSymlinkInPath(rootDir, absPath);
      // Read through an O_NOFOLLOW fd, NOT fs.readFileSync: between the lstat
      // above and the open here a sandbox-writable attacker could swap the file
      // for a symlink to e.g. /etc/passwd. O_NOFOLLOW closes that TOCTOU window
      // (fails with ELOOP) — every other read path already does this.
      add(relPath, this.readFileNoFollowBuffer(absPath));
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(absPath)) {
        this.collectLocalEntries(rootDir, path.join(absPath, name), `${relPath}/${name}`, add, false);
      }
    }
    // anything else (device/fifo) is silently skipped.
  }

  /** Walk a DOCKER-FS path (file or dir) collecting regular files. */
  private async collectDockerEntries(
    target: DockerFsTarget,
    relPath: string,
    add: (rel: string, data: Buffer) => void,
    isRoot = true,
  ): Promise<void> {
    // Skip secret DESCENDANTS swept in via a selected parent dir (the top
    // selection was already gated by gateSecret): sensitive dotfiles, dotenv,
    // managed files. Parity with collectLocalEntries.
    if (
      !isRoot &&
      (this.pathTraversesSensitive(relPath) ||
        isDotenvName(path.basename(relPath)) ||
        this.isManaged(path.basename(relPath)))
    ) {
      return;
    }
    const st = await dockerFs.stat(target, relPath);
    if (!st.exists) throw new NotFoundException(`Not found: ${relPath}`);
    if (st.isFile) {
      const tmp = path.join(TMP_DIR, `dc-comp-${crypto.randomBytes(8).toString('hex')}`);
      try {
        await dockerFs.copyOut(target, relPath, tmp);
        add(relPath, await fs.promises.readFile(tmp));
      } finally {
        await fs.promises.unlink(tmp).catch(() => {});
      }
      return;
    }
    if (st.isDir) {
      const entries = await dockerFs.listDir(target, relPath);
      for (const e of entries) {
        await this.collectDockerEntries(target, `${relPath}/${e.name}`, add, false);
      }
    }
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
        applications: {
          select: {
            id: true, name: true,
            server: { select: { id: true, host: true } },
          },
        },
        databases: { select: { id: true } },
      },
    });
    if (!project) return 0n;
    // Split local vs remote apps: local dirs are walked on this disk;
    // remote app dirs are summed by their agent (DISK_USAGE), grouped per
    // server so one task covers all that server's apps. Agent failures
    // degrade to 0 for that server (don't block writes on a flaky agent).
    const localApps: Array<{ id: string; name: string }> = [];
    const remoteByServer = new Map<string, Array<{ id: string; name: string }>>();
    for (const a of project.applications) {
      const server = (a as any).server;
      if (server && !isLocalHost(server.host)) {
        const arr = remoteByServer.get(server.id) ?? [];
        arr.push({ id: a.id, name: a.name });
        remoteByServer.set(server.id, arr);
      } else {
        localApps.push({ id: a.id, name: a.name });
      }
    }
    let used = this.computeProjectUsage(
      localApps,
      project.databases.map((d) => d.id),
    );
    for (const [serverId, apps] of remoteByServer) {
      try {
        const task = await this.agent.enqueueAndWait(
          serverId,
          'DISK_USAGE',
          { slugs: apps.flatMap((a) => [remoteAppSlug(a.name, a.id), appSlugify(a.name)]) },
          20_000,
        );
        const total = (task.result as any)?.totalBytes;
        if (task.status === 'COMPLETED' && typeof total === 'number') {
          used += BigInt(Math.max(0, Math.floor(total)));
        }
      } catch {
        // agent unreachable — count 0 for that server this TTL window
      }
    }
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

  /**
   * Bytes still available to write in a project, used as the zip-bomb cap for
   * extraction. Falls back to an absolute ceiling for unlinked/admin scopes (no
   * project budget) so a hostile archive still can't decompress without bound.
   */
  private async remainingQuotaBytes(projectId: string | null): Promise<number> {
    const ABSOLUTE_EXTRACT_CEILING = 2 * 1024 * 1024 * 1024; // 2 GiB hard cap
    if (!projectId) return ABSOLUTE_EXTRACT_CEILING;
    const quota = await this.getProjectQuotaBytes(projectId);
    const used = await this.getProjectUsageCached(projectId);
    const left = quota > used ? quota - used : 0n;
    // Clamp to a Number (sizes are well under 2^53) and to the ceiling.
    return Math.min(Number(left), ABSOLUTE_EXTRACT_CEILING);
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
      await this.prisma.auditLog.create({
        data: {
          userId,
          action,
          resource: `file:${scope}`,
          resourceId: scopeId,
          details: { path: pathInfo },
        },
      });
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[files] audit log failed:', e?.message || e);
    }
  }
}
