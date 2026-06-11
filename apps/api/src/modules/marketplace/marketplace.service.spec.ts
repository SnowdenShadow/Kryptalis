import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as path from 'path';

/**
 * MarketplaceService unit tests — same recipe as projects.service.spec.ts:
 * plain vi.fn() dependency objects, no DB, no docker.
 *
 * - child_process.exec is mocked (with the promisify.custom symbol so
 *   `promisify(exec)` resolves `{ stdout, stderr }` like the real thing).
 * - fs is partially mocked: existsSync/readFileSync stay REAL so the
 *   module-level loadCatalog() reads the actual catalog.json; the write
 *   side (mkdirSync/writeFileSync) is stubbed so no install artifacts ever
 *   land on disk.
 */

const { execAsyncMock, execFileAsyncMock, writeFileSyncMock, mkdirSyncMock } = vi.hoisted(() => ({
  execAsyncMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}));

vi.mock('child_process', async () => {
  const util = await import('util');
  const exec: any = vi.fn();
  exec[util.promisify.custom] = (...args: unknown[]) => execAsyncMock(...args);
  // execFile is used (promisified) for the project-network attach argv calls.
  const execFile: any = vi.fn();
  execFile[util.promisify.custom] = (...args: unknown[]) => execFileAsyncMock(...args);
  return { exec, execFile, spawn: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...real,
    mkdirSync: mkdirSyncMock,
    writeFileSync: writeFileSyncMock,
  };
  return { ...mocked, default: mocked };
});

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
}));

import { assertProjectAccess } from '../../common/rbac/project-access';
import { MarketplaceService } from './marketplace.service';

const mockAssert = vi.mocked(assertProjectAccess);

const APP_ID = 'app1234567890abcdef';
const INSTANCE_ID = APP_ID.slice(0, 12); // 'app123456789'

function makePrisma() {
  return {
    project: { findUnique: vi.fn().mockResolvedValue({ serverId: 'srv-1' }) },
    application: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: APP_ID, ...data })),
      update: vi.fn().mockResolvedValue({}),
    },
    domain: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'dom-new', ...data })),
      update: vi.fn().mockResolvedValue({}),
    },
    mailServer: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    agentTask: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'task-1', ...data })),
      update: vi.fn().mockResolvedValue({}),
    },
    deployment: {
      create: vi.fn().mockResolvedValue({ id: 'dep-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeService() {
  const prisma = makePrisma();
  const proxy = { regenerate: vi.fn().mockResolvedValue(undefined) };
  const domainAttach = { attach: vi.fn().mockResolvedValue(undefined) };
  const databases = { importFromAppCompose: vi.fn().mockResolvedValue(undefined) };
  const service = new MarketplaceService(
    prisma as any,
    proxy as any,
    domainAttach as any,
    databases as any,
  );
  return { service, prisma, proxy, domainAttach, databases };
}

/** Drain the fire-and-forget runDockerCompose() chain. */
async function flushAsync() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** stdout of `docker ps --format "{{.Ports}}"` advertising the given host ports. */
function dockerPs(...ports: number[]) {
  return ports.map((p) => `0.0.0.0:${p}->80/tcp`).join('\n');
}

/** Route the exec mock: docker ps probes vs compose pull/up. */
function mockExec(opts: { busyPorts?: number[]; composeFailure?: string } = {}) {
  execAsyncMock.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith('docker ps')) {
      return { stdout: dockerPs(...(opts.busyPorts ?? [])), stderr: '' };
    }
    if (opts.composeFailure) throw new Error(opts.composeFailure);
    return { stdout: '', stderr: '' };
  });
}

/** Last compose body written for the given file name. */
function writtenFile(name: string): string | undefined {
  const call = [...writeFileSyncMock.mock.calls]
    .reverse()
    .find(([p]) => String(p).endsWith(name));
  return call ? String(call[1]) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssert.mockResolvedValue('DEVELOPER' as any);
  mockExec();
  // docker network inspect/create/connect (execFile argv path) succeed by default.
  execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
});

// ── catalogue ───────────────────────────────────────────────────────

