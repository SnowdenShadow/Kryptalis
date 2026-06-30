import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';

// ── helper mocks ─────────────────────────────────────────────────────────
// moveServer() leans on host-touching helpers (docker, DB resolution). Mock
// the helper module so the tests drive placement/transfer logic purely
// through the prisma + agent stubs, never real docker.
vi.mock('./applications.helpers', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    execFileAsync: vi.fn(),
    resolveAppServer: vi.fn(),
    isAppLocal: vi.fn(),
    dockerCompose: vi.fn(),
    resolveAppDir: vi.fn((slug: string) => `/tmp/apps/${slug}`),
  };
});

vi.mock('../deployment-target/deployment-target.service', () => ({
  isLocalHost: vi.fn(),
}));

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
  listAccessibleProjectIds: vi.fn(),
}));

import { slugify, ApplicationsService } from './applications.service';
import { ApplicationRepository } from './application.repository';
import { assertCloneHostAllowed } from '../git-providers/git-providers.service';
import {
  execFileAsync,
  resolveAppServer,
  isAppLocal,
} from './applications.helpers';
import { isLocalHost } from '../deployment-target/deployment-target.service';

const mockExecFile = vi.mocked(execFileAsync);
const mockResolveAppServer = vi.mocked(resolveAppServer);
const mockIsAppLocal = vi.mocked(isAppLocal);
const mockIsLocalHost = vi.mocked(isLocalHost);

describe('slugify', () => {
  it('lowercases and strips accents', () => {
    expect(slugify('Café Élégant')).toBe('cafe-elegant');
  });

  it('replaces special characters with dashes and trims them', () => {
    expect(slugify('  My App! (v2) ')).toBe('my-app-v2');
    expect(slugify('a__b..c')).toBe('a-b-c');
  });

  it('truncates to 48 characters', () => {
    expect(slugify('x'.repeat(100))).toBe('x'.repeat(48));
    expect(slugify('x'.repeat(100)).length).toBe(48);
  });

  it("falls back to 'app' for empty or symbol-only input", () => {
    expect(slugify('')).toBe('app');
    expect(slugify('!!!')).toBe('app');
  });
});

describe('assertCloneHostAllowed', () => {
  it('rejects a gitUrl whose host does not match the provider host', () => {
    expect(() =>
      assertCloneHostAllowed('GITHUB', 'https://evil.example.com/x.git'),
    ).toThrow(BadRequestException);
    expect(() =>
      assertCloneHostAllowed('GITHUB', 'https://gitlab.com/me/x.git'),
    ).toThrow(/does not match the selected provider/);
  });

  it('passes when the host matches the selected provider', () => {
    expect(() =>
      assertCloneHostAllowed('GITHUB', 'https://github.com/me/x.git'),
    ).not.toThrow();
    expect(() =>
      assertCloneHostAllowed('GITLAB', 'https://gitlab.com/me/x.git'),
    ).not.toThrow();
    expect(() =>
      assertCloneHostAllowed('BITBUCKET', 'https://bitbucket.org/me/x.git'),
    ).not.toThrow();
  });

  it('rejects non-https and private/loopback hosts', () => {
    expect(() =>
      assertCloneHostAllowed('GITHUB', 'http://github.com/me/x.git'),
    ).toThrow(/https/);
    // one-shot PAT path (no provider) still blocks SSRF targets
    expect(() =>
      assertCloneHostAllowed(null, 'https://127.0.0.1/x.git'),
    ).toThrow(BadRequestException);
    expect(() =>
      assertCloneHostAllowed(null, 'https://192.168.1.5/x.git'),
    ).toThrow(BadRequestException);
    expect(() =>
      assertCloneHostAllowed(null, 'https://localhost/x.git'),
    ).toThrow(BadRequestException);
  });

  it('allows an arbitrary public host on the one-shot PAT path (no provider)', () => {
    expect(() =>
      assertCloneHostAllowed(null, 'https://git.mycorp.com/me/x.git'),
    ).not.toThrow();
  });
});

// ── moveServer ────────────────────────────────────────────────────────────

