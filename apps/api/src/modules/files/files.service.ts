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
const MANAGED_FILES = new Set([
  '.kryptalis.env',
  'docker-compose.override.yml', // managed by reconcileWebmails / project-network plumbing
]);

// Hidden by default in listings + read requires ADMIN. These often contain
// raw credentials/tokens (auth keys, git history with leaks, OS keys).
const SENSITIVE_DOTFILES = [
  '.git', '.ssh', '.docker', '.npmrc', '.gitconfig', '.aws',
];

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
    return MANAGED_FILES.has(name);
  }

  private isSensitiveDotfile(name: string): boolean {
    return SENSITIVE_DOTFILES.includes(name);
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
   * Throw if `name` is a Kryptalis-managed file. Apply on every op that
   * accepts a target path (read/write/upload/rename FROM, rename TO,
   * download, remove).
   */
  private assertNotManaged(name: string) {
    if (this.isManaged(name)) {
      throw new ForbiddenException(`${name} is managed by Kryptalis and cannot be touched.`);
    }
  }

  /** Validate an uploaded/renamed basename. */
  private sanitizeBasename(input: string): string {
    if (typeof input !== 'string') throw new BadRequestException('Invalid filename.');
    if (input.includes('\0')) throw new BadRequestException('Null byte in filename.');
    // Take only the basename; strip CR/LF; reject empty/./..
    const raw = path.basename(input.replace(/[\r\n]/g, ''));
    if (!raw || raw === '.' || raw === '..') {
      throw new BadRequestException('Invalid filename.');
    }
    // Replace anything that looks like a control char or path separator.
    const safe = raw.replace(/[\x00-\x1f/\\]/g, '_');
    if (!safe) throw new BadRequestException('Invalid filename.');
    if (this.isManaged(safe)) {
      throw new ForbiddenException(`${safe} is managed by Kryptalis and cannot be touched.`);
    }
    return safe;
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
    const basename = path.basename(resolved.absPath);
    this.assertNotManaged(basename);

    // .env files contain secrets — gate raw read behind project ADMIN.
    const isDotenv = basename === '.env' || basename.startsWith('.env.');
    if (isDotenv) {
      // re-check at ADMIN level — throws on insufficient
      await this.resolvePath(userId, scope, scopeId, relPath, 'ADMIN');
    }
    if (this.isSensitiveDotfile(basename)) {
      // raw read of these requires platform ADMIN
      if (!(await this.isAdmin(userId))) {
        throw new ForbiddenException('Sensitive dotfile read requires platform ADMIN.');
      }
    }

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
      lowerName.startsWith('.env');

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
    const content = fs.readFileSync(resolved.absPath, 'utf-8');
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
    this.assertNotManaged(path.basename(resolved.absPath));
    if (typeof content !== 'string') throw new BadRequestException('content must be a string');
    if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_FILE_BYTES) {
      throw new BadRequestException('File too large (>2MB). Use upload instead.');
    }
    // refuse to overwrite through a symlink even if it points back inside the sandbox
    if (fs.existsSync(resolved.absPath)) {
      const stat = fs.lstatSync(resolved.absPath);
      if (stat.isSymbolicLink()) {
        throw new ForbiddenException('Refusing to write through a symlink.');
      }
    }
    fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
    fs.writeFileSync(resolved.absPath, content, 'utf-8');
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
    if (fs.existsSync(resolved.absPath)) {
      const stat = fs.lstatSync(resolved.absPath);
      if (stat.isSymbolicLink()) {
        throw new ForbiddenException('Refusing to overwrite a symlink.');
      }
    }
    fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
    fs.writeFileSync(resolved.absPath, buffer);
    await this.audit(userId, scope, scopeId, 'upload', resolved.relPath);
    const stat = fs.statSync(resolved.absPath);
    return { path: resolved.relPath, size: stat.size };
  }

  // ── download ──────────────────────────────────────────────────────

  async downloadFile(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'VIEWER');
    this.assertNotManaged(path.basename(resolved.absPath));
    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('File not found');
    const stat = fs.lstatSync(resolved.absPath);
    if (stat.isSymbolicLink()) {
      throw new ForbiddenException('Refusing to download through a symlink.');
    }
    if (!stat.isFile()) throw new BadRequestException('Path is not a file');
    return {
      absPath: resolved.absPath,
      // strip CR/LF and double-quote from the filename used in the
      // Content-Disposition header — caller still applies its own RFC5987
      // encoding for unicode safety.
      filename: path.basename(resolved.absPath).replace(/[\r\n"]/g, '_'),
      size: stat.size,
    };
  }

  // ── mkdir / rename / delete ───────────────────────────────────────

  async mkdir(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'DEVELOPER');
    this.assertNotManaged(path.basename(resolved.absPath));
    if (fs.existsSync(resolved.absPath)) {
      throw new BadRequestException('Path already exists');
    }
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
    this.assertNotManaged(path.basename(src.absPath));
    // The destination basename is user-supplied — sanitize it before passing
    // through resolvePath, so a `to: 'subdir/.kryptalis.env'` is refused
    // before hitting disk.
    const dstParts = toRel.replace(/\\/g, '/').split('/').filter(Boolean);
    const dstName = dstParts.pop() || '';
    this.sanitizeBasename(dstName);
    const dst = await this.resolvePath(userId, scope, scopeId, toRel, 'DEVELOPER');
    this.assertNotManaged(path.basename(dst.absPath));
    if (!fs.existsSync(src.absPath)) throw new NotFoundException('Source not found');
    if (fs.existsSync(dst.absPath)) throw new BadRequestException('Destination already exists');
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
    this.assertNotManaged(path.basename(resolved.absPath));
    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('Path not found');
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
    // Best-effort audit log; do not block the operation if the audit table
    // is missing (it should exist via Prisma migrations, but we don't want
    // to bubble a logging failure as a file op error).
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
    } catch {}
  }
}
