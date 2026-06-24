import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the helpers module: execCommand resolves the container name through it,
// and we want to prove it prefers the STORED app.containerName over the
// suffix-appending heuristic resolveContainerName().
vi.mock('./applications.helpers', () => ({
  execFileAsync: vi.fn(),
  assertAppOwnership: vi.fn(),
  resolveAppServer: vi.fn(),
  resolveContainerName: vi.fn(() => 'dockcontrol-teste-cmqsnsex0000'), // the WRONG (heuristic) name
  isAppLocal: vi.fn(() => true),
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
  // unused-but-imported helpers referenced elsewhere in the service:
  resolveAppDir: vi.fn(),
  containerName: (slug: string) => `dockcontrol-${slug}`,
  projectNetworkName: vi.fn(),
  remoteAppSlug: vi.fn(),
  imageName: vi.fn(),
  dockerCompose: vi.fn(),
  removeCollidingContainers: vi.fn(),
  parseDockerfileExposed: vi.fn(),
}));

import * as helpers from './applications.helpers';
import { ApplicationOpsService } from './application-ops.service';

const execFileAsync = helpers.execFileAsync as unknown as ReturnType<typeof vi.fn>;
const assertAppOwnership = helpers.assertAppOwnership as unknown as ReturnType<typeof vi.fn>;
const resolveAppServer = helpers.resolveAppServer as unknown as ReturnType<typeof vi.fn>;

function makeService() {
  return new ApplicationOpsService(
    {} as any, // prisma
    {} as any, // agent
    {} as any, // encryption
    {} as any, // deploymentTarget
    {} as any, // deploy
    {} as any, // env
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAppServer.mockResolvedValue({ id: 'srv1', host: 'localhost' });
  // Local docker exec succeeds with some output.
  execFileAsync.mockResolvedValue({ stdout: 'hello\n', stderr: '' });
});

describe('ApplicationOpsService.execCommand — container name resolution', () => {
  it('uses the STORED app.containerName (no suffix) — not the heuristic name', async () => {
    // The bug: a PHP site (and image/dockerfile apps) persist containerName
    // WITHOUT the -<id12> suffix, but resolveContainerName appends it because
    // the per-instance dir exists → "No such container".
    assertAppOwnership.mockResolvedValue({
      id: 'cmqsnsex0000xxxx', name: 'Teste', projectId: 'p1',
      containerName: 'dockcontrol-teste', // the REAL name the deploy created
    });
    const svc = makeService();

    const res = await svc.execCommand('u1', 'cmqsnsex0000xxxx', 'ls');

    expect(res.exitCode).toBe(0);
    // docker exec must target the stored name, not dockcontrol-teste-cmqsnsex0000.
    const dockerExec = execFileAsync.mock.calls.find(
      (c: any[]) => c[0] === 'docker' && Array.isArray(c[1]) && c[1][0] === 'exec',
    );
    expect(dockerExec).toBeTruthy();
    expect(dockerExec![1]).toContain('dockcontrol-teste');
    expect(dockerExec![1]).not.toContain('dockcontrol-teste-cmqsnsex0000');
  });

  it('falls back to the heuristic name for a legacy row with no stored containerName', async () => {
    assertAppOwnership.mockResolvedValue({
      id: 'cmqsnsex0000xxxx', name: 'Teste', projectId: 'p1',
      containerName: null, // legacy: never persisted
    });
    const svc = makeService();

    await svc.execCommand('u1', 'cmqsnsex0000xxxx', 'ls');

    const dockerExec = execFileAsync.mock.calls.find(
      (c: any[]) => c[0] === 'docker' && Array.isArray(c[1]) && c[1][0] === 'exec',
    );
    expect(dockerExec![1]).toContain('dockcontrol-teste-cmqsnsex0000');
  });
});