function makePrisma() {
  return {
    application: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    server: { findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
  };
}

function makeService() {
  const prisma = makePrisma();
  const agent = {
    enqueueTask: vi.fn().mockResolvedValue({}),
    enqueueAndWait: vi.fn(),
    newLocalTransferId: vi.fn().mockReturnValue('xfer-1'),
    transferDir: vi.fn((id: string) => `/tmp/transfers/${id}`),
  };
  const proxy = { regenerate: vi.fn().mockResolvedValue(undefined) };
  const ops = {
    redeploy: vi.fn().mockResolvedValue({ id: 'dep-1' }),
    ensureNoInflightDeployment: vi.fn().mockResolvedValue(undefined),
  };
  // Only the deps moveServer touches are real stubs; the rest are inert.
  const service = new ApplicationsService(
    prisma as any,
    proxy as any,
    agent as any,
    {} as any, // domainAttach
    {} as any, // encryption
    {} as any, // databases
    {} as any, // deployService
    ops as any,
    {} as any, // network
    {} as any, // env
    { deprovisionForApplication: vi.fn().mockResolvedValue(undefined) } as any, // sftp
    new ApplicationRepository(prisma as any), // real repo over mock prisma
    { listBranches: vi.fn(), registerWebhook: vi.fn() } as any, // gitProviders
  );
  return { service, prisma, agent, proxy, ops };
}

/** A git app (gitUrl set) so the compose-guard never fires unless asked. */
function gitApp(over: any = {}) {
  return {
    id: 'a1',
    name: 'Web App',
    projectId: 'p1',
    gitUrl: 'https://github.com/me/x.git',
    dockerImage: null,
    dockerComposeFile: null,
    framework: 'DOCKER',
    containerName: null,
    hostPort: null,
    ...over,
  };
}

const ONLINE_TARGET = { id: 'new', name: 'new-node', host: '10.0.0.2', status: 'ONLINE' };

describe('moveServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' } as any);
  });

  it('rejects a compose app with null dockerComposeFile to a remote target BEFORE any teardown', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitUrl: null, dockerImage: null, framework: 'DOCKER_COMPOSE', dockerComposeFile: null }),
    );
    prisma.server.findUnique.mockResolvedValue(ONLINE_TARGET);
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false); // remote source
    mockIsLocalHost.mockReturnValue(false); // remote target

    await expect(service.moveServer('u1', 'a1', 'new')).rejects.toThrow(
      /no stored compose file/,
    );
    // No teardown, no placement flip, no redeploy happened.
    expect(agent.enqueueAndWait).not.toHaveBeenCalled();
    expect(ops.redeploy).not.toHaveBeenCalled();
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('refuses to move while a deployment is in-flight, BEFORE any teardown', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp());
    prisma.server.findUnique.mockResolvedValue(ONLINE_TARGET);
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false);
    mockIsLocalHost.mockReturnValue(false);
    ops.ensureNoInflightDeployment.mockRejectedValueOnce(
      Object.assign(new Error('A deployment is already running'), { status: 409 }),
    );

    await expect(service.moveServer('u1', 'a1', 'new')).rejects.toThrow(
      /deployment is already running/,
    );
    // Guard fired before teardown/placement/redeploy.
    expect(ops.ensureNoInflightDeployment).toHaveBeenCalledWith('a1');
    expect(agent.enqueueAndWait).not.toHaveBeenCalled();
    expect(ops.redeploy).not.toHaveBeenCalled();
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('allows a compose app WITH a stored compose file to a remote target', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitUrl: null, framework: 'DOCKER_COMPOSE', dockerComposeFile: 'services: {}' }),
    );
    prisma.server.findUnique.mockResolvedValue(ONLINE_TARGET);
    prisma.project.findUnique.mockResolvedValue({ serverId: 'other' });
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false);
    mockIsLocalHost.mockReturnValue(false);
    agent.enqueueAndWait.mockResolvedValue({ id: 't', status: 'COMPLETED' });

    await expect(service.moveServer('u1', 'a1', 'new')).resolves.toMatchObject({
      message: expect.stringContaining('new-node'),
    });
    expect(ops.redeploy).toHaveBeenCalledWith('u1', 'a1');
  });

  it('remote→remote with transferVolumes: discovers real volumes via VOLUME_LIST and ships EXPORT→IMPORT', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp());
    prisma.server.findUnique.mockResolvedValue(ONLINE_TARGET);
    prisma.project.findUnique.mockResolvedValue({ serverId: 'other' });
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false); // remote source
    mockIsLocalHost.mockReturnValue(false); // remote target

    agent.enqueueAndWait.mockImplementation(async (_srv: string, type: string) => {
      if (type === 'VOLUME_LIST') {
        return { id: 't-list', status: 'COMPLETED', result: { volumes: ['web-app-a1_data'] } };
      }
      if (type === 'VOLUME_EXPORT') return { id: 't-exp', status: 'COMPLETED' };
      if (type === 'VOLUME_IMPORT') return { id: 't-imp', status: 'COMPLETED' };
      if (type === 'REMOVE') return { id: 't-rm', status: 'COMPLETED' };
      return { status: 'COMPLETED' };
    });

    const res = await service.moveServer('u1', 'a1', 'new', true);

    const types = agent.enqueueAndWait.mock.calls.map((c: any[]) => c[1]);
    expect(types).toContain('VOLUME_LIST');
    expect(types).toContain('VOLUME_EXPORT');
    expect(types).toContain('VOLUME_IMPORT');
    // VOLUME_LIST queried the SOURCE with the app's prefix.
    const listCall = agent.enqueueAndWait.mock.calls.find((c: any[]) => c[1] === 'VOLUME_LIST')!;
    expect(listCall[0]).toBe('old');
    expect(listCall[2].prefixes[0]).toContain('web-app');
    // Export on source, import on target threading the export taskId.
    const exportCall = agent.enqueueAndWait.mock.calls.find((c: any[]) => c[1] === 'VOLUME_EXPORT')!;
    expect(exportCall[0]).toBe('old');
    const importCall = agent.enqueueAndWait.mock.calls.find((c: any[]) => c[1] === 'VOLUME_IMPORT')!;
    expect(importCall[0]).toBe('new');
    expect(importCall[2]).toMatchObject({ volumes: ['web-app-a1_data'], sourceTaskId: 't-exp' });
    // Volumes shipped before redeploy.
    expect(ops.redeploy).toHaveBeenCalledWith('u1', 'a1');
    expect(res.message).toContain('volumes were transferred');
  });

  it('remote→local with transferVolumes: EXPORT on source then imports locally before redeploy', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp());
    prisma.server.findUnique.mockResolvedValue({ id: 'new', name: 'local-node', host: '127.0.0.1', status: 'ONLINE' });
    prisma.project.findUnique.mockResolvedValue({ serverId: 'other' });
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false); // remote source
    mockIsLocalHost.mockReturnValue(true); // local target

    // local import shells out to docker (volume create + tar) — stub the
    // streaming importer so the test stays host-free.
    const localImport = vi
      .spyOn(service as any, 'importVolumesLocally')
      .mockResolvedValue(undefined);

    agent.enqueueAndWait.mockImplementation(async (_srv: string, type: string) => {
      if (type === 'VOLUME_LIST') {
        return { id: 't-list', status: 'COMPLETED', result: { volumes: ['web-app-a1_data'] } };
      }
      if (type === 'VOLUME_EXPORT') return { id: 't-exp', status: 'COMPLETED' };
      if (type === 'REMOVE') return { id: 't-rm', status: 'COMPLETED' };
      return { status: 'COMPLETED' };
    });

    const res = await service.moveServer('u1', 'a1', 'new', true);

    const types = agent.enqueueAndWait.mock.calls.map((c: any[]) => c[1]);
    expect(types).toContain('VOLUME_EXPORT');
    expect(types).not.toContain('VOLUME_IMPORT'); // local import, no agent task
    expect(localImport).toHaveBeenCalledWith('t-exp', ['web-app-a1_data']);
    expect(ops.redeploy).toHaveBeenCalledWith('u1', 'a1');
    expect(res.message).toContain('volumes were transferred');
  });

  it('awaits the remote-source REMOVE (purgeVolumes:false) BEFORE redeploy on the target', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp());
    prisma.server.findUnique.mockResolvedValue(ONLINE_TARGET);
    prisma.project.findUnique.mockResolvedValue({ serverId: 'other' });
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false);
    mockIsLocalHost.mockReturnValue(false);

    const order: string[] = [];
    agent.enqueueAndWait.mockImplementation(async (_srv: string, type: string) => {
      order.push(`task:${type}`);
      return { id: `t-${type}`, status: 'COMPLETED' };
    });
    ops.redeploy.mockImplementation(async () => {
      order.push('redeploy');
      return { id: 'dep-1' };
    });

    await service.moveServer('u1', 'a1', 'new'); // no volume transfer

    // REMOVE was an awaited agent task, purgeVolumes:false, BEFORE redeploy.
    const removeCall = agent.enqueueAndWait.mock.calls.find((c: any[]) => c[1] === 'REMOVE')!;
    expect(removeCall[0]).toBe('old');
    expect(removeCall[2]).toMatchObject({ purgeVolumes: false });
    expect(order).toEqual(['task:REMOVE', 'redeploy']);
  });

  it('reassigns a colliding host port on the target and persists it before redeploy', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp({ hostPort: 8080 }));
    prisma.server.findUnique.mockResolvedValue(ONLINE_TARGET);
    prisma.project.findUnique.mockResolvedValue({ serverId: 'other' });
    prisma.application.findMany.mockResolvedValue([{ hostPort: 8080 }]); // taken on target
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false);
    mockIsLocalHost.mockReturnValue(false);
    agent.enqueueAndWait.mockResolvedValue({ id: 't', status: 'COMPLETED' });

    const res = await service.moveServer('u1', 'a1', 'new');

    // First update is the port reassignment to a free, non-8080 port.
    const portUpdate = prisma.application.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.hostPort != null,
    )!;
    expect(portUpdate).toBeDefined();
    expect(portUpdate[0].data.hostPort).not.toBe(8080);
    expect(res.message).toContain('reassigned');
    expect(ops.redeploy).toHaveBeenCalled();
  });

  it('rolls back to the source (re-flip serverId + redeploy) when the target redeploy fails', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp());
    // target check resolves ONLINE_TARGET; the rollback path then looks up
    // the SOURCE server by id for the friendly name.
    prisma.server.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'old' ? { id: 'old', name: 'old-node', status: 'ONLINE' } : ONLINE_TARGET,
    );
    prisma.project.findUnique.mockResolvedValue({ serverId: 'other' });
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false);
    mockIsLocalHost.mockReturnValue(false);
    agent.enqueueAndWait.mockResolvedValue({ id: 't', status: 'COMPLETED' });

    // First redeploy (on target) fails; recovery redeploy (on source) succeeds.
    ops.redeploy
      .mockRejectedValueOnce(new Error('target deploy boom'))
      .mockResolvedValueOnce({ id: 'dep-src' });

    await expect(service.moveServer('u1', 'a1', 'new')).rejects.toThrow(
      /restored on old-node/,
    );
    expect(ops.redeploy).toHaveBeenCalledTimes(2);
    // Placement was flipped back to the source.
    const flipBack = prisma.application.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.serverId === 'old',
    );
    expect(flipBack).toBeDefined();
  });

  it('marks ERROR with a data-location message when target deploy AND recovery both fail', async () => {
    const { service, prisma, agent, ops } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp());
    prisma.server.findUnique.mockResolvedValue(ONLINE_TARGET);
    prisma.project.findUnique.mockResolvedValue({ serverId: 'other' });
    mockResolveAppServer.mockResolvedValue({ id: 'old', host: '10.0.0.1', name: 'old-node' } as any);
    mockIsAppLocal.mockReturnValue(false);
    mockIsLocalHost.mockReturnValue(false);
    agent.enqueueAndWait.mockResolvedValue({ id: 't', status: 'COMPLETED' });

    ops.redeploy.mockRejectedValue(new Error('everything is down'));

    await expect(service.moveServer('u1', 'a1', 'new')).rejects.toThrow(
      /could not be restored automatically/,
    );
    const errorUpdate = prisma.application.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'ERROR',
    );
    expect(errorUpdate).toBeDefined();
  });

  it('rejects an offline target server', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp());
    prisma.server.findUnique.mockResolvedValue({ ...ONLINE_TARGET, status: 'OFFLINE' });

    await expect(service.moveServer('u1', 'a1', 'new')).rejects.toThrow(/ONLINE/);
  });

  it('rejects moving to the server the app already lives on', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp());
    prisma.server.findUnique.mockResolvedValue(ONLINE_TARGET);
    mockResolveAppServer.mockResolvedValue({ id: 'new', host: '10.0.0.2', name: 'new-node' } as any);

    await expect(service.moveServer('u1', 'a1', 'new')).rejects.toThrow(
      /already on this server/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// attach / detach database (env injection)
// ═══════════════════════════════════════════════════════════════════

describe('attachDatabase / detachDatabase', () => {
  function makeServiceWithDb() {
    const prisma = makePrisma();
    const ops = {
    redeploy: vi.fn().mockResolvedValue({ id: 'dep-1' }),
    ensureNoInflightDeployment: vi.fn().mockResolvedValue(undefined),
  };
    const databases = {
      linkToApplication: vi.fn().mockResolvedValue({
        envVars: { DB_HOST: 'dockcontrol-db-shopdb', DB_PORT: '3306', DB_USER: 'shop', DB_PASSWORD: 'pw', DATABASE_URL: 'mysql://shop:pw@dockcontrol-db-shopdb:3306/shopdb' },
        dbName: 'shopdb',
      }),
      unlinkFromApplication: vi.fn().mockResolvedValue({ dbName: 'shopdb' }),
      findAll: vi.fn().mockResolvedValue([]),
    };
    // Real env (de)serialization shape: passthrough so we can read what gets stored.
    const env = {
      decryptEnvVars: vi.fn((raw: any) => (raw && raw.__plain) || {}),
      encryptEnvVars: vi.fn((v: any) => ({ __plain: v })),
    };
    const service = new ApplicationsService(
      prisma as any,
      { regenerate: vi.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      databases as any,
      {} as any,
      ops as any,
      {} as any,
      env as any,
      { deprovisionForApplication: vi.fn().mockResolvedValue(undefined) } as any, // sftp
      new ApplicationRepository(prisma as any), // real repo over mock prisma
      { listBranches: vi.fn(), registerWebhook: vi.fn() } as any, // gitProviders
    );
    return { service, prisma, ops, databases, env };
  }

  it('attach: links the DB, merges DB_* into envVars, and redeploys', async () => {
    const { service, prisma, ops, databases, env } = makeServiceWithDb();
    prisma.application.findUnique.mockResolvedValue({ id: 'a1', projectId: 'p1', envVars: { __plain: { EXISTING: 'keep' } } });

    const res = await service.attachDatabase('u1', 'a1', 'db1');

    expect(databases.linkToApplication).toHaveBeenCalledWith('u1', 'db1', 'a1');
    // Merged: user key preserved + DB_* added.
    const stored = (prisma.application.update.mock.calls.at(-1) as any)[0].data.envVars.__plain;
    expect(stored.EXISTING).toBe('keep');
    expect(stored.DB_HOST).toBe('dockcontrol-db-shopdb');
    expect(stored.DATABASE_URL).toContain('mysql://');
    // Redeploy so the new env reaches the container.
    expect(ops.redeploy).toHaveBeenCalledWith('u1', 'a1');
    expect(res.envKeys).toContain('DB_HOST');
    void env;
  });

  it('detach: unlinks the DB, strips ONLY the DB_* keys, and redeploys', async () => {
    const { service, prisma, ops, databases } = makeServiceWithDb();
    prisma.application.findUnique.mockResolvedValue({
      id: 'a1', projectId: 'p1',
      envVars: { __plain: { EXISTING: 'keep', DB_HOST: 'x', DB_PORT: '3306', DATABASE_URL: 'mysql://...' } },
    });

    await service.detachDatabase('u1', 'a1', 'db1');

    expect(databases.unlinkFromApplication).toHaveBeenCalledWith('u1', 'db1');
    const stored = (prisma.application.update.mock.calls.at(-1) as any)[0].data.envVars.__plain;
    expect(stored.EXISTING).toBe('keep'); // user key survives
    expect(stored.DB_HOST).toBeUndefined(); // injected keys stripped
    expect(stored.DATABASE_URL).toBeUndefined();
    expect(ops.redeploy).toHaveBeenCalledWith('u1', 'a1');
  });
});

// ── create(): host-escape compose screen (C-1) ─────────────────────────────
// A project DEVELOPER must not be able to deploy a container that escapes to
// host root. create() must reject a user compose carrying privileged/cap_add/
// host-namespace/host bind-mount BEFORE any DB write or deploy dispatch.
describe('create() compose host-escape screen', () => {
  beforeEach(() => vi.clearAllMocks());

  const DOCKER_SOCK_COMPOSE =
    'services:\n  evil:\n    image: alpine\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n';
  const PRIVILEGED_COMPOSE = 'services:\n  evil:\n    image: alpine\n    privileged: true\n';

  it('rejects composeContent that mounts the docker socket', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.create('u1', { name: 'x', projectId: 'p1', composeContent: DOCKER_SOCK_COMPOSE } as any),
    ).rejects.toThrow(BadRequestException);
    // Fail-closed BEFORE any persistence.
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('rejects a composeOverride with privileged: true (git first-deploy path)', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', {
        name: 'x',
        projectId: 'p1',
        gitUrl: 'https://github.com/me/x.git',
        composeOverride: PRIVILEGED_COMPOSE,
      } as any),
    ).rejects.toThrow(/host-escape|privileged/i);
  });

  it('does NOT block the screen on the internal host-access-consent bypass', async () => {
    const { service } = makeService();
    // The project-transfer apply path passes allowHostAccessCompose after its
    // own explicit-consent gate. The compose screen must let it through — any
    // later throw (DB stubs are inert here) is NOT the compose-safety 400.
    let err: any;
    try {
      await service.create(
        'u1',
        { name: 'x', projectId: 'p1', composeContent: DOCKER_SOCK_COMPOSE } as any,
        { allowHostAccessCompose: true },
      );
    } catch (e) {
      err = e;
    }
    // If it threw, it must NOT be the host-escape rejection.
    if (err) expect(String(err.message)).not.toMatch(/host-escape primitives/i);
  });
});

