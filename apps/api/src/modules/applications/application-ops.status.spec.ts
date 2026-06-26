import { describe, it, expect, vi, beforeEach } from 'vitest';

// syncStatus runs `docker compose ps --format json` over the WHOLE stack and
// decides RUNNING/STOPPED. For a single-service stack (apache, every non-PHP
// app) ANY running container = RUNNING. For an nginx-mode PHP site there are
// TWO services (nginx web + php-fpm); the status must require BOTH running, or
// a dead fpm behind a live nginx would falsely report RUNNING while every
// request 502s. These tests pin that conjunction-vs-union behaviour.

vi.mock('./applications.helpers', () => ({
  execFileAsync: vi.fn(),
  assertAppOwnership: vi.fn(),
  resolveAppServer: vi.fn(),
  resolveContainerName: vi.fn(),
  isAppLocal: vi.fn(() => true),
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
  resolveAppDir: vi.fn(() => '/tmp/appdir'),
  containerName: (slug: string) => `dockcontrol-${slug}`,
  projectNetworkName: vi.fn(),
  remoteAppSlug: vi.fn(),
  imageName: vi.fn(),
  dockerCompose: vi.fn(),
  removeCollidingContainers: vi.fn(),
  parseDockerfileExposed: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<any>('fs');
  return { ...actual, existsSync: vi.fn(() => true), default: { ...actual, existsSync: vi.fn(() => true) } };
});

import * as helpers from './applications.helpers';
import { ApplicationOpsService } from './application-ops.service';

const dockerCompose = helpers.dockerCompose as unknown as ReturnType<typeof vi.fn>;

function makeService(prismaUpdate = vi.fn()) {
  const prisma = { application: { update: prismaUpdate } } as any;
  return new ApplicationOpsService(
    prisma, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
}

// One JSON line per container, mimicking `docker compose ps --format json`.
const psLines = (...states: string[]) =>
  states.map((s, i) => JSON.stringify({ Name: `svc${i}`, State: s })).join('\n');

beforeEach(() => vi.clearAllMocks());

describe('syncStatus — nginx PHP sites require BOTH containers running', () => {
  it('nginx mode: nginx up but php-fpm exited → STOPPED (not falsely RUNNING)', async () => {
    dockerCompose.mockResolvedValue({ stdout: psLines('running', 'exited'), stderr: '' });
    const update = vi.fn().mockResolvedValue({});
    const svc = makeService(update);
    const res = await svc.syncStatus({
      id: 'a1', name: 'Shop', status: 'RUNNING', framework: 'PHP_SITE', phpWebServer: 'nginx',
    });
    expect(res.status).toBe('STOPPED');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STOPPED' } }));
  });

  it('nginx mode: BOTH running → RUNNING', async () => {
    dockerCompose.mockResolvedValue({ stdout: psLines('running', 'running'), stderr: '' });
    const svc = makeService(vi.fn().mockResolvedValue({}));
    const res = await svc.syncStatus({
      id: 'a1', name: 'Shop', status: 'STOPPED', framework: 'PHP_SITE', phpWebServer: 'nginx',
    });
    expect(res.status).toBe('RUNNING');
  });

  it('apache mode (single service): one running container → RUNNING (union is correct)', async () => {
    dockerCompose.mockResolvedValue({ stdout: psLines('running'), stderr: '' });
    const svc = makeService(vi.fn().mockResolvedValue({}));
    const res = await svc.syncStatus({
      id: 'a1', name: 'Shop', status: 'STOPPED', framework: 'PHP_SITE', phpWebServer: 'apache',
    });
    expect(res.status).toBe('RUNNING');
  });
});