describe('catalog (listApps / getApp)', () => {
  it('loads the real catalog.json: non-empty, well-formed entries', () => {
    const { service } = makeService();
    const apps = service.listApps();
    expect(apps.length).toBeGreaterThan(0);
    for (const app of apps) {
      expect(app.slug).toMatch(/^[a-z0-9-]+$/);
      expect(app.ports.length).toBeGreaterThan(0);
      expect(app.containerPort).toBeGreaterThan(0);
    }
  });

  it('catalog slugs are unique', () => {
    const { service } = makeService();
    const slugs = service.listApps().map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('getApp resolves an app by slug with its declared params/defaults', () => {
    const { service } = makeService();
    const app = service.getApp('wordpress');
    expect(app.name).toBe('WordPress');
    expect(app.ports[0]).toBe(8080);
    expect(app.containerPort).toBe(80);
    // Declared env vars surface for the install wizard, required ones flagged.
    const dbPass = app.envVars?.find((e) => e.key === 'WORDPRESS_DB_PASSWORD');
    expect(dbPass?.required).toBe(true);
  });

  it('getApp on an unknown slug → 404', () => {
    const { service } = makeService();
    expect(() => service.getApp('does-not-exist')).toThrow(NotFoundException);
  });
});

// ── install: validation / RBAC ──────────────────────────────────────

describe('install — input validation and RBAC', () => {
  it('refuses an anonymous install (no userId)', async () => {
    const { service } = makeService();
    await expect(
      service.install({ appSlug: 'wordpress', projectId: 'p1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('requires DEVELOPER access on the project (RBAC rejection propagates)', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockRejectedValue(new ForbiddenException('nope'));
    await expect(
      service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1'),
    ).rejects.toThrow(ForbiddenException);
    expect(mockAssert).toHaveBeenCalledWith(prisma, 'u1', 'p1', 'DEVELOPER');
    expect(prisma.application.create).not.toHaveBeenCalled();
  });

  it('404s when the project does not exist', async () => {
    const { service, prisma } = makeService();
    prisma.project.findUnique.mockResolvedValue(null);
    await expect(
      service.install({ appSlug: 'wordpress', projectId: 'ghost' }, 'u1'),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects a serverId that does not match the project's server", async () => {
    const { service } = makeService();
    await expect(
      service.install(
        { appSlug: 'wordpress', projectId: 'p1', serverId: 'srv-evil' },
        'u1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("pins the agent task to the project's server, whatever the client sent", async () => {
    const { service, prisma } = makeService();
    await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');
    expect(prisma.agentTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ serverId: 'srv-1' }) }),
    );
  });

  it('unknown app slug → 404 before any row is written', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.install({ appSlug: 'no-such-app', projectId: 'p1' }, 'u1'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.application.create).not.toHaveBeenCalled();
  });
});

// ── install: port resolution ────────────────────────────────────────

describe('install — port resolution', () => {
  it('user-picked port already published by docker → 409', async () => {
    const { service, prisma } = makeService();
    mockExec({ busyPorts: [9999] });
    await expect(
      service.install({ appSlug: 'wordpress', projectId: 'p1', port: 9999 }, 'u1'),
    ).rejects.toThrow(ConflictException);
    expect(prisma.application.create).not.toHaveBeenCalled();
  });

  it('single-install app on a busy default port → 409 with a clear message (no silent remap)', async () => {
    const { service } = makeService();
    mockExec({ busyPorts: [8080] }); // wordpress default
    await expect(
      service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1'),
    ).rejects.toThrow(/Default port 8080 .* is taken/);
  });

  it('free default port is used and stamped into the compose + application row', async () => {
    const { service, prisma } = makeService();
    await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');
    expect(prisma.application.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ port: 8080, customPort: false, containerPort: 80 }),
      }),
    );
    const compose = writtenFile('docker-compose.yml')!;
    expect(compose).toContain('"8080:80"');
    expect(compose).not.toContain('__HOST_PORT__');
  });

  it('name collision → auto-suffix "<name> 2" and auto-allocate a fresh port (+10 walk)', async () => {
    const { service, prisma } = makeService();
    mockExec({ busyPorts: [8080] });
    // First instance already exists; the suffixed name is free.
    prisma.application.findFirst
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValue(null);

    await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');

    expect(prisma.application.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'WordPress 2', port: 8090 }),
      }),
    );
  });
});

// ── install: compose rendering ──────────────────────────────────────

