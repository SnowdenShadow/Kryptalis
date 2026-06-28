import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';

// Pin the data dir BEFORE the service module computes ROOT_DIR/APPS_DIR/….
vi.hoisted(() => {
  process.env.DOCKCONTROL_DATA_DIR = '/virt/dockcontrol-files';
});

// ── in-memory fs with symlink + O_NOFOLLOW semantics ─────────────────
// The service's whole threat model is symlink containment, so the mock
// must honestly model: realpath following links per component, lstat vs
// stat, ELOOP on O_NOFOLLOW opens of a symlink leaf, EXDEV rename
// fallback. Nodes are keyed by fully-resolved forward-slash paths.
vi.mock('fs', async () => {
  const path = await import('path');
  const { Readable, Writable } = await import('stream');

  type Node = {
    type: 'file' | 'dir' | 'symlink';
    content?: Buffer;
    target?: string;
    mode: number;
    uid?: number;
    gid?: number;
    mtime: Date;
  };
  const nodes = new Map<string, Node>();
  const fds = new Map<number, { key: string; pos: number }>();
  let nextFd = 100;

  const keyOf = (p: any) => path.resolve(String(p)).replace(/\\/g, '/');
  const err = (code: string, msg = code) => {
    const e: any = new Error(`${code}: ${msg}`);
    e.code = code;
    return e;
  };

  /** Follow symlinks component-by-component (and optionally the leaf). */
  function resolveKey(k: string, followLeaf = true, depth = 0): string {
    if (depth > 16) throw err('ELOOP', k);
    const parts = k.split('/');
    let acc = parts[0]; // drive ('C:') or '' on posix
    for (let i = 1; i < parts.length; i++) {
      acc = acc + '/' + parts[i];
      const node = nodes.get(acc);
      const isLeaf = i === parts.length - 1;
      if (node?.type === 'symlink' && (followLeaf || !isLeaf)) {
        const target = keyOf(node.target!);
        const rest = parts.slice(i + 1).join('/');
        return resolveKey(rest ? `${target}/${rest}` : target, followLeaf, depth + 1);
      }
    }
    return acc;
  }

  const statOf = (n: Node) => ({
    isFile: () => n.type === 'file',
    isDirectory: () => n.type === 'dir',
    isSymbolicLink: () => n.type === 'symlink',
    size: n.type === 'file' ? n.content!.length : n.type === 'symlink' ? (n.target?.length ?? 0) : 0,
    mtime: n.mtime,
    mode: n.mode,
  });

  const constants = {
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
    O_CREAT: 0x40, O_TRUNC: 0x200, O_NOFOLLOW: 0x20000,
  };

  const api: any = {
    __nodes: nodes,
    __keyOf: keyOf,
    constants,
    existsSync: (p: any) => {
      try { return nodes.has(resolveKey(keyOf(p))); } catch { return false; }
    },
    realpathSync: (p: any) => {
      const k = resolveKey(keyOf(p));
      if (!nodes.has(k)) throw err('ENOENT', String(p));
      return k.split('/').join(path.sep);
    },
    lstatSync: (p: any) => {
      const n = nodes.get(resolveKey(keyOf(p), false));
      if (!n) throw err('ENOENT', String(p));
      return statOf(n);
    },
    statSync: (p: any) => {
      const n = nodes.get(resolveKey(keyOf(p)));
      if (!n) throw err('ENOENT', String(p));
      return statOf(n);
    },
    mkdirSync: (p: any, _o?: any) => {
      const k = resolveKey(keyOf(p), false);
      const parts = k.split('/');
      let acc = parts[0];
      for (let i = 1; i < parts.length; i++) {
        acc = acc + '/' + parts[i];
        if (!nodes.has(acc)) nodes.set(acc, { type: 'dir', mode: 0o755, mtime: new Date() });
      }
    },
    readdirSync: (p: any, opts?: any) => {
      const k = resolveKey(keyOf(p));
      const dir = nodes.get(k);
      if (!dir) throw err('ENOENT', String(p));
      if (dir.type !== 'dir') throw err('ENOTDIR', String(p));
      const names: string[] = [];
      for (const nk of nodes.keys()) {
        if (nk.startsWith(k + '/') && !nk.slice(k.length + 1).includes('/')) {
          names.push(nk.slice(k.length + 1));
        }
      }
      names.sort();
      if (opts?.withFileTypes) {
        return names.map((name) => {
          const n = nodes.get(`${k}/${name}`)!;
          return {
            name,
            isFile: () => n.type === 'file',
            isDirectory: () => n.type === 'dir',
            isSymbolicLink: () => n.type === 'symlink',
          };
        });
      }
      return names;
    },
    openSync: (p: any, flags: number, mode?: number) => {
      let k = resolveKey(keyOf(p), false);
      let n = nodes.get(k);
      if (n?.type === 'symlink') {
        if (flags & constants.O_NOFOLLOW) throw err('ELOOP', String(p));
        k = resolveKey(keyOf(p), true);
        n = nodes.get(k);
      }
      if (!n) {
        if (!(flags & constants.O_CREAT)) throw err('ENOENT', String(p));
        n = { type: 'file', content: Buffer.alloc(0), mode: mode ?? 0o644, mtime: new Date() };
        nodes.set(k, n);
      } else if (n.type === 'dir') {
        throw err('EISDIR', String(p));
      }
      if (flags & constants.O_TRUNC) n.content = Buffer.alloc(0);
      const fd = nextFd++;
      fds.set(fd, { key: k, pos: 0 });
      return fd;
    },
    fstatSync: (fd: number) => {
      const st = fds.get(fd);
      if (!st) throw err('EBADF');
      return statOf(nodes.get(st.key)!);
    },
    readSync: (fd: number, buf: Buffer, offset: number, length: number, position: number | null) => {
      const st = fds.get(fd)!;
      const content = nodes.get(st.key)!.content!;
      const pos = position == null ? st.pos : position;
      const count = Math.max(0, Math.min(length, content.length - pos));
      content.copy(buf, offset, pos, pos + count);
      if (position == null) st.pos += count;
      return count;
    },
    writeSync: (fd: number, buf: Buffer, offset: number, length: number) => {
      const st = fds.get(fd)!;
      const n = nodes.get(st.key)!;
      n.content = Buffer.concat([n.content ?? Buffer.alloc(0), buf.slice(offset, offset + length)]);
      st.pos += length;
      return length;
    },
    closeSync: (fd: number) => { fds.delete(fd); },
    renameSync: (from: any, to: any) => {
      const kf = resolveKey(keyOf(from), false);
      const kt = resolveKey(keyOf(to), false);
      if (!nodes.has(kf)) throw err('ENOENT', String(from));
      for (const nk of [...nodes.keys()]) {
        if (nk === kf || nk.startsWith(kf + '/')) {
          nodes.set(kt + nk.slice(kf.length), nodes.get(nk)!);
          nodes.delete(nk);
        }
      }
    },
    rmSync: (p: any, _o?: any) => {
      const k = resolveKey(keyOf(p), false);
      for (const nk of [...nodes.keys()]) {
        if (nk === k || nk.startsWith(k + '/')) nodes.delete(nk);
      }
    },
    chmodSync: (p: any, mode: number) => {
      const n = nodes.get(resolveKey(keyOf(p), false));
      if (!n) throw err('ENOENT', String(p));
      n.mode = mode;
    },
    chownSync: (p: any, uid: number, gid: number) => {
      const n = nodes.get(resolveKey(keyOf(p), false));
      if (!n) throw err('ENOENT', String(p));
      n.uid = uid;
      n.gid = gid;
    },
    writeFileSync: (p: any, c: any) => {
      const k = resolveKey(keyOf(p), false);
      nodes.set(k, { type: 'file', content: Buffer.from(c), mode: 0o644, mtime: new Date() });
    },
    createReadStream: (p: any, opts?: any) => {
      const key = opts?.fd != null ? fds.get(opts.fd)!.key : resolveKey(keyOf(p));
      const n = nodes.get(key);
      return Readable.from([Buffer.from(n?.content ?? Buffer.alloc(0))]);
    },
    createWriteStream: (_p: any, opts: any) => {
      const st = fds.get(opts.fd)!;
      return new Writable({
        write(chunk: any, _enc: any, cb: any) {
          const n = nodes.get(st.key)!;
          n.content = Buffer.concat([n.content ?? Buffer.alloc(0), Buffer.from(chunk)]);
          cb();
        },
      });
    },
    promises: {
      stat: vi.fn(async (p: any) => api.statSync(p)),
      rename: vi.fn(async (a: any, b: any) => api.renameSync(a, b)),
    },
  };
  return { ...api, default: api };
});