// ── gitUrl SSRF / file:// validation (H-1) ─────────────────────────────────
// A project DEVELOPER must not be able to point gitUrl at an internal address
// (SSRF) or a local path (file:// → read a repo off the API host). The screen
// must run on the public-repo create path AND on update() — both reach
// `git clone <gitUrl>`.
describe('gitUrl validation on create()/update()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create() rejects an SSRF gitUrl on the anonymous public-repo path (no provider/token)', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', {
        name: 'x', projectId: 'p1', gitUrl: 'https://169.254.169.254/latest/meta-data/',
      } as any),
    ).rejects.toThrow(/not allowed|host/i);
  });

  it('create() rejects a non-https scheme (file://) before any clone', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { name: 'x', projectId: 'p1', gitUrl: 'file:///etc/passwd' } as any),
    ).rejects.toThrow(/https/i);
  });

  it('create() allows a normal public https repo', async () => {
    const { service } = makeService();
    let err: any;
    try {
      await service.create('u1', {
        name: 'x', projectId: 'p1', gitUrl: 'https://github.com/me/public.git',
      } as any);
    } catch (e) { err = e; }
    // It may fail later on inert DB stubs, but NOT on the gitUrl screen.
    if (err) {
      expect(String(err.message)).not.toMatch(/https|host is not allowed/i);
    }
  });

  it('update() rejects changing gitUrl to an internal address', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitProviderId: null, gitUrl: 'https://github.com/me/x.git' }),
    );
    await expect(
      service.update('u1', 'a1', { gitUrl: 'https://127.0.0.1/x.git' } as any),
    ).rejects.toThrow(/not allowed|host/i);
    // Rejected before the DB write.
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('update() rejects a file:// gitUrl', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue(gitApp({ gitProviderId: null }));
    await expect(
      service.update('u1', 'a1', { gitUrl: 'file:///srv/secret-repo' } as any),
    ).rejects.toThrow(/https/i);
    expect(prisma.application.update).not.toHaveBeenCalled();
  });
});