describe('install — compose rendering and per-instance naming', () => {
  it('replaces __INSTANCE_ID__ everywhere and persists kryptalis-<slug>-<id12> as containerName', async () => {
    const { service, prisma } = makeService();
    const res = await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');
    expect(res.applicationId).toBe(APP_ID);

    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: APP_ID },
        data: { containerName: `kryptalis-wordpress-${INSTANCE_ID}` },
      }),
    );
    const compose = writtenFile('docker-compose.yml')!;
    expect(compose).toContain(`kryptalis-wordpress-${INSTANCE_ID}`);
    expect(compose).toContain(`wp_data_${INSTANCE_ID}`);
    expect(compose).not.toContain('__INSTANCE_ID__');
  });

  it('redis is special-cased to the kryptalis-redis-app-<id12> container name', async () => {
    const { service, prisma } = makeService();
    await service.install({ appSlug: 'redis', projectId: 'p1' }, 'u1');
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { containerName: `kryptalis-redis-app-${INSTANCE_ID}` },
      }),
    );
  });

  it('compose is written into a per-instance dir <slug>-<id12>', async () => {
    const { service } = makeService();
    await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');
    const composeCall = writeFileSyncMock.mock.calls.find(([p]) =>
      String(p).endsWith('docker-compose.yml'),
    )!;
    expect(String(composeCall[0])).toContain(
      path.join('apps', `wordpress-${INSTANCE_ID}`),
    );
  });

  it('__RANDOM_PASSWORD__ placeholders: same value reused per placeholder, distinct across numbered ones, mirrored into .env', async () => {
    const { service } = makeService();
    await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');

    const compose = writtenFile('docker-compose.yml')!;
    expect(compose).not.toContain('__RANDOM_PASSWORD__');
    expect(compose).not.toContain('__RANDOM_PASSWORD_2__');

    // WORDPRESS_DB_PASSWORD and the db's MYSQL_PASSWORD share __RANDOM_PASSWORD__.
    const appPass = compose.match(/WORDPRESS_DB_PASSWORD: (\S+)/)![1];
    const dbPass = compose.match(/MYSQL_PASSWORD: (\S+)/)![1];
    const rootPass = compose.match(/MYSQL_ROOT_PASSWORD: (\S+)/)![1];
    expect(appPass).toBe(dbPass);
    expect(rootPass).not.toBe(appPass);
    expect(appPass.length).toBeGreaterThanOrEqual(24); // strong random

    // Generated passwords also land in the .env file.
    const env = writtenFile('.env')!;
    expect(env).toContain(`__RANDOM_PASSWORD__=${appPass}`);
    expect(env).toContain(`__RANDOM_PASSWORD_2__=${rootPass}`);
  });

  it('user envVars are written to .env (newlines escaped)', async () => {
    const { service } = makeService();
    await service.install(
      {
        appSlug: 'uptime-kuma',
        projectId: 'p1',
        envVars: { FOO: 'bar', MULTI: 'a\nb' },
      },
      'u1',
    );
    const env = writtenFile('.env')!;
    expect(env).toContain('FOO=bar');
    expect(env).toContain('MULTI=a\\nb');
  });
});

// ── install: webmail wiring ─────────────────────────────────────────

describe('install — webmail (roundcube) mail-server wiring', () => {
  it('no mail server deployed → 409 telling the user to deploy one first', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findMany.mockResolvedValue([]);
    prisma.mailServer.count.mockResolvedValue(0);
    await expect(
      service.install({ appSlug: 'roundcube', projectId: 'p1' }, 'u1'),
    ).rejects.toThrow(/Deploy a mail server first/);
  });

  it('several mail servers and no domain picked → 409 asking to disambiguate', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findMany.mockResolvedValue([{ id: 'ms1' }, { id: 'ms2' }]);
    prisma.mailServer.count.mockResolvedValue(2);
    await expect(
      service.install({ appSlug: 'roundcube', projectId: 'p1' }, 'u1'),
    ).rejects.toThrow(/Multiple mail servers exist/);
  });

  it('domainId given → compose patched to ssl://mail.<domain> with the real IMAPS/submission ports', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findUnique.mockResolvedValue({
      imapsPort: 9930,
      submissionPort: 5870,
      domainId: 'dom-1',
    });
    prisma.domain.findUnique.mockResolvedValue({ id: 'dom-1', domain: 'acme.io' });

    await service.install(
      { appSlug: 'roundcube', projectId: 'p1', domainId: 'dom-1' },
      'u1',
    );

    const compose = writtenFile('docker-compose.yml')!;
    expect(compose).toContain('ROUNDCUBEMAIL_DEFAULT_HOST: ssl://mail.acme.io');
    expect(compose).toContain('ROUNDCUBEMAIL_DEFAULT_PORT: "9930"');
    expect(compose).toContain('ROUNDCUBEMAIL_SMTP_SERVER: tls://mail.acme.io');
    expect(compose).toContain('ROUNDCUBEMAIL_SMTP_PORT: "5870"');
    expect(compose).not.toContain('host.docker.internal:993'); // legacy default gone
  });
});

