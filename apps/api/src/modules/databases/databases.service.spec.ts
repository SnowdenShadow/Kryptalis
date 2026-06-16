import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as path from 'path';
import * as yaml from 'js-yaml';

// Pure service-level tests (same approach as projects.service.spec):
// plain-object deps, mocked child_process + fs — no docker, no disk.

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('fs', () => {
  const fsMock: any = {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
    promises: {},
  };
  return { ...fsMock, default: fsMock };
});

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
  listAccessibleProjectIds: vi.fn(),
}));

import * as fs from 'fs';
import { execFile } from 'child_process';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { DatabasesService } from './databases.service';

const mockFs = fs as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  rmSync: ReturnType<typeof vi.fn>;
};
const mockAssert = vi.mocked(assertProjectAccess);
const mockListIds = vi.mocked(listAccessibleProjectIds);
const mockExecFile = vi.mocked(execFile) as any;

// promisify(execFile) drives the trailing node-style callback. Default:
// every command succeeds with empty output; tests override per-argv.
type ExecRes = { stdout?: string; stderr?: string };
type Handler = (cmd: string, args: string[]) => ExecRes | Error | undefined;
let handlers: Handler[] = [];

function installExecDefaults() {
  handlers = [];
  mockExecFile.mockImplementation((...a: any[]) => {
    const cmd = a[0] as string;
    const args = (Array.isArray(a[1]) ? a[1] : []) as string[];
    const cb = a[a.length - 1] as (err: any, res?: any) => void;
    let res: ExecRes | Error | undefined;
    for (const h of handlers) {
      res = h(cmd, args);
      if (res !== undefined) break;
    }
    if (res instanceof Error) {
      process.nextTick(() => cb(res));
      return {} as any;
    }
    process.nextTick(() => cb(null, { stdout: res?.stdout ?? '', stderr: res?.stderr ?? '' }));
    return {} as any;
  });
}

const execCalls = () =>
  mockExecFile.mock.calls.map((c: any[]) => ({
    cmd: c[0] as string,
    args: (Array.isArray(c[1]) ? c[1] : []) as string[],
    opts: (typeof c[2] === 'object' ? c[2] : {}) as any,
  }));
const findExec = (pred: (c: { cmd: string; args: string[]; opts: any }) => boolean) =>
  execCalls().find(pred);