// ── branch picker + 1-click webhook install ──────────────────────────────

function makeWebhookService() {
  const prisma = makePrisma();
  const encryption = {
    encrypt: vi.fn((s: string) => `enc:${s}`),
    decrypt: vi.fn((s: string) => (s.startsWith('enc:') ? s.slice(4) : s)),
  };
  const gitProviders = {
    listBranches: vi.fn().mockResolvedValue([{ name: 'main', isDefault: true }]),
    registerWebhook: vi.fn().mockResolvedValue({ created: true, alreadyExists: false }),
  };
  const service = new ApplicationsService(
    prisma as any,
    { regenerate: vi.fn() } as any,
    {} as any,
    {} as any,
    encryption as any,
    {} as any,
    {} as any,
    { redeploy: vi.fn() } as any,
    {} as any,
    {} as any,
    { deprovisionForApplication: vi.fn() } as any,
    new ApplicationRepository(prisma as any),
    gitProviders as any,
  );
  return { service, prisma, encryption, gitProviders };
}

describe('getBranches', () => {
  it('requires a linked provider', async () => {
    const { service, prisma } = makeWebhookService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitProviderId: null }),
    );
    await expect(service.getBranches('u1', 'a1')).rejects.toThrow(
      /Link a git provider/i,
    );
  });

  it('lists branches via the provider and returns the current branch', async () => {
    const { service, prisma, gitProviders } = makeWebhookService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitProviderId: 'gp1', gitBranch: 'main', gitUrl: 'https://github.com/me/x.git' }),
    );
    const res = await service.getBranches('u1', 'a1');
    expect(gitProviders.listBranches).toHaveBeenCalledWith('gp1', 'u1', 'me/x');
    expect(res).toEqual({
      current: 'main',
      branches: [{ name: 'main', isDefault: true }],
    });
  });
});