// ── install: domains ────────────────────────────────────────────────

describe('install — domain handling', () => {
  it('newDomain belonging to ANOTHER project → 400', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue({ id: 'dom-x', projectId: 'p-OTHER' });
    await expect(
      service.install(
        { appSlug: 'wordpress', projectId: 'p1', newDomain: 'taken.acme.io' },
        'u1',
      ),
    ).rejects.toThrow(/belongs to another project/);
  });

  it('fresh newDomain → Domain row created and attached to the application', async () => {
    const { service, prisma, domainAttach } = makeService();
    prisma.domain.findUnique.mockResolvedValue(null);

    await service.install(
      { appSlug: 'wordpress', projectId: 'p1', newDomain: 'shop.acme.io' },
      'u1',
    );

    expect(prisma.domain.create).toHaveBeenCalledWith({
      data: { domain: 'shop.acme.io', projectId: 'p1' },
    });
    expect(domainAttach.attach).toHaveBeenCalledWith({
      applicationId: APP_ID,
      domainId: 'dom-new',
      projectId: 'p1',
      customPort: false,
      port: 8080,
    });
  });
});

// ── install: deploy outcome ─────────────────────────────────────────

describe('install — docker compose outcome', () => {
  it('success: task COMPLETED, application RUNNING, deployment RUNNING, Caddy regenerated, DB sidecar import attempted', async () => {
    const { service, prisma, proxy, databases } = makeService();
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'p1',
      project: { serverId: 'srv-1' },
    });

    const res = await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');
    expect(res.taskId).toBe('task-1');
    await flushAsync();

    expect(execAsyncMock).toHaveBeenCalledWith(
      'docker compose pull',
      expect.objectContaining({ cwd: expect.stringContaining(`wordpress-${INSTANCE_ID}`) }),
    );
    expect(execAsyncMock).toHaveBeenCalledWith('docker compose up -d', expect.anything());

    expect(prisma.agentTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: APP_ID }, data: { status: 'RUNNING' } }),
    );
    expect(prisma.deployment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId: APP_ID, status: 'DEPLOYING' },
        data: expect.objectContaining({ status: 'RUNNING' }),
      }),
    );
    expect(proxy.regenerate).toHaveBeenCalled();
    expect(databases.importFromAppCompose).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: APP_ID, projectId: 'p1', serverId: 'srv-1' }),
    );
  });

  it('compose failure: task FAILED with the docker error, application ERROR, deployment FAILED', async () => {
    const { service, prisma } = makeService();
    mockExec({ composeFailure: 'bind: address already in use' });

    await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');
    await flushAsync();

    expect(prisma.agentTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          error: 'bind: address already in use',
        }),
      }),
    );
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: APP_ID }, data: { status: 'ERROR' } }),
    );
    expect(prisma.deployment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('attaches the app AND its DB sidecar to the project network after compose up (argv form)', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'p1',
      project: { serverId: 'srv-1' },
    });
    // Network already exists → inspect succeeds, no create needed.
    await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');
    await flushAsync();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'docker',
      ['network', 'inspect', 'kryptalis_proj_p1'],
      expect.anything(),
    );
    // WordPress template declares TWO containers (app + MariaDB sidecar) —
    // both must join the mesh so getServiceMesh() hostnames resolve.
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'docker',
      ['network', 'connect', 'kryptalis_proj_p1', `kryptalis-wordpress-${INSTANCE_ID}`],
      expect.anything(),
    );
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'docker',
      ['network', 'connect', 'kryptalis_proj_p1', `kryptalis-wordpress-db-${INSTANCE_ID}`],
      expect.anything(),
    );
    // inspect succeeded → no create.
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      'docker',
      ['network', 'create', 'kryptalis_proj_p1'],
      expect.anything(),
    );
  });

  it('creates the project network first when it does not exist yet', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'p1',
      project: { serverId: 'srv-1' },
    });
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        throw new Error('Error: No such network: kryptalis_proj_p1');
      }
      return { stdout: '', stderr: '' };
    });

    await service.install({ appSlug: 'uptime-kuma', projectId: 'p1' }, 'u1');
    await flushAsync();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'docker',
      ['network', 'create', 'kryptalis_proj_p1'],
      expect.anything(),
    );
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'docker',
      ['network', 'connect', 'kryptalis_proj_p1', `kryptalis-uptime-kuma-${INSTANCE_ID}`],
      expect.anything(),
    );
  });

  it('a failed network connect does not flip the install red (best-effort mesh attach)', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'p1',
      project: { serverId: 'srv-1' },
    });
    execFileAsyncMock.mockRejectedValue(new Error('already connected'));

    await service.install({ appSlug: 'ghost', projectId: 'p1' }, 'u1');
    await flushAsync();

    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: APP_ID }, data: { status: 'RUNNING' } }),
    );
  });

  it('compose failure → no network attach attempted', async () => {
    const { service } = makeService();
    mockExec({ composeFailure: 'pull failed' });

    await service.install({ appSlug: 'wordpress', projectId: 'p1' }, 'u1');
    await flushAsync();

    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('records a deployment row crediting the installing user', async () => {
    const { service, prisma } = makeService();
    await service.install({ appSlug: 'ghost', projectId: 'p1' }, 'u1');
    expect(prisma.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationId: APP_ID,
          triggeredById: 'u1',
          status: 'DEPLOYING',
        }),
      }),
    );
  });
});