vi.mock('./docker-fs', () => ({
  pickRootForImage: vi.fn(() => '/'),
  listDir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
}));

import * as fs from 'fs';
import * as dockerFs from './docker-fs';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { FilesService } from './files.service';

const vfs = fs as unknown as {
  __nodes: Map<string, { type: string; content?: Buffer; target?: string }>;
  __keyOf: (p: string) => string;
  promises: { stat: ReturnType<typeof vi.fn>; rename: ReturnType<typeof vi.fn> };
};
const mockAssert = vi.mocked(assertProjectAccess);
const mockedDockerFs = vi.mocked(dockerFs);

const K = (p: string) => path.resolve(p).replace(/\\/g, '/');
const ROOT = K('/virt/dockcontrol-files');
const APPS = `${ROOT}/apps`;
const TMP = `${ROOT}/tmp`;

// app fixture: id 'app1', name 'My App' → sandbox <APPS>/my-app-app1
const APP = { id: 'app1', name: 'My App', projectId: 'p1', containerName: null };
const APP_DIR = `${APPS}/my-app-app1`;

// ── virtual-fs helpers ───────────────────────────────────────────────

function mkDir(rawKey: string) {
  const key = vfs.__keyOf(rawKey);
  const parts = key.split('/');
  let acc = parts[0];
  for (let i = 1; i < parts.length; i++) {
    acc = acc + '/' + parts[i];
    if (!vfs.__nodes.has(acc)) {
      vfs.__nodes.set(acc, { type: 'dir', mode: 0o755, mtime: new Date() } as any);
    }
  }
}
function mkFile(rawKey: string, content: string) {
  const key = vfs.__keyOf(rawKey);
  mkDir(key.slice(0, key.lastIndexOf('/')));
  vfs.__nodes.set(key, {
    type: 'file', content: Buffer.from(content), mode: 0o644, mtime: new Date(),
  } as any);
}
function mkLink(rawKey: string, target: string) {
  const key = vfs.__keyOf(rawKey);
  mkDir(key.slice(0, key.lastIndexOf('/')));
  vfs.__nodes.set(key, { type: 'symlink', target, mode: 0o777, mtime: new Date() } as any);
}