describe('installWebhook', () => {
  const PUBLIC = 'https://kryptalis.example.com';

  beforeEach(() => {
    process.env.PUBLIC_API_URL = PUBLIC;
  });

  it('refuses when no provider is linked', async () => {
    const { service, prisma } = makeWebhookService();
    prisma.application.findUnique.mockResolvedValue(gitApp({ gitProviderId: null }));
    await expect(service.installWebhook('u1', 'a1')).rejects.toThrow(
      /linked to a git provider/i,
    );
  });

  it('refuses when PUBLIC_API_URL is unset', async () => {
    delete process.env.PUBLIC_API_URL;
    delete process.env.API_URL;
    const { service, prisma } = makeWebhookService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitProviderId: 'gp1', webhookSecret: 'enc:s' }),
    );
    await expect(service.installWebhook('u1', 'a1')).rejects.toThrow(
      /PUBLIC_API_URL/i,
    );
  });

  it('refuses a private/localhost PUBLIC_API_URL the provider cannot reach', async () => {
    process.env.PUBLIC_API_URL = 'http://localhost:4000';
    const { service, prisma } = makeWebhookService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitProviderId: 'gp1', webhookSecret: 'enc:s' }),
    );
    await expect(service.installWebhook('u1', 'a1')).rejects.toThrow(
      /private\/localhost|cannot reach/i,
    );
  });

  it('registers the hook with the existing secret and turns on autoDeploy', async () => {
    const { service, prisma, gitProviders, encryption } = makeWebhookService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitProviderId: 'gp1', webhookSecret: 'enc:storedsecret', gitUrl: 'https://github.com/me/x.git' }),
    );
    const res = await service.installWebhook('u1', 'a1');
    expect(encryption.decrypt).toHaveBeenCalledWith('enc:storedsecret');
    expect(gitProviders.registerWebhook).toHaveBeenCalledWith(
      'gp1', 'u1', 'me/x',
      `${PUBLIC}/api/webhooks/applications/a1`,
      'storedsecret',
    );
    // autoDeploy flipped on
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a1' }, data: { autoDeploy: true } }),
    );
    expect(res).toMatchObject({ installed: true, autoDeploy: true });
  });

  it('generates + persists a secret on first install (none stored yet)', async () => {
    const { service, prisma, gitProviders, encryption } = makeWebhookService();
    prisma.application.findUnique.mockResolvedValue(
      gitApp({ gitProviderId: 'gp1', webhookSecret: null, gitUrl: 'https://github.com/me/x.git' }),
    );
    await service.installWebhook('u1', 'a1');
    // A fresh secret was encrypted + written before registering the hook.
    expect(encryption.encrypt).toHaveBeenCalled();
    const wroteSecret = prisma.application.update.mock.calls.some(
      ([arg]: any[]) => arg.data?.webhookSecret,
    );
    expect(wroteSecret).toBe(true);
    expect(gitProviders.registerWebhook).toHaveBeenCalled();
  });
});
