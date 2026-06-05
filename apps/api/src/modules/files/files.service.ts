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

const ROOT_DIR = path.join(process.cwd(), '.kryptalis');
const APPS_DIR = path.join(ROOT_DIR, 'apps');
const DBS_DIR = path.join(ROOT_DIR, 'databases');

function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
}

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

// extensions considered text-editable
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.yml', '.yaml', '.json', '.xml', '.html', '.css',
  '.scss', '.sass', '.less', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro', '.py', '.rb', '.php', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.bat', '.cmd', '.toml', '.ini', '.cfg', '.conf', '.config', '.env', '.dockerfile',
  '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.eslintrc',
  '.sql', '.graphql', '.gql', '.proto', '.lock', '.log',
]);
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
              select: {
                id: true,
                name: true,
                framework: true,
                status: true,
              },
            },
            databases: {
              select: {
                id: true,
                name: true,
                type: true,
                applicationId: true,
              },
            },
          },
        },
      },
    });

    // legacy: user owns project but no membership row
    const legacyProjects = await this.prisma.project.findMany({
      where: {
        userId,
        NOT: {
          id: { in: memberships.map((m) => m.projectId) },
        },
      },
      select: {
        id: true,
        name: true,
        applications: {
          select: {
            id: true,
            name: true,
            framework: true,
            status: true,
          },
        },
        databases: {
          select: {
            id: true,
            name: true,
            type: true,
            applicationId: true,
          },
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
        hasFiles: fs.existsSync(path.join(APPS_DIR, slugify(a.name))),
      })),
      databases: p.databases.map((d) => ({
        ...d,
        hasFiles: fs.existsSync(path.join(DBS_DIR, d.name)),
      })),
    }));
  }

  // ── safe path resolution ──────────────────────────────────────────

  /**
   * resolve "/applications/<appId>/some/sub/path" into an absolute on-disk path,
   * after RBAC check. Refuses any path that escapes the app's directory.
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
      const app = await this.prisma.application.findUnique({
        where: { id: scopeId },
      });
      if (!app) throw new NotFoundException('Application not found');
      await assertProjectAccess(this.prisma, userId, app.projectId, minRole);
      scopeName = app.name;
      rootDir = path.join(APPS_DIR, slugify(app.name));
    } else {
      const db = await this.prisma.database.findUnique({
        where: { id: scopeId },
      });
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
      rootDir = path.join(DBS_DIR, db.name);
    }

    if (!fs.existsSync(rootDir)) {
      // create empty so listing works for not-yet-deployed apps
      fs.mkdirSync(rootDir, { recursive: true });
    }

    // strip leading slashes, decode
    const cleaned = relPath
      .replace(/^[/\\]+/, '')
      .replace(/\\/g, '/');
    const absPath = path.resolve(rootDir, cleaned);
    const rootAbs = path.resolve(rootDir);
    if (!absPath.startsWith(rootAbs + path.sep) && absPath !== rootAbs) {
      throw new BadRequestException('Path traversal denied');
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

  // ── listing ───────────────────────────────────────────────────────

  async list(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'VIEWER');
    if (!fs.existsSync(resolved.absPath)) {
      throw new NotFoundException('Path not found');
    }
    const stat = fs.statSync(resolved.absPath);
    if (!stat.isDirectory()) {
      throw new BadRequestException('Path is not a directory');
    }

    const entries: FileEntry[] = [];
    for (const name of fs.readdirSync(resolved.absPath)) {
      // never expose the kryptalis-managed compose env file
      if (name === '.kryptalis.env') continue;
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
    // dirs first, then by name
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
    if (!fs.existsSync(resolved.absPath)) {
      throw new NotFoundException('File not found');
    }
    const stat = fs.statSync(resolved.absPath);
    if (!stat.isFile()) throw new BadRequestException('Path is not a file');

    const ext = path.extname(resolved.absPath).toLowerCase();
    const basename = path.basename(resolved.absPath).toLowerCase();
    const isText =
      TEXT_EXTENSIONS.has(ext) ||
      basename === 'dockerfile' ||
      basename === 'makefile' ||
      basename === 'license' ||
      basename === 'readme' ||
      basename.startsWith('.env');

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
    if (typeof content !== 'string') throw new BadRequestException('content must be a string');
    if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_FILE_BYTES) {
      throw new BadRequestException('File too large (>2MB). Use upload instead.');
    }
    // ensure parent dir
    fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
    fs.writeFileSync(resolved.absPath, content, 'utf-8');
    const stat = fs.statSync(resolved.absPath);
    return {
      path: resolved.relPath,
      size: stat.size,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
  }

  // ── upload (raw binary, max 50MB) ─────────────────────────────────

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
    const safeName = filename.replace(/[/\\]/g, '_');
    const targetRel = relPath ? `${relPath}/${safeName}` : safeName;
    const resolved = await this.resolvePath(userId, scope, scopeId, targetRel, 'DEVELOPER');
    fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });
    fs.writeFileSync(resolved.absPath, buffer);
    const stat = fs.statSync(resolved.absPath);
    return { path: resolved.relPath, size: stat.size };
  }

  // ── download ──────────────────────────────────────────────────────

  async downloadFile(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'VIEWER');
    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('File not found');
    const stat = fs.statSync(resolved.absPath);
    if (!stat.isFile()) throw new BadRequestException('Path is not a file');
    return {
      absPath: resolved.absPath,
      filename: path.basename(resolved.absPath),
      size: stat.size,
    };
  }

  // ── mkdir / rename / delete ───────────────────────────────────────

  async mkdir(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'DEVELOPER');
    if (fs.existsSync(resolved.absPath)) {
      throw new BadRequestException('Path already exists');
    }
    fs.mkdirSync(resolved.absPath, { recursive: true });
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
    const dst = await this.resolvePath(userId, scope, scopeId, toRel, 'DEVELOPER');
    if (!fs.existsSync(src.absPath)) throw new NotFoundException('Source not found');
    if (fs.existsSync(dst.absPath)) throw new BadRequestException('Destination already exists');
    fs.mkdirSync(path.dirname(dst.absPath), { recursive: true });
    fs.renameSync(src.absPath, dst.absPath);
    return { from: src.relPath, to: dst.relPath };
  }

  async remove(userId: string, scope: 'app' | 'db', scopeId: string, relPath: string) {
    // do not allow deleting the scope root
    if (!relPath || relPath === '.') {
      throw new BadRequestException('Cannot delete the root');
    }
    const resolved = await this.resolvePath(userId, scope, scopeId, relPath, 'ADMIN');
    if (!fs.existsSync(resolved.absPath)) throw new NotFoundException('Path not found');
    fs.rmSync(resolved.absPath, { recursive: true, force: true });
    return { path: resolved.relPath, deleted: true };
  }
}