// ── service factory ──────────────────────────────────────────────────

function makeService(opts: { quota?: bigint; userRole?: string } = {}) {
  const prisma = {
    application: {
      findUnique: vi.fn().mockResolvedValue(APP),
    },
    database: { findUnique: vi.fn().mockResolvedValue(null) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ role: opts.userRole ?? 'USER' }),
    },
    project: {
      findUnique: vi.fn().mockImplementation(async (q: any) =>
        q.include
          ? { applications: [{ id: APP.id, name: APP.name }], databases: [] }
          : { storageQuotaBytes: opts.quota ?? null },
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    projectMember: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const agent = {
    enqueueAndWait: vi.fn().mockResolvedValue({ status: 'COMPLETED', result: {} }),
    registerTaskCompletionHandler: vi.fn(),
  };
  const service = new FilesService(prisma as any, agent as any);
  return { service, prisma, agent };
}

beforeEach(() => {
  vi.clearAllMocks();
  vfs.__nodes.clear();
  // restore promises defaults clobbered by clearAllMocks
  vfs.promises.stat.mockImplementation(async (p: any) => (fs as any).statSync(p));
  vfs.promises.rename.mockImplementation(async (a: any, b: any) => (fs as any).renameSync(a, b));
  mockAssert.mockResolvedValue('OWNER' as any);
  mockedDockerFs.pickRootForImage.mockReturnValue('/');
});

// ── path resolution / traversal guards ───────────────────────────────

describe('path traversal guards', () => {
  it('404s on an unknown app', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue(null);
    await expect(service.list('u1', 'app', 'nope', '')).rejects.toThrow(NotFoundException);
  });

  it.each(['../../etc/passwd', '..', 'a/../../..', '..\\..\\windows\\system32'])(
    'rejects lexical escape %j before touching the disk',
    async (rel) => {
      const { service } = makeService();
      await expect(service.readFile('u1', 'app', 'app1', rel)).rejects.toThrow(
        'Path traversal denied.',
      );
    },
  );

  it('rejects null bytes in the path', async () => {
    const { service } = makeService();
    await expect(service.readFile('u1', 'app', 'app1', 'a\0b')).rejects.toThrow(
      'Null byte in path is not allowed.',
    );
  });

  it('an absolute path is de-rooted into the sandbox instead of escaping', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/etc/passwd.txt`, 'sandboxed');
    const res = await service.readFile('u1', 'app', 'app1', '/etc/passwd.txt');
    expect((res as any).content).toBe('sandboxed');
  });

  it('refuses a directory symlink that escapes the sandbox', async () => {
    const { service } = makeService();
    mkDir('/outside/secret');
    mkFile('/outside/secret/key.txt', 'leak');
    mkLink(`${APP_DIR}/link`, '/outside/secret');
    await expect(service.readFile('u1', 'app', 'app1', 'link/key.txt')).rejects.toThrow(
      'Symlink target escapes the sandbox.',
    );
  });

  it('refuses to read through a leaf symlink even when it stays inside', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/real.txt`, 'data');
    mkLink(`${APP_DIR}/alias.txt`, `${APP_DIR}/real.txt`);
    await expect(service.readFile('u1', 'app', 'app1', 'alias.txt')).rejects.toThrow(
      'Refusing to read through a symlink.',
    );
  });

  it('writeFile through a leaf symlink fails closed via O_NOFOLLOW', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/real.txt`, 'data');
    mkLink(`${APP_DIR}/alias.txt`, `${APP_DIR}/real.txt`);
    await expect(
      service.writeFile('u1', 'app', 'app1', 'alias.txt', 'pwn'),
    ).rejects.toThrow('Refusing to write through a symlink.');
    expect(vfs.__nodes.get(`${APP_DIR}/real.txt`)!.content!.toString()).toBe('data');
  });

  it('writeFile refuses an in-sandbox symlinked PARENT directory (assertNoSymlinkInPath)', async () => {
    const { service } = makeService();
    mkDir(`${APP_DIR}/real`);
    mkLink(`${APP_DIR}/ln`, `${APP_DIR}/real`);
    await expect(
      service.writeFile('u1', 'app', 'app1', 'ln/file.txt', 'x'),
    ).rejects.toThrow('Refusing to traverse a symlink in the path.');
  });
});

// ── RBAC ─────────────────────────────────────────────────────────────

describe('RBAC scoping', () => {
  it('list=VIEWER, write=DEVELOPER, remove=ADMIN on the owning project', async () => {
    const { service } = makeService();
    mkDir(APP_DIR);
    mkFile(`${APP_DIR}/f.txt`, 'x');

    await service.list('u1', 'app', 'app1', '');
    expect(mockAssert).toHaveBeenLastCalledWith(expect.anything(), 'u1', 'p1', 'VIEWER');

    await service.writeFile('u1', 'app', 'app1', 'g.txt', 'y');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'DEVELOPER');

    await service.remove('u1', 'app', 'app1', 'f.txt');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'ADMIN');
  });

  it('RBAC rejection propagates before any disk access', async () => {
    const { service } = makeService();
    mockAssert.mockRejectedValue(new ForbiddenException('no access'));
    await expect(service.list('u1', 'app', 'app1', '')).rejects.toThrow('no access');
  });

  it('unlinked database scope is admin-only', async () => {
    const { service, prisma } = makeService();
    prisma.database.findUnique.mockResolvedValue({
      id: 'db1', name: 'loose', projectId: null, applicationId: null,
    });
    await expect(service.list('u1', 'db', 'db1', '')).rejects.toThrow(
      'Unlinked databases are admin-only',
    );
  });

  it('db scope falls back to the linked application project for RBAC', async () => {
    const { service, prisma } = makeService();
    prisma.database.findUnique.mockResolvedValue({
      id: 'db1', name: 'maindb', projectId: null, applicationId: 'app1',
    });
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p-via-app' });
    mkDir(`${ROOT}/databases/db1`);

    await service.list('u1', 'db', 'db1', '');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p-via-app', 'VIEWER');
  });
});

// ── managed / sensitive files ────────────────────────────────────────

describe('managed + sensitive files', () => {
  it.each(['.dockcontrol.env', '.DOCKCONTROL.ENV', 'sub/.dockcontrol.env', 'docker-compose.override.yml'])(
    'read of managed path %j is forbidden',
    async (rel) => {
      const { service } = makeService();
      mkFile(`${APP_DIR}/${rel.toLowerCase()}`, 'secret');
      await expect(service.readFile('u1', 'app', 'app1', rel)).rejects.toThrow(
        /DockControl-managed file/,
      );
    },
  );

  it('rename TO .dockcontrol.env is refused at sanitization', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/a.txt`, 'x');
    await expect(
      service.rename('u1', 'app', 'app1', 'a.txt', '.dockcontrol.env'),
    ).rejects.toThrow(/managed by DockControl/);
  });

  it('.env read requires project ADMIN (DEVELOPER refused)', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/.env`, 'DB_PASSWORD=hunter2');
    mockAssert.mockImplementation(async (_p: any, _u: any, _pid: any, role: any) => {
      if (role === 'ADMIN') throw new ForbiddenException('needs ADMIN');
      return 'DEVELOPER' as any;
    });
    await expect(service.readFile('u1', 'app', 'app1', '.env')).rejects.toThrow('needs ADMIN');
  });

  it('.git/config read requires platform ADMIN', async () => {
    const { service } = makeService({ userRole: 'USER' });
    mkFile(`${APP_DIR}/.git/config`, '[remote "origin"]');
    await expect(service.readFile('u1', 'app', 'app1', '.git/config')).rejects.toThrow(
      'Sensitive dotfile read requires platform ADMIN.',
    );
  });

  it('platform ADMIN can read inside .git', async () => {
    const { service } = makeService({ userRole: 'ADMIN' });
    mkFile(`${APP_DIR}/.git/config`, '[core]');
    await expect(service.readFile('u1', 'app', 'app1', '.git/config')).resolves.toBeDefined();
  });

  it('listing inside .git is refused for non-admins', async () => {
    const { service } = makeService({ userRole: 'USER' });
    mkFile(`${APP_DIR}/.git/config`, 'x');
    await expect(service.list('u1', 'app', 'app1', '.git')).rejects.toThrow(
      'Listing this directory requires platform ADMIN.',
    );
  });
});

// ── list ─────────────────────────────────────────────────────────────

describe('list', () => {
  it('hides managed + sensitive entries and sorts directories first', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/zz.txt`, 'z');
    mkDir(`${APP_DIR}/src`);
    mkFile(`${APP_DIR}/.dockcontrol.env`, 'managed');
    mkDir(`${APP_DIR}/.git`);
    mkFile(`${APP_DIR}/.hidden`, 'h');

    const res = await service.list('u1', 'app', 'app1', '');
    expect(res.entries.map((e) => e.name)).toEqual(['src', '.hidden', 'zz.txt']);
    expect(res.entries[0].type).toBe('directory');
    expect(res.entries[1].isHidden).toBe(true);
  });

  it('lists symlinks as symlinks (lstat, never auto-followed)', async () => {
    const { service } = makeService();
    mkLink(`${APP_DIR}/ln`, '/outside');
    const res = await service.list('u1', 'app', 'app1', '');
    expect(res.entries[0]).toMatchObject({ name: 'ln', type: 'symlink' });
  });

  it('404 on a missing path, 400 on a file path', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/f.txt`, 'x');
    await expect(service.list('u1', 'app', 'app1', 'ghost')).rejects.toThrow(NotFoundException);
    await expect(service.list('u1', 'app', 'app1', 'f.txt')).rejects.toThrow(
      'Path is not a directory',
    );
  });

  it('builds breadcrumbs from the relPath', async () => {
    const { service } = makeService();
    mkDir(`${APP_DIR}/a/b`);
    const res = await service.list('u1', 'app', 'app1', 'a/b');
    expect(res.breadcrumbs).toEqual([
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
    ]);
  });
});

// ── read ─────────────────────────────────────────────────────────────

describe('readFile', () => {
  it('returns content + sha256 for a text file', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/notes.md`, 'hello');
    const res: any = await service.readFile('u1', 'app', 'app1', 'notes.md');
    expect(res).toMatchObject({ binary: false, content: 'hello', size: 5 });
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('flags unknown extensions as binary without reading them', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/blob.bin`, 'x'.repeat(10));
    const res: any = await service.readFile('u1', 'app', 'app1', 'blob.bin');
    expect(res.binary).toBe(true);
    expect(res.content).toBeUndefined();
  });

  it('refuses in-browser editing above 2MB', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/big.txt`, 'x'.repeat(2 * 1024 * 1024 + 1));
    const res: any = await service.readFile('u1', 'app', 'app1', 'big.txt');
    expect(res.binary).toBe(true);
    expect(res.message).toContain('too large');
  });
});