function makePrisma() {
  return {
    database: {
      create: vi.fn().mockResolvedValue({ id: 'db1' }),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    project: { findUnique: vi.fn() },
    application: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    // create() resolves the DB's target server row (per-DB placement) —
    // default: the project's local server. Remote tests override.
    server: { findUnique: vi.fn().mockResolvedValue({ id: 'srv1', host: 'localhost' }) },
  };
}

function makeService() {
  const prisma = makePrisma();
  const agent = { enqueueTask: vi.fn().mockResolvedValue({}) };
  const encryption = {
    encrypt: vi.fn((s: string) => `enc(${s})`),
    decrypt: vi.fn((s: string) => s.replace(/^enc\(/, '').replace(/\)$/, '')),
  };
  const service = new DatabasesService(prisma as any, agent as any, encryption as any);
  return { service, prisma, agent, encryption };
}

/** Standard "local server" project wiring for create(). */
function wireLocalCreate(prisma: ReturnType<typeof makePrisma>) {
  prisma.project.findUnique.mockImplementation(async ({ select }: any) =>
    select?.serverId
      ? { serverId: 'srv1' }
      : { server: { id: 'srv1', host: 'localhost' } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps mockRejectedValue implementations — reset the RBAC
  // mocks fully so a rejection in one test can't leak into the next.
  mockAssert.mockReset();
  mockAssert.mockResolvedValue('DEVELOPER' as any);
  mockListIds.mockReset();
  mockListIds.mockResolvedValue([]);
  installExecDefaults();
  mockFs.existsSync.mockReturnValue(true);
});

// flush the un-awaited launchContainer() promise chain
const flushAsync = () => new Promise((r) => setTimeout(r, 0));

// ═══════════════════════════════════════════════════════════════════
// create
// ═══════════════════════════════════════════════════════════════════

describe('create', () => {
  it('rejects an unsupported type before touching anything', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.create('u1', { name: 'x', type: 'ORACLE' } as any),
    ).rejects.toThrow('Unsupported database type');
    expect(prisma.database.create).not.toHaveBeenCalled();
  });

  it('requires projectId (or applicationId)', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { name: 'x', type: 'POSTGRESQL' } as any),
    ).rejects.toThrow('projectId (or applicationId) is required');
  });

  it('resolves projectId from applicationId and rejects a mismatched pair', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'pA' });

    await expect(
      service.create('u1', {
        name: 'x', type: 'POSTGRESQL', applicationId: 'app1', projectId: 'pB',
      } as any),
    ).rejects.toThrow("Application doesn't belong to the given project");
  });

  it('enforces DEVELOPER access on the project (RBAC)', async () => {
    const { service } = makeService();
    mockAssert.mockRejectedValue(new ForbiddenException());

    await expect(
      service.create('u1', { name: 'x', type: 'POSTGRESQL', projectId: 'p1' } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'DEVELOPER');
  });

  it("pins the DB to the project's server: a foreign serverId is rejected", async () => {
    const { service, prisma } = makeService();
    prisma.project.findUnique.mockResolvedValue({ serverId: 'srv1' });
    // Per-DB placement: an explicit serverId is validated against the
    // servers table — unknown id → 404, nothing created.
    prisma.server.findUnique.mockResolvedValue(null);

    await expect(
      service.create('u1', {
        name: 'x', type: 'POSTGRESQL', projectId: 'p1', serverId: 'srv-unknown',
      } as any),
    ).rejects.toThrow('Server not found');
    expect(prisma.database.create).not.toHaveBeenCalled();
  });

  it('per-DB placement: an ONLINE serverId different from the project default is honored', async () => {
    const { service, prisma } = makeService();
    prisma.project.findUnique.mockResolvedValue({ serverId: 'srv1' });
    prisma.server.findUnique.mockResolvedValue({ id: 'srv2', name: 'Second', status: 'ONLINE', host: 'localhost' });

    await service.create('u1', {
      name: 'x', type: 'POSTGRESQL', projectId: 'p1', serverId: 'srv2',
    } as any);

    expect(prisma.database.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ serverId: 'srv2' }) }),
    );
  });

  it('per-DB placement: a non-ONLINE server is refused', async () => {
    const { service, prisma } = makeService();
    prisma.project.findUnique.mockResolvedValue({ serverId: 'srv1' });
    prisma.server.findUnique.mockResolvedValue({ id: 'srv2', name: 'Off', status: 'OFFLINE', host: 'x' });

    await expect(
      service.create('u1', {
        name: 'x', type: 'POSTGRESQL', projectId: 'p1', serverId: 'srv2',
      } as any),
    ).rejects.toThrow(/is OFFLINE/);
    expect(prisma.database.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate name within the same project', async () => {
    const { service, prisma } = makeService();
    prisma.project.findUnique.mockResolvedValue({ serverId: 'srv1' });
    prisma.database.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      service.create('u1', { name: 'app-db', type: 'POSTGRESQL', projectId: 'p1' } as any),
    ).rejects.toThrow(ConflictException);
  });

  it('generates a CSPRNG password, derives username from name, stores the password encrypted', async () => {
    const { service, prisma, encryption } = makeService();
    wireLocalCreate(prisma);

    const res = await service.create('u1', {
      name: 'app-db', type: 'POSTGRESQL', projectId: 'p1',
    } as any);

    const data = prisma.database.create.mock.calls[0][0].data;
    expect(data.username).toBe('app_db'); // dashes → underscores
    expect(data.password).toMatch(/^enc\(dockcontrol_/);
    expect(encryption.encrypt).toHaveBeenCalledTimes(1);
    const rawPass = encryption.encrypt.mock.calls[0][0] as string;
    expect(rawPass).toMatch(/^dockcontrol_[A-Za-z0-9_-]{16}$/); // 12 bytes base64url
    expect(data.serverId).toBe('srv1');
    expect(res.status).toBe('deploying');
    expect(res.connectionString).toBe(
      `postgresql://app_db:${rawPass}@localhost:${data.port}/app-db`,
    );
    await flushAsync();
  });

  it('allocates a host port in the type range, skipping ports already taken', async () => {
    const { service, prisma } = makeService();
    wireLocalCreate(prisma);
    // every port except 5523 is taken in POSTGRESQL's [5440, 5640) range
    const taken: { port: number }[] = [];
    for (let p = 5440; p < 5640; p++) if (p !== 5523) taken.push({ port: p });
    prisma.database.findMany.mockResolvedValue(taken);

    await service.create('u1', { name: 'pgdb', type: 'POSTGRESQL', projectId: 'p1' } as any);

    expect(prisma.database.findMany).toHaveBeenCalledWith({
      where: { port: { gte: 5440, lt: 5640 } },
      select: { port: true },
    });
    expect(prisma.database.create.mock.calls[0][0].data.port).toBe(5523);
    await flushAsync();
  });

  it('throws ConflictException when the whole port range is exhausted', async () => {
    const { service, prisma } = makeService();
    wireLocalCreate(prisma);
    const taken: { port: number }[] = [];
    for (let p = 6390; p < 6590; p++) taken.push({ port: p });
    prisma.database.findMany.mockResolvedValue(taken);

    await expect(
      service.create('u1', { name: 'cache', type: 'REDIS', projectId: 'p1' } as any),
    ).rejects.toThrow('No free host port left');
  });

  it('local server: writes the compose to disk and runs compose pull + up -d in the db dir', async () => {
    const { service, prisma } = makeService();
    wireLocalCreate(prisma);
    mockFs.existsSync.mockReturnValue(false); // force mkdir of the db dir

    await service.create('u1', { name: 'pgdb', type: 'POSTGRESQL', projectId: 'p1' } as any);
    await flushAsync();

    const writeCall = mockFs.writeFileSync.mock.calls.find((c) =>
      String(c[0]).replace(/\\/g, '/').endsWith('/databases/pgdb/docker-compose.yml'),
    );
    expect(writeCall).toBeTruthy();
    const doc: any = yaml.load(writeCall![1] as string);
    expect(doc.services.pgdb.image).toBe('postgres:16-alpine');
    expect(doc.services.pgdb.container_name).toBe('dockcontrol-db-pgdb');
    expect(doc.services.pgdb.environment.POSTGRES_DB).toBe('pgdb');
    expect(doc.services.pgdb.environment.POSTGRES_USER).toBe('pgdb');
    expect(String(doc.services.pgdb.ports[0])).toMatch(/^\d+:5432$/);

    const pull = findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose pull');
    const up = findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d');
    expect(pull).toBeTruthy();
    expect(up).toBeTruthy();
    expect(String(up!.opts.cwd).replace(/\\/g, '/')).toMatch(/\/databases\/pgdb$/);
  });

  it.each([
    ['MYSQL', 'mysql:8', 3306, 'MYSQL_DATABASE'],
    ['MARIADB', 'mariadb:11', 3306, 'MYSQL_DATABASE'],
    ['MONGODB', 'mongo:7', 27017, 'MONGO_INITDB_DATABASE'],
  ] as const)('renders the %s compose (image %s, container port %i)', async (type, image, cport, dbKey) => {
    const { service, prisma } = makeService();
    wireLocalCreate(prisma);

    await service.create('u1', { name: 'mydb', type, projectId: 'p1' } as any);
    await flushAsync();

    const writeCall = mockFs.writeFileSync.mock.calls.find((c) =>
      String(c[0]).includes('docker-compose.yml'),
    );
    const doc: any = yaml.load(writeCall![1] as string);
    expect(doc.services.mydb.image).toBe(image);
    expect(doc.services.mydb.container_name).toBe('dockcontrol-db-mydb');
    expect(String(doc.services.mydb.ports[0])).toMatch(new RegExp(`^\\d+:${cport}$`));
    expect(doc.services.mydb.environment[dbKey]).toBe('mydb');
  });

  it('REDIS compose has no env credentials — password goes through --requirepass', async () => {
    const { service, prisma, encryption } = makeService();
    wireLocalCreate(prisma);

    await service.create('u1', {
      name: 'cache', type: 'REDIS', projectId: 'p1', password: 'p@ss.123',
    } as any);
    await flushAsync();

    expect(encryption.encrypt).toHaveBeenCalledWith('p@ss.123');
    const writeCall = mockFs.writeFileSync.mock.calls.find((c) =>
      String(c[0]).includes('docker-compose.yml'),
    );
    const doc: any = yaml.load(writeCall![1] as string);
    expect(doc.services.cache.image).toBe('redis:7-alpine');
    expect(doc.services.cache.command).toBe('redis-server --requirepass p@ss.123');
    expect(doc.services.cache.environment).toBeUndefined();
  });

  it('remote server: no local docker — compose is delegated to the agent as a DEPLOY task', async () => {
    const { service, prisma, agent } = makeService();
    prisma.project.findUnique.mockImplementation(async ({ select }: any) =>
      select?.serverId
        ? { serverId: 'srv-remote' }
        : { server: { id: 'srv-remote', host: '203.0.113.9' } },
    );
    prisma.server.findUnique.mockResolvedValue({ id: 'srv-remote', host: '203.0.113.9' });

    await service.create('u1', { name: 'pgdb', type: 'POSTGRESQL', projectId: 'p1' } as any);
    await flushAsync();

    expect(agent.enqueueTask).toHaveBeenCalledWith('srv-remote', 'DEPLOY', {
      slug: 'db-pgdb',
      appName: 'db-pgdb',
      compose: expect.stringContaining('dockcontrol-db-pgdb'),
    });
    expect(findExec((c) => c.cmd === 'docker')).toBeUndefined();
  });

  it('REGRESSION: remote server create returns a connection string pointing at the server host, not localhost', async () => {
    const { service, prisma, encryption } = makeService();
    prisma.project.findUnique.mockImplementation(async ({ select }: any) =>
      select?.serverId
        ? { serverId: 'srv-remote' }
        : { server: { id: 'srv-remote', host: '203.0.113.9' } },
    );
    prisma.server.findUnique.mockResolvedValue({ id: 'srv-remote', host: '203.0.113.9' });

    const res = await service.create('u1', { name: 'pgdb', type: 'POSTGRESQL', projectId: 'p1' } as any);
    await flushAsync();

    const rawPass = encryption.encrypt.mock.calls[0][0] as string;
    const port = prisma.database.create.mock.calls[0][0].data.port;
    expect(res.connectionString).toBe(`postgresql://pgdb:${rawPass}@203.0.113.9:${port}/pgdb`);
    expect(res.connectionString).not.toContain('localhost');
  });
});