// ── installCustom ───────────────────────────────────────────────────

describe('installCustom — arbitrary image deploys', () => {
  const base = {
    name: 'jellyfin',
    image: 'linuxserver/jellyfin:latest',
    serverId: 'srv-1',
    projectId: 'p1',
    containerPort: 8096,
  };

  it('rejects shell-meta / whitespace image references', async () => {
    const { service } = makeService();
    for (const image of ['evil; rm -rf /', 'img with space', '$(whoami)', '-leading-dash']) {
      await expect(service.installCustom({ ...base, image }, 'u1')).rejects.toThrow(
        'Invalid image reference',
      );
    }
  });

  it('rejects out-of-range containerPort', async () => {
    const { service } = makeService();
    await expect(
      service.installCustom({ ...base, containerPort: 0 }, 'u1'),
    ).rejects.toThrow('containerPort must be 1-65535');
    await expect(
      service.installCustom({ ...base, containerPort: 70000 }, 'u1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('duplicate app name in the project → 409 (no auto-suffix on the custom path)', async () => {
    const { service, prisma } = makeService();
    prisma.application.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(service.installCustom(base, 'u1')).rejects.toThrow(ConflictException);
  });

  it('no hostPort → allocates from the 18000 range, skipping busy ports by +10', async () => {
    const { service, prisma } = makeService();
    mockExec({ busyPorts: [18000, 18010] });
    const res = await service.installCustom(base, 'u1');
    expect(res.hostPort).toBe(18020);
    expect(prisma.application.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ port: 18020, customPort: false, containerPort: 8096 }),
      }),
    );
  });

  it('renders the custom compose: image, kryptalis-custom-<id12> name, port mapping, env vars', async () => {
    const { service, prisma } = makeService();
    await service.installCustom(
      { ...base, hostPort: 18500, envVars: { TZ: 'Europe/Paris' } },
      'u1',
    );
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { containerName: `kryptalis-custom-${INSTANCE_ID}` } }),
    );
    const compose = writtenFile('docker-compose.yml')!;
    expect(compose).toContain('image: linuxserver/jellyfin:latest');
    expect(compose).toContain(`container_name: kryptalis-custom-${INSTANCE_ID}`);
    expect(compose).toContain('"18500:8096"');
    expect(compose).toContain('TZ: "Europe/Paris"');
    expect(compose).not.toContain('__INSTANCE_ID__');
    expect(compose).not.toContain('__HOST_PORT__');
  });

  it('requires DEVELOPER project access like template installs', async () => {
    const { service } = makeService();
    mockAssert.mockRejectedValue(new ForbiddenException('nope'));
    await expect(service.installCustom(base, 'u1')).rejects.toThrow(ForbiddenException);
  });

  it('attaches the custom container to the project network after compose up', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'p1',
      project: { serverId: 'srv-1' },
    });
    await service.installCustom(base, 'u1');
    await flushAsync();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'docker',
      ['network', 'connect', 'kryptalis_proj_p1', `kryptalis-custom-${INSTANCE_ID}`],
      expect.anything(),
    );
  });
});