// ── write + quota ────────────────────────────────────────────────────

describe('writeFile + quota', () => {
  it('writes content and audits', async () => {
    const { service, prisma } = makeService();
    mkDir(APP_DIR);
    const res = await service.writeFile('u1', 'app', 'app1', 'src/index.ts', 'export {};');
    expect(res.size).toBe(10);
    expect(vfs.__nodes.get(`${APP_DIR}/src/index.ts`)!.content!.toString()).toBe('export {};');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'write', resource: 'file:app' }),
      }),
    );
  });

  it('rejects non-string content and >2MB payloads', async () => {
    const { service } = makeService();
    mkDir(APP_DIR);
    await expect(
      service.writeFile('u1', 'app', 'app1', 'f.txt', 123 as any),
    ).rejects.toThrow('content must be a string');
    await expect(
      service.writeFile('u1', 'app', 'app1', 'f.txt', 'x'.repeat(2 * 1024 * 1024 + 1)),
    ).rejects.toThrow(BadRequestException);
  });

  it('413s when usage + new bytes exceed the project quota', async () => {
    const { service } = makeService({ quota: 10n });
    mkFile(`${APP_DIR}/existing.txt`, '12345678'); // 8 bytes used
    await expect(
      service.writeFile('u1', 'app', 'app1', 'new.txt', 'abcde'), // +5 > 10
    ).rejects.toThrow(PayloadTooLargeException);
    expect(vfs.__nodes.has(`${APP_DIR}/new.txt`)).toBe(false);
  });

  it('charges only the DELTA when overwriting an existing file', async () => {
    const { service } = makeService({ quota: 10n });
    mkFile(`${APP_DIR}/existing.txt`, '12345678'); // 8/10 used
    // overwrite with 9 bytes: delta = 1, 8+1 ≤ 10 → allowed
    await expect(
      service.writeFile('u1', 'app', 'app1', 'existing.txt', '123456789'),
    ).resolves.toMatchObject({ size: 9 });
  });

  it('mkdir is refused once the project is over budget', async () => {
    const { service } = makeService({ quota: 5n });
    mkFile(`${APP_DIR}/big.txt`, '12345678');
    await expect(service.mkdir('u1', 'app', 'app1', 'newdir')).rejects.toThrow(
      PayloadTooLargeException,
    );
  });

  it('delete invalidates the cached usage so freed space is writable again', async () => {
    const { service } = makeService({ quota: 10n });
    mkFile(`${APP_DIR}/big.txt`, '123456789'); // 9/10
    await expect(
      service.writeFile('u1', 'app', 'app1', 'new.txt', 'abcde'),
    ).rejects.toThrow(PayloadTooLargeException);

    await service.remove('u1', 'app', 'app1', 'big.txt');
    await expect(
      service.writeFile('u1', 'app', 'app1', 'new.txt', 'abcde'),
    ).resolves.toBeDefined();
  });

  it('getProjectStorageUsage returns used/quota as strings (default 10 GiB)', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/f.txt`, 'abc');
    const res = await service.getProjectStorageUsage('u1', 'p1');
    expect(res).toEqual({ used: '3', quota: String(10n * 1024n * 1024n * 1024n) });
  });
});

// ── upload ───────────────────────────────────────────────────────────

describe('uploadFile', () => {
  function stageTemp(content: string) {
    const temp = `${TMP}/upload-test.tmp`;
    mkFile(temp, content);
    return temp;
  }

  it('moves the staged temp into place with an atomic rename', async () => {
    const { service } = makeService();
    mkDir(APP_DIR);
    const temp = stageTemp('payload');

    const res = await service.uploadFile('u1', 'app', 'app1', '', 'data.txt', temp);
    expect(res).toEqual({ path: 'data.txt', size: 7 });
    expect(vfs.__nodes.get(`${APP_DIR}/data.txt`)!.content!.toString()).toBe('payload');
    expect(vfs.__nodes.has(temp)).toBe(false); // consumed by rename
  });

  it('falls back to a streamed copy on EXDEV (tmp on another volume)', async () => {
    const { service } = makeService();
    mkDir(APP_DIR);
    const temp = stageTemp('cross-device');
    vfs.promises.rename.mockImplementationOnce(async () => {
      const e: any = new Error('EXDEV: cross-device link');
      e.code = 'EXDEV';
      throw e;
    });

    const res = await service.uploadFile('u1', 'app', 'app1', '', 'data.txt', temp);
    expect(res.size).toBe(12);
    expect(vfs.__nodes.get(`${APP_DIR}/data.txt`)!.content!.toString()).toBe('cross-device');
  });

  it('sanitizes the filename: path bits stripped, CR/LF removed, control chars replaced', async () => {
    const { service } = makeService();
    mkDir(APP_DIR);
    const temp = stageTemp('x');

    const res = await service.uploadFile('u1', 'app', 'app1', '', '../../evil\r\nname.txt', temp);
    // basename of the CRLF-stripped input — lands INSIDE the sandbox
    expect(res.path).toBe('evilname.txt');
    expect(vfs.__nodes.has(`${APP_DIR}/evilname.txt`)).toBe(true);
  });

  it.each(['..', '.', '', 'a\0b'])('rejects unusable filename %j', async (name) => {
    const { service } = makeService();
    mkDir(APP_DIR);
    const temp = stageTemp('x');
    await expect(
      service.uploadFile('u1', 'app', 'app1', '', name, temp),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses to overwrite a leaf symlink', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/real.txt`, 'keep');
    mkLink(`${APP_DIR}/target.txt`, `${APP_DIR}/real.txt`);
    const temp = stageTemp('attack');

    await expect(
      service.uploadFile('u1', 'app', 'app1', '', 'target.txt', temp),
    ).rejects.toThrow('Refusing to write through a symlink.');
    expect(vfs.__nodes.get(`${APP_DIR}/real.txt`)!.content!.toString()).toBe('keep');
  });

  it('rejects uploads above the 50MB cap from the temp stat (no buffering)', async () => {
    const { service } = makeService();
    mkDir(APP_DIR);
    const temp = stageTemp('small');
    vfs.promises.stat.mockResolvedValueOnce({
      isFile: () => true,
      size: 50 * 1024 * 1024 + 1,
    });
    await expect(
      service.uploadFile('u1', 'app', 'app1', '', 'big.bin', temp),
    ).rejects.toThrow('Upload exceeds 50MB limit');
  });

  it('413s when the upload would blow the quota', async () => {
    const { service } = makeService({ quota: 10n });
    mkFile(`${APP_DIR}/used.txt`, '12345678');
    const temp = stageTemp('abcde');
    await expect(
      service.uploadFile('u1', 'app', 'app1', '', 'new.txt', temp),
    ).rejects.toThrow(PayloadTooLargeException);
  });
});

