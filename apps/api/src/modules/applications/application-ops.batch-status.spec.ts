import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the helpers module: execFileAsync (the single `docker ps`) is the unit
// under test; isAppLocal keeps its real loopback semantics.
vi.mock('./applications.helpers', () => ({
  execFileAsync: vi.fn(),
  isAppLocal: (server: { host: string } | null) =>
    !server || ['127.0.0.1', 'localhost', '::1'].includes(server.host),
  slugify: (s: string) => s.toLowerCase(),
  resolveAppDir: vi.fn(() => '/tmp/x'),
  containerName: (s: string) => `dockcontrol-${s}`,
  resolveContainerName: vi.fn(),
  remoteAppSlug: vi.fn(),
  dockerCompose: vi.fn(),
  findComposePath: vi.fn(),
  resolveAppServer: vi.fn(),
  assertAppOwnership: vi.fn(),
  projectNetworkName: vi.fn(),
  imageName: vi.fn(),
  removeCollidingContainers: vi.fn(),
  parseDockerfileExposed: vi.fn(),
  APPS_DIR: '/tmp/apps',
}));

import * as helpers from './applications.helpers';
import { ApplicationOpsService } from './application-ops.service';
import { ApplicationRepository } from './application.repository';

const execFileAsync = helpers.execFileAsync as unknown as ReturnType<typeof vi.fn>;

function makeService() {
  const prismaUpdate = vi.fn().mockResolvedValue({});
  const prisma = { application: { update: prismaUpdate } } as any;
  const apps = new ApplicationRepository(prisma);
  const svc = new ApplicationOpsService(
    prisma, {} as any, {} as any, {} as any, {} as any, {} as any, apps,
  );
  return { svc, prismaUpdate };
}

// docker ps output: "<name>\t<state>" lines.
const ps = (...rows: [string, string][]) => ({
  stdout: rows.map(([n, s]) => `${n}\t${s}`).join('\n'),
  stderr: '',
});

const LOCAL = { host: '127.0.0.1' };
const REMOTE = { host: '10.0.0.9' };

beforeEach(() => vi.clearAllMocks());

describe('syncStatusMany — batched single docker ps', () => {
  it('runs docker ps EXACTLY ONCE regardless of app count (the N+1 fix)', async () => {
    const { svc } = makeService();
    execFileAsync.mockResolvedValue(ps(['dockcontrol-a', 'running'], ['dockcontrol-b', 'running']));
    const apps = Array.from({ length: 25 }, (_, i) => ({
      id: `id${i}`, status: 'RUNNING', containerName: `dockcontrol-a`, server: LOCAL,
    }));
    await svc.syncStatusMany(apps);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(execFileAsync.mock.calls[0][0]).toBe('docker');
    expect(execFileAsync.mock.calls[0][1]).toContain('ps');
  });

  it('flips a STOPPED-in-DB app to RUNNING when its container is up', async () => {
    const { svc, prismaUpdate } = makeService();
    execFileAsync.mockResolvedValue(ps(['dockcontrol-x', 'running']));
    const [out] = await svc.syncStatusMany([
      { id: 'x', status: 'STOPPED', containerName: 'dockcontrol-x', server: LOCAL },
    ]);
    expect(out.status).toBe('RUNNING');
    expect(prismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'x' }, data: { status: 'RUNNING' } }),
    );
  });

  it('reports STOPPED when the container is absent from the snapshot', async () => {
    const { svc } = makeService();
    execFileAsync.mockResolvedValue(ps(['some-other', 'running']));
    const [out] = await svc.syncStatusMany([
      { id: 'x', status: 'RUNNING', containerName: 'dockcontrol-x', server: LOCAL },
    ]);
    expect(out.status).toBe('STOPPED');
  });

  it('nginx-PHP: RUNNING only when BOTH web and -fpm are up', async () => {
    const { svc } = makeService();
    // fpm exited → must be STOPPED even though the web container runs.
    execFileAsync.mockResolvedValue(ps(['dockcontrol-php', 'running'], ['dockcontrol-php-fpm', 'exited']));
    const [out] = await svc.syncStatusMany([
      { id: 'p', status: 'RUNNING', containerName: 'dockcontrol-php', framework: 'PHP_SITE', phpWebServer: 'nginx', server: LOCAL },
    ]);
    expect(out.status).toBe('STOPPED');
  });

  it('nginx-PHP: both up → RUNNING', async () => {
    const { svc } = makeService();
    execFileAsync.mockResolvedValue(ps(['dockcontrol-php', 'running'], ['dockcontrol-php-fpm', 'running']));
    const [out] = await svc.syncStatusMany([
      { id: 'p', status: 'STOPPED', containerName: 'dockcontrol-php', framework: 'PHP_SITE', phpWebServer: 'nginx', server: LOCAL },
    ]);
    expect(out.status).toBe('RUNNING');
  });

  it('leaves REMOTE apps untouched (agent heartbeat owns their status)', async () => {
    const { svc, prismaUpdate } = makeService();
    execFileAsync.mockResolvedValue(ps()); // nothing locally
    const [out] = await svc.syncStatusMany([
      { id: 'r', status: 'RUNNING', containerName: 'dockcontrol-r', server: REMOTE },
    ]);
    expect(out.status).toBe('RUNNING'); // unchanged
    expect(prismaUpdate).not.toHaveBeenCalled();
  });

  it('leaves DEPLOYING apps untouched', async () => {
    const { svc, prismaUpdate } = makeService();
    execFileAsync.mockResolvedValue(ps(['dockcontrol-d', 'exited']));
    const [out] = await svc.syncStatusMany([
      { id: 'd', status: 'DEPLOYING', containerName: 'dockcontrol-d', server: LOCAL },
    ]);
    expect(out.status).toBe('DEPLOYING');
    expect(prismaUpdate).not.toHaveBeenCalled();
  });

  it('does NOT write when status is unchanged (steady-state poll = 0 writes)', async () => {
    const { svc, prismaUpdate } = makeService();
    execFileAsync.mockResolvedValue(ps(['dockcontrol-a', 'running'], ['dockcontrol-b', 'running']));
    await svc.syncStatusMany([
      { id: 'a', status: 'RUNNING', containerName: 'dockcontrol-a', server: LOCAL },
      { id: 'b', status: 'RUNNING', containerName: 'dockcontrol-b', server: LOCAL },
    ]);
    expect(prismaUpdate).not.toHaveBeenCalled();
  });

  it('local app with NULL containerName falls back to dockcontrol-<slug> (no false STOPPED)', async () => {
    const { svc } = makeService();
    // Buildpack / autodetect deploy: container exists as dockcontrol-myapp but
    // app.containerName was never persisted. It must still read RUNNING.
    execFileAsync.mockResolvedValue(ps(['dockcontrol-myapp', 'running']));
    const [out] = await svc.syncStatusMany([
      { id: 'a', status: 'STOPPED', containerName: null, name: 'MyApp', server: LOCAL },
    ]);
    expect(out.status).toBe('RUNNING');
  });

  it('docker ps failure → returns apps unchanged, no writes', async () => {
    const { svc, prismaUpdate } = makeService();
    execFileAsync.mockRejectedValue(new Error('docker daemon down'));
    const out = await svc.syncStatusMany([
      { id: 'a', status: 'RUNNING', containerName: 'dockcontrol-a', server: LOCAL },
    ]);
    expect(out[0].status).toBe('RUNNING');
    expect(prismaUpdate).not.toHaveBeenCalled();
  });
});