// ═══════════════════════════════════════════════════════════════════
// RBAC scoping (findAll / findOne / assertDbAccess)
// ═══════════════════════════════════════════════════════════════════

describe('RBAC scoping', () => {
  it('findAll: non-admins only see DBs of projects they can access (incl. app-attached)', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue(['p1', 'p2']);
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });

    await service.findAll('u1', {});

    expect(prisma.database.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { projectId: { in: ['p1', 'p2'] } },
            { application: { projectId: { in: ['p1', 'p2'] } } },
          ],
        },
      }),
    );
  });

  it('findAll: platform admins get the unscoped list', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });

    await service.findAll('admin', {});

    const where = prisma.database.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
  });

  it('findAll: decorates rows with container status + decrypted connection string', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue(['p1']);
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.database.findMany.mockResolvedValue([
      { id: 'db1', name: 'pgdb', type: 'POSTGRESQL', port: 5450, username: 'u', password: 'enc(pw)', autoImported: false, host: null },
    ]);
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'inspect' ? { stdout: 'running\n' } : undefined,
    );

    const [row] = await service.findAll('u1', {});
    expect(row.status).toBe('running');
    expect(row.connectionString).toBe('postgresql://u:pw@localhost:5450/pgdb');
    // status was looked up against the dockcontrol-db- prefixed name
    const insp = findExec((c) => c.cmd === 'docker' && c.args[0] === 'inspect');
    expect(insp!.args).toEqual(['inspect', '--format', '{{.State.Status}}', 'dockcontrol-db-pgdb']);
  });

  it('REGRESSION findAll: remote-server rows get a connection string on the server host (loaded via include, no N+1)', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue(['p1']);
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    prisma.database.findMany.mockResolvedValue([
      { id: 'db1', name: 'pgdb', type: 'POSTGRESQL', port: 5450, username: 'u', password: 'enc(pw)', autoImported: false, host: null, server: { host: '203.0.113.9' } },
      { id: 'db2', name: 'redis', type: 'REDIS', port: 6400, username: 'default', password: 'enc(rp)', autoImported: false, host: null, server: { host: 'localhost' } },
    ]);

    const [remote, local] = await service.findAll('u1', {});
    expect(remote.connectionString).toBe('postgresql://u:pw@203.0.113.9:5450/pgdb');
    expect(local.connectionString).toBe('redis://:rp@localhost:6400');
    // server.host comes back on the row itself — include, not a per-row query
    expect(prisma.database.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ server: { select: { host: true } } }),
      }),
    );
  });

  it('REGRESSION findOne: remote-server DB connection string uses the server host', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER' as any);
    prisma.database.findUnique.mockResolvedValue({
      id: 'db1', projectId: 'p1', applicationId: null, name: 'pgdb',
      type: 'POSTGRESQL', port: 5450, username: 'u', password: 'enc(pw)', autoImported: false, host: null,
      server: { host: '203.0.113.9' },
    });

    const res = await service.findOne('u1', 'db1');
    expect(res.connectionString).toBe('postgresql://u:pw@203.0.113.9:5450/pgdb');
  });

  it('findOne: 404 on unknown id', async () => {
    const { service, prisma } = makeService();
    prisma.database.findUnique.mockResolvedValue(null);
    await expect(service.findOne('u1', 'nope')).rejects.toThrow(NotFoundException);
  });

  it('access check walks app → project when the DB is app-attached', async () => {
    const { service, prisma } = makeService();
    prisma.database.findUnique.mockResolvedValueOnce({
      id: 'db1', projectId: null, applicationId: 'app1', name: 'd', autoImported: false,
    });
    prisma.application.findUnique.mockResolvedValue({ projectId: 'pX' });
    mockAssert.mockRejectedValue(new ForbiddenException());

    await expect(service.start('u1', 'db1')).rejects.toThrow(ForbiddenException);
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'pX', 'DEVELOPER');
  });

  it('unlinked (legacy) DBs are admin-only', async () => {
    const { service, prisma } = makeService();
    prisma.database.findUnique.mockResolvedValue({
      id: 'db1', projectId: null, applicationId: null, name: 'd',
    });
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });

    await expect(service.start('u1', 'db1')).rejects.toThrow('Unlinked databases are admin-only');
  });

  it('remove requires ADMIN role on the project', async () => {
    const { service, prisma } = makeService();
    prisma.database.findUnique.mockResolvedValue({
      id: 'db1', projectId: 'p1', applicationId: null, name: 'd', autoImported: false,
    });
    mockAssert.mockRejectedValue(new ForbiddenException());

    await expect(service.remove('u1', 'db1')).rejects.toThrow(ForbiddenException);
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'ADMIN');
    expect(prisma.database.delete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// lifecycle: start / stop / remove
// ═══════════════════════════════════════════════════════════════════

function wireDbRow(prisma: ReturnType<typeof makePrisma>, row: Record<string, any>) {
  // assertDbAccess + resolveDbServer both call database.findUnique
  prisma.database.findUnique.mockImplementation(async ({ select }: any) =>
    select?.project
      ? { project: { server: { id: 'srv1', host: 'localhost' } }, application: null }
      : row,
  );
}

describe('lifecycle', () => {
  it('auto-imported DBs refuse start/stop (managed by the parent app)', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN' as any);
    wireDbRow(prisma, { id: 'db1', projectId: 'p1', name: 'pg@abc123', autoImported: true });

    await expect(service.start('u1', 'db1')).rejects.toThrow(BadRequestException);
    await expect(service.stop('u1', 'db1')).rejects.toThrow(BadRequestException);
    expect(findExec((c) => c.cmd === 'docker')).toBeUndefined();
    expect(prisma.database.delete).not.toHaveBeenCalled();
  });

  it('auto-imported DB remove: tears down the REAL sidecar container (host) + drops the row + warns', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN' as any);
    // Bundled row: real container_name lives in `host`; parent app still linked.
    wireDbRow(prisma, {
      id: 'db1', projectId: 'p1', applicationId: 'app1',
      name: 'prestashop', autoImported: true, host: 'dockcontrol-prestashop-db-abc123',
    });
    // inspect → report one named volume so we exercise the volume rm path.
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'inspect' ? { stdout: 'prestashop-abc123_data \n' } : undefined,
    );

    const res = await service.remove('u1', 'db1');

    // Removes the bundled container by its REAL name (not dockcontrol-db-<name>).
    const rm = findExec((c) => c.cmd === 'docker' && c.args[0] === 'rm' && c.args.includes('dockcontrol-prestashop-db-abc123'));
    expect(rm).toBeTruthy();
    // Drops the discovered named volume.
    const volRm = findExec((c) => c.cmd === 'docker' && c.args[0] === 'volume' && c.args[1] === 'rm' && c.args.includes('prestashop-abc123_data'));
    expect(volRm).toBeTruthy();
    // NEVER touches the standalone dockcontrol-db-<name> container.
    expect(findExec((c) => c.cmd === 'docker' && c.args.includes('dockcontrol-db-prestashop'))).toBeUndefined();
    expect(prisma.database.delete).toHaveBeenCalledWith({ where: { id: 'db1' } });
    // Warns that the parent app's stack is now incomplete.
    expect(res.message).toMatch(/incomplete|redeploy|delete the application/i);
  });

  it('start runs compose up -d in the db dir', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('DEVELOPER' as any);
    wireDbRow(prisma, { id: 'db1', projectId: 'p1', name: 'pgdb', autoImported: false });

    await service.start('u1', 'db1');

    const up = findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d');
    expect(up).toBeTruthy();
    expect(String(up!.opts.cwd).replace(/\\/g, '/')).toMatch(/\/databases\/pgdb$/);
  });

  it('stop runs compose stop', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('DEVELOPER' as any);
    wireDbRow(prisma, { id: 'db1', projectId: 'p1', name: 'pgdb', autoImported: false });

    await service.stop('u1', 'db1');
    expect(findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose stop')).toBeTruthy();
  });

  it('remove (local): compose down -v --remove-orphans, rm dir, docker rm -f, delete row — exact argv', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN' as any);
    wireDbRow(prisma, { id: 'db1', projectId: 'p1', name: 'pgdb', autoImported: false });

    const res = await service.remove('u1', 'db1');

    const down = findExec((c) => c.cmd === 'docker' && c.args[1] === 'down');
    expect(down!.args).toEqual(['compose', 'down', '-v', '--remove-orphans']);
    expect(String(down!.opts.cwd).replace(/\\/g, '/')).toMatch(/\/databases\/pgdb$/);

    const rmDir = mockFs.rmSync.mock.calls[0];
    expect(String(rmDir[0]).replace(/\\/g, '/')).toMatch(/\/databases\/pgdb$/);
    expect(rmDir[1]).toEqual({ recursive: true, force: true });

    const rm = findExec((c) => c.cmd === 'docker' && c.args[0] === 'rm');
    expect(rm!.args).toEqual(['rm', '-f', 'dockcontrol-db-pgdb']);

    expect(prisma.database.delete).toHaveBeenCalledWith({ where: { id: 'db1' } });
    expect(res).toEqual({ message: 'Database deleted' });
  });

  it('remove (local): still deletes the row when compose down fails (best-effort cleanup)', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('ADMIN' as any);
    wireDbRow(prisma, { id: 'db1', projectId: 'p1', name: 'pgdb', autoImported: false });
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[1] === 'down' ? new Error('daemon dead') : undefined,
    );

    await service.remove('u1', 'db1');
    expect(prisma.database.delete).toHaveBeenCalledWith({ where: { id: 'db1' } });
  });

  it('remove (remote): delegates to the agent with purgeVolumes:true, no local docker', async () => {
    const { service, prisma, agent } = makeService();
    mockAssert.mockResolvedValue('ADMIN' as any);
    prisma.database.findUnique.mockImplementation(async ({ select }: any) =>
      select?.project
        ? { project: { server: { id: 'srv-remote', host: '203.0.113.9' } }, application: null }
        : { id: 'db1', projectId: 'p1', name: 'pgdb', autoImported: false },
    );

    await service.remove('u1', 'db1');

    expect(agent.enqueueTask).toHaveBeenCalledWith('srv-remote', 'REMOVE', {
      slug: 'db-pgdb',
      containerName: 'dockcontrol-db-pgdb',
      purgeVolumes: true,
    });
    expect(findExec((c) => c.cmd === 'docker')).toBeUndefined();
    expect(prisma.database.delete).toHaveBeenCalled();
  });

  it('REGRESSION remove (remote): still deletes the row when agent.enqueueTask throws (parity with local best-effort)', async () => {
    const { service, prisma, agent } = makeService();
    mockAssert.mockResolvedValue('ADMIN' as any);
    prisma.database.findUnique.mockImplementation(async ({ select }: any) =>
      select?.project
        ? { project: { server: { id: 'srv-remote', host: '203.0.113.9' } }, application: null }
        : { id: 'db1', projectId: 'p1', name: 'pgdb', autoImported: false },
    );
    agent.enqueueTask.mockRejectedValue(new Error('agent offline'));

    const res = await service.remove('u1', 'db1');

    expect(prisma.database.delete).toHaveBeenCalledWith({ where: { id: 'db1' } });
    expect(res).toEqual({ message: 'Database deleted' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// importFromAppCompose (auto-import)
// ═══════════════════════════════════════════════════════════════════

describe('importFromAppCompose', () => {
  const COMPOSE_WITH_PG = `services:
  web:
    image: nginx
  db:
    image: postgres:16
    container_name: shop-postgres
    environment:
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: s3cret
      POSTGRES_DB: shopdb
    ports:
      - "5499:5432"
`;

  it('creates a Database row per detected service: host=container_name, port=hostPort, encrypted password', async () => {
    const { service, prisma, encryption } = makeService();
    const appId = 'appabcdef1234';

    const res = await service.importFromAppCompose({
      applicationId: appId,
      projectId: 'p1',
      serverId: 'srv1',
      composeYaml: COMPOSE_WITH_PG,
    });

    expect(res).toEqual({ created: 1, updated: 0, skipped: 0 });
    expect(prisma.database.create).toHaveBeenCalledWith({
      data: {
        name: `db@${appId.slice(0, 6)}`,
        type: 'POSTGRESQL',
        serverId: 'srv1',
        projectId: 'p1',
        applicationId: appId,
        host: 'shop-postgres', // container_name = in-network hostname
        port: 5499, // published host port wins over container port
        username: 'shop',
        password: 'enc(s3cret)',
        autoImported: true,
        serviceName: 'db',
      },
    });
    expect(encryption.encrypt).toHaveBeenCalledWith('s3cret');
  });

  it('falls back to the container port when the service publishes no host port', async () => {
    const { service, prisma } = makeService();
    const compose = `services:
  cache:
    image: redis:7
`;
    await service.importFromAppCompose({
      applicationId: 'app1', projectId: 'p1', serverId: 'srv1', composeYaml: compose,
    });

    expect(prisma.database.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'REDIS', port: 6379, host: 'cache' }),
      }),
    );
  });

  it('DB service WITHOUT container_name: resolves the REAL compose container via docker ps (no orphan)', async () => {
    const { service, prisma } = makeService();
    // App exists → resolveLiveComposeContainer can compute the project + query.
    prisma.application.findUnique.mockResolvedValue({ name: 'My Shop' });
    // docker ps (label-filtered) reports the real compose container name.
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'ps'
        ? { stdout: 'my-shop-abc123def456-cache-1\n' }
        : undefined,
    );
    const compose = `services:\n  cache:\n    image: redis:7\n`;
    await service.importFromAppCompose({
      applicationId: 'abc123def4567890', projectId: 'p1', serverId: 'srv1', composeYaml: compose,
    });
    // host is the REAL container, not the bare service name 'cache' — so
    // status/export/restore/delete all target the live container (no orphan).
    expect(prisma.database.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ host: 'my-shop-abc123def456-cache-1' }),
      }),
    );
  });

  it('is idempotent on redeploy: existing (applicationId, serviceName) rows are updated, not duplicated', async () => {
    const { service, prisma } = makeService();
    prisma.database.findFirst.mockResolvedValue({ id: 'existing-row' });

    const res = await service.importFromAppCompose({
      applicationId: 'app1', projectId: 'p1', serverId: 'srv1', composeYaml: COMPOSE_WITH_PG,
    });

    expect(res).toEqual({ created: 0, updated: 1, skipped: 0 });
    expect(prisma.database.create).not.toHaveBeenCalled();
    expect(prisma.database.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'existing-row' } }),
    );
  });

  it('detects the Redis --requirepass password from the service command and stores it encrypted', async () => {
    const { service, prisma, encryption } = makeService();
    const compose = `services:
  cache:
    image: redis:7-alpine
    container_name: shop-redis
    command: redis-server --requirepass r3disPass
`;
    await service.importFromAppCompose({
      applicationId: 'app1', projectId: 'p1', serverId: 'srv1', composeYaml: compose,
    });

    expect(encryption.encrypt).toHaveBeenCalledWith('r3disPass');
    expect(prisma.database.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'REDIS', password: 'enc(r3disPass)' }),
      }),
    );
  });

  it('redeploy with a blank detected password does NOT overwrite an existing stored password', async () => {
    const { service, prisma, encryption } = makeService();
    prisma.database.findFirst.mockResolvedValue({ id: 'existing-row' });
    // No env password, no --requirepass → detector yields '' for the password.
    const compose = `services:
  cache:
    image: redis:7-alpine
`;
    const res = await service.importFromAppCompose({
      applicationId: 'app1', projectId: 'p1', serverId: 'srv1', composeYaml: compose,
    });

    expect(res).toEqual({ created: 0, updated: 1, skipped: 0 });
    // The update must NOT carry a password field (would clobber the stored one
    // with encrypted "").
    const updateArg = prisma.database.update.mock.calls[0][0];
    expect(updateArg.data).not.toHaveProperty('password');
    expect(encryption.encrypt).not.toHaveBeenCalled();
  });

  it('a single-row failure is counted as skipped and never breaks the batch', async () => {
    const { service, prisma } = makeService();
    prisma.database.create.mockRejectedValueOnce(new Error('unique violation'));
    const compose = `services:
  db:
    image: postgres:16
  cache:
    image: redis:7
`;
    const res = await service.importFromAppCompose({
      applicationId: 'app1', projectId: 'p1', serverId: 'srv1', composeYaml: compose,
    });

    expect(res).toEqual({ created: 1, updated: 0, skipped: 1 });
  });

  it('unparseable YAML / no DB services → zero counters, nothing written', async () => {
    const { service, prisma } = makeService();

    expect(
      await service.importFromAppCompose({
        applicationId: 'a', projectId: 'p', serverId: 's', composeYaml: ': not yaml [',
      }),
    ).toEqual({ created: 0, updated: 0, skipped: 0 });
    expect(
      await service.importFromAppCompose({
        applicationId: 'a', projectId: 'p', serverId: 's',
        composeYaml: 'services:\n  web:\n    image: nginx\n',
      }),
    ).toEqual({ created: 0, updated: 0, skipped: 0 });
    expect(prisma.database.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// deleteAutoImportedForApp + argv safety
// ═══════════════════════════════════════════════════════════════════

describe('deleteAutoImportedForApp', () => {
  it('only deletes autoImported rows of the app, returns the count', async () => {
    const { service, prisma } = makeService();
    prisma.database.deleteMany.mockResolvedValue({ count: 3 });

    expect(await service.deleteAutoImportedForApp('app1')).toBe(3);
    expect(prisma.database.deleteMany).toHaveBeenCalledWith({
      where: { applicationId: 'app1', autoImported: true },
    });
  });
});

describe('docker argv safety', () => {
  it('container status lookups pass the (possibly hostile) name as a single argv element — no shell', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue(['p1']);
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    const evil = 'x; rm -rf / #';
    prisma.database.findMany.mockResolvedValue([
      { id: 'db1', name: 'n', type: 'REDIS', port: 6390, username: 'default', password: '', autoImported: true, host: evil },
    ]);

    await service.findAll('u1', {});

    const insp = findExec((c) => c.cmd === 'docker' && c.args[0] === 'inspect');
    // execFile array argv: the whole string is ONE element, never interpolated
    expect(insp!.args).toEqual(['inspect', '--format', '{{.State.Status}}', evil]);
  });

  it('docker inspect failure degrades to "not running" instead of throwing', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockResolvedValue('VIEWER' as any);
    prisma.database.findUnique.mockResolvedValue({
      id: 'db1', projectId: 'p1', applicationId: null, name: 'pgdb',
      type: 'POSTGRESQL', port: 5450, username: 'u', password: 'enc(pw)', autoImported: false, host: null,
    });
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'inspect' ? new Error('No such object') : undefined,
    );

    const res = await service.findOne('u1', 'db1');
    expect(res.status).toBe('not running');
  });
});