// ── download / rename / delete ───────────────────────────────────────

describe('downloadFile', () => {
  it('returns a stream + sanitized filename + size', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/report".txt`, 'content!');
    const res = await service.downloadFile('u1', 'app', 'app1', 'report".txt');
    expect(res.filename).toBe('report_.txt');
    expect(res.size).toBe(8);
    expect(res.stream).toBeDefined();
  });

  it('refuses to download through a leaf symlink', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/real.txt`, 'x');
    mkLink(`${APP_DIR}/ln.txt`, `${APP_DIR}/real.txt`);
    await expect(service.downloadFile('u1', 'app', 'app1', 'ln.txt')).rejects.toThrow(
      'Refusing to download through a symlink.',
    );
  });
});

describe('rename', () => {
  it('moves a file and audits the from→to pair', async () => {
    const { service, prisma } = makeService();
    mkFile(`${APP_DIR}/old.txt`, 'x');
    const res = await service.rename('u1', 'app', 'app1', 'old.txt', 'sub/new.txt');
    expect(res).toEqual({ from: 'old.txt', to: 'sub/new.txt' });
    expect(vfs.__nodes.has(`${APP_DIR}/sub/new.txt`)).toBe(true);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'rename',
          details: { path: 'old.txt → sub/new.txt' },
        }),
      }),
    );
  });

  it('404 on missing source, 400 on existing destination', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/a.txt`, 'a');
    mkFile(`${APP_DIR}/b.txt`, 'b');
    await expect(service.rename('u1', 'app', 'app1', 'ghost', 'x.txt')).rejects.toThrow(
      'Source not found',
    );
    await expect(service.rename('u1', 'app', 'app1', 'a.txt', 'b.txt')).rejects.toThrow(
      'Destination already exists',
    );
  });
});

