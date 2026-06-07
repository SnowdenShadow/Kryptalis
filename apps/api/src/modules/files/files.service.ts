import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import type { ProjectRole } from '@prisma/client';

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

@Injectable()
export class FilesService {
  constructor(private prisma: PrismaService) {
    if (!fs.existsSync(ROOT_DIR)) fs.mkdirSync(ROOT_DIR, { recursive: true });
    if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });
    if (!fs.existsSync(DBS_DIR)) fs.mkdirSync(DBS_DIR, { recursive: true });
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
              select: { id: true, name: true, framework: true, status: true },
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
        hasFiles: fs.existsSync(this.appRootDir(a.id)),
      })),
      databases: p.databases.map((d) => ({
        ...d,
        hasFiles: fs.existsSync(this.dbRootDir(d.id)),
      })),
    }));
  }

  // ── path resolution ───────────────────────────────────────────────

  private appRootDir(appId: string) {
    return path.join(APPS_DIR, appId);
  }

  private dbRootDir(dbId: string) {
    return path.join(DBS_DIR, dbId);
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
      rootDir = this.appRootDir(app.id);
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
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'VIEWER');
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
    if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_FILE_BYTES) {
      throw new BadRequestException('File too large (>2MB). Use upload instead.');
    }
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

  async uploadFile(
    userId: string,
    scope: 'app' | 'db',
    scopeId: string,
    relPath: string,
    filename: string,
    buffer: Buffer,
  ) {
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('Upload exceeds 50MB limit');
    }
    const safeName = this.sanitizeBasename(filename);
    const targetRel = relPath ? `${relPath}/${safeName}` : safeName;
    const resolved = await this.resolvePath(userId, scope, scopeId, targetRel, 'DEVELOPER');
    this.assertNotManaged(resolved.relPath);
    fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    this.writeFileNoFollow(resolved.absPath, buffer);
    await this.audit(userId, scope, scopeId, 'upload', resolved.relPath);
    const stat = fs.statSync(resolved.absPath);
    return { path: resolved.relPath, size: stat.size };
  }

  // ── download ──────────────────────────────────────────────────────

  async downloadFile(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'VIEWER');
    this.assertNotManaged(resolved.relPath);
    await this.assertSensitiveOrAdmin(userId, resolved.relPath);
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
    return {
      fd,
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
    if (fs.existsSync(resolved.absPath)) {
      throw new BadRequestException('Path already exists');
    }
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
    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('Path not found');
    this.assertNoSymlinkInPath(resolved.rootDir, resolved.absPath);
    fs.rmSync(resolved.absPath, { recursive: true, force: true });
    await this.audit(userId, scope, scopeId, 'remove', resolved.relPath);
    return { path: resolved.relPath, deleted: true };
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