describe('remove', () => {
  it('refuses to delete the sandbox root', async () => {
    const { service } = makeService();
    await expect(service.remove('u1', 'app', 'app1', '')).rejects.toThrow(
      'Cannot delete the root',
    );
    await expect(service.remove('u1', 'app', 'app1', '.')).rejects.toThrow(
      'Cannot delete the root',
    );
  });

  it('deletes a directory recursively', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/dir/deep/f.txt`, 'x');
    const res = await service.remove('u1', 'app', 'app1', 'dir');
    expect(res).toEqual({ path: 'dir', deleted: true });
    expect(vfs.__nodes.has(`${APP_DIR}/dir/deep/f.txt`)).toBe(false);
  });

  it('refuses to delete a managed file', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/.dockcontrol.env`, 'x');
    await expect(service.remove('u1', 'app', 'app1', '.dockcontrol.env')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// ── docker-fs orchestration ──────────────────────────────────────────

describe('docker-fs routing (container-only apps)', () => {
  function setupDockerApp() {
    const ctx = makeService();
    ctx.prisma.application.findUnique.mockResolvedValue({
      ...APP,
      containerName: 'dockcontrol-wp-abc',
      dockerImage: 'wordpress:6',
    });
    mockedDockerFs.pickRootForImage.mockReturnValue('/var/www/html');
    return ctx;
  }
  const TARGET = { containerName: 'dockcontrol-wp-abc', rootDir: '/var/www/html' };

  it('list routes to dockerFs.listDir and still filters sensitive dotfiles', async () => {
    const { service } = setupDockerApp();
    mockedDockerFs.listDir.mockResolvedValue([
      { name: 'wp-config.php', path: 'wp-config.php', type: 'file', size: 3, modifiedAt: '', permissions: '644' },
      { name: '.git', path: '.git', type: 'directory', size: 0, modifiedAt: '', permissions: '755' },
    ] as any);

    const res = await service.list('u1', 'app', 'app1', '');
    expect(mockedDockerFs.listDir).toHaveBeenCalledWith(TARGET, '');
    expect(res.entries.map((e: any) => e.name)).toEqual(['wp-config.php']);
  });

  it('readFile routes to dockerFs and computes the sha over container content', async () => {
    const { service } = setupDockerApp();
    mockedDockerFs.stat.mockResolvedValue({ exists: true, isDir: false, size: 5 } as any);
    mockedDockerFs.readFile.mockResolvedValue('<?php');

    const res: any = await service.readFile('u1', 'app', 'app1', 'index.php');
    expect(res.content).toBe('<?php');
    expect(mockedDockerFs.readFile).toHaveBeenCalledWith(TARGET, 'index.php');
  });

  it('writeFile routes to dockerFs.writeFile (no host write, audit kept)', async () => {
    const { service, prisma } = setupDockerApp();
    await service.writeFile('u1', 'app', 'app1', 'index.php', 'x');
    expect(mockedDockerFs.writeFile).toHaveBeenCalledWith(TARGET, 'index.php', 'x');
    expect(vfs.__nodes.has(`${APP_DIR}/index.php`)).toBe(false);
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('uploadFile streams the staged temp into docker cp', async () => {
    const { service } = setupDockerApp();
    mkFile(`${TMP}/u.tmp`, 'zip');
    await service.uploadFile('u1', 'app', 'app1', 'wp-content', 'plugin.zip', `${TMP}/u.tmp`);
    expect(mockedDockerFs.uploadFile).toHaveBeenCalledWith(
      TARGET, 'wp-content', 'plugin.zip', `${TMP}/u.tmp`,
    );
  });

  it('remove checks container stat first and 404s on a missing path', async () => {
    const { service } = setupDockerApp();
    mockedDockerFs.stat.mockResolvedValue({ exists: false } as any);
    await expect(service.remove('u1', 'app', 'app1', 'ghost')).rejects.toThrow(NotFoundException);
    expect(mockedDockerFs.remove).not.toHaveBeenCalled();
  });

  it('host dir holding real user files flips the scope back to host-fs', async () => {
    const { service } = setupDockerApp();
    mockedDockerFs.pickRootForImage.mockReturnValue('/'); // no image hint
    mkFile(`${APP_DIR}/package.json`, '{}'); // a real user file
    mkFile(`${APP_DIR}/index.js`, 'x');

    const res = await service.list('u1', 'app', 'app1', '');
    expect(mockedDockerFs.listDir).not.toHaveBeenCalled();
    expect(res.entries.map((e: any) => e.name)).toContain('package.json');
  });
});

// ── permissions (chmod / chown) ──────────────────────────────────────
describe('chmod (local mode)', () => {
  it('applies a valid mode to a file', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/index.php`, '<?php');
    const res = await service.chmod('u1', 'app', 'app1', 'index.php', '775', false);
    expect(res.mode).toBe('775');
    const n: any = vfs.__nodes.get(vfs.__keyOf(`${APP_DIR}/index.php`));
    expect(n.mode).toBe(0o775);
  });

  it('rejects setuid/setgid/sticky modes', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/x`, 'y');
    await expect(service.chmod('u1', 'app', 'app1', 'x', '4755', false)).rejects.toThrow();
    await expect(service.chmod('u1', 'app', 'app1', 'x', '1777', false)).rejects.toThrow();
  });

  it('rejects a managed file', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/.dockcontrol.env`, 'SECRET=1');
    await expect(service.chmod('u1', 'app', 'app1', '.dockcontrol.env', '777', false)).rejects.toThrow();
  });

  it('recursive chmod walks the tree', async () => {
    const { service } = makeService();
    mkDir(`${APP_DIR}/var`);
    mkFile(`${APP_DIR}/var/a.txt`, '1');
    mkFile(`${APP_DIR}/var/sub/b.txt`, '2');
    await service.chmod('u1', 'app', 'app1', 'var', '775', true);
    expect((vfs.__nodes.get(vfs.__keyOf(`${APP_DIR}/var/a.txt`)) as any).mode).toBe(0o775);
    expect((vfs.__nodes.get(vfs.__keyOf(`${APP_DIR}/var/sub/b.txt`)) as any).mode).toBe(0o775);
  });
});

describe('chown (local mode)', () => {
  it('accepts numeric uid:gid', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/f`, 'x');
    const res = await service.chown('u1', 'app', 'app1', 'f', '1000:1000', false);
    expect(res.owner).toBe('1000:1000');
  });

  it('rejects chown-by-NAME on the local host (numeric only)', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/f`, 'x');
    await expect(service.chown('u1', 'app', 'app1', 'f', 'www-data', false)).rejects.toThrow(/numeric/i);
  });

  it('rejects shell-injection owner', async () => {
    const { service } = makeService();
    mkFile(`${APP_DIR}/f`, 'x');
    await expect(service.chown('u1', 'app', 'app1', 'f', 'root; rm -rf /', false)).rejects.toThrow();
  });
});
