import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ── module mocks ─────────────────────────────────────────────────────
// Pure service-level tests (same approach as projects.service.spec):
// every constructor dep is a plain object of vi.fn()s, and the two
// process-touching modules (child_process, fs) are replaced entirely —
// no real docker, no real disk.

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

// In-memory fs: writeFileSync feeds a Map so tests can parse the exact
// compose/Dockerfile the service generated; existsSync/readFileSync read
// back from it. Implementations are (re)installed in beforeEach via
// installFsDefaults() so a test that overrides one fn can't leak.
vi.mock('fs', () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const fsMock: any = {
    __files: files,
    __dirs: dirs,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    renameSync: vi.fn(),
    promises: {},
  };
  return { ...fsMock, default: fsMock };
});

// detectStack reads the cloned repo with require('fs') — mock the module
// so the auto-Dockerfile branch is deterministic.
vi.mock('./dockerfile-templates', () => ({
  detectStack: vi.fn(),
  FRAMEWORK_DOCKERFILES: { NEXTJS: 'FROM node:20-alpine\nEXPOSE 3000\n' },
  FRAMEWORK_INTERNAL_PORT: { NEXTJS: 3000 },
}));

import * as fs from 'fs';
import { execFile } from 'child_process';
import { detectStack } from './dockerfile-templates';
import { ApplicationDeployService } from './application-deploy.service';
import { resolveAppDir } from './applications.helpers';

const vfs = fs as unknown as {
  __files: Map<string, string>;
  __dirs: Set<string>;
  existsSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  readdirSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  rmSync: ReturnType<typeof vi.fn>;
  renameSync: ReturnType<typeof vi.fn>;
};

const norm = (p: unknown) => String(p).replace(/\\/g, '/');

function installFsDefaults() {
  vfs.__files.clear();
  vfs.__dirs.clear();
  vfs.existsSync.mockImplementation((p: any) => vfs.__files.has(norm(p)) || vfs.__dirs.has(norm(p)));
  vfs.writeFileSync.mockImplementation((p: any, c: any) => {
    vfs.__files.set(norm(p), String(c));
  });
  vfs.readFileSync.mockImplementation((p: any) => {
    const v = vfs.__files.get(norm(p));
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  });
  vfs.readdirSync.mockImplementation((p: any) => {
    const pre = norm(p).replace(/\/$/, '') + '/';
    const names = new Set<string>();
    for (const k of vfs.__files.keys()) {
      if (k.startsWith(pre)) names.add(k.slice(pre.length).split('/')[0]);
    }
    return [...names];
  });
  vfs.mkdirSync.mockImplementation((p: any) => {
    vfs.__dirs.add(norm(p));
  });
  vfs.rmSync.mockImplementation((p: any) => {
    const pre = norm(p);
    for (const k of [...vfs.__files.keys()]) if (k === pre || k.startsWith(pre + '/')) vfs.__files.delete(k);
    for (const k of [...vfs.__dirs]) if (k === pre || k.startsWith(pre + '/')) vfs.__dirs.delete(k);
  });
  vfs.renameSync.mockImplementation((from: any, to: any) => {
    const src = norm(from);
    const dst = norm(to);
    for (const k of [...vfs.__files.keys()]) {
      if (k === src || k.startsWith(src + '/')) {
        vfs.__files.set(dst + k.slice(src.length), vfs.__files.get(k)!);
        vfs.__files.delete(k);
      }
    }
    for (const k of [...vfs.__dirs]) {
      if (k === src || k.startsWith(src + '/')) {
        vfs.__dirs.add(dst + k.slice(src.length));
        vfs.__dirs.delete(k);
      }
    }
  });
}

// ── execFile driver ──────────────────────────────────────────────────
// The service goes through promisify(execFile); our mock invokes the
// trailing node-style callback. Tests push handlers that match on
// (cmd, argv) and return { stdout, stderr } or an Error; anything
// unmatched succeeds with empty output, and `docker compose … ps`
// reports a running container by default so healthchecks pass.

const mockExecFile = vi.mocked(execFile) as any;
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
    let stdout = res?.stdout ?? '';
    if (!res && cmd === 'docker' && args[0] === 'compose' && args.includes('ps')) {
      stdout = '{"State":"running"}';
    }
    process.nextTick(() => cb(null, { stdout, stderr: res?.stderr ?? '' }));
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

// ── service factory ──────────────────────────────────────────────────

function makePrisma() {
  return {
    deployment: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ triggeredById: 'u1' }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    application: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({
        projectId: 'proj1',
        project: { serverId: 'srv1', server: { id: 'srv1', host: 'localhost' } },
        domains: [],
      }),
    },
  };
}

function makeService() {
  const prisma = makePrisma();
  const proxy = { regenerate: vi.fn().mockResolvedValue(undefined) };
  const agent = { enqueueAndWait: vi.fn() };
  const notifications = { sendDeploymentResult: vi.fn().mockResolvedValue(undefined) };
  const databases = { importFromAppCompose: vi.fn().mockResolvedValue({ created: 0, updated: 0, skipped: 0 }) };
  const env = {
    serializeEnv: vi.fn((e: Record<string, string>) =>
      Object.entries(e).map(([k, v]) => `${k}=${v}`).join('\n'),
    ),
    loadRepoEnvFiles: vi.fn().mockReturnValue({}),
    encryptEnvVars: vi.fn((e: any) => ({ __k: 1, v: JSON.stringify(e) })),
  };
  const service = new ApplicationDeployService(
    prisma as any,
    proxy as any,
    agent as any,
    notifications as any,
    databases as any,
    env as any,
  );
  return { service, prisma, proxy, agent, notifications, databases, env };
}

const APP_ID = 'app1234567890abcdef';
const APP_NAME = 'My App!'; // slugifies to "my-app"
const SLUG = 'my-app';
const appDir = () => resolveAppDir(SLUG, APP_ID);
const composeFileOf = (dir: string) => vfs.__files.get(norm(path.join(dir, 'docker-compose.yml')));
const readComposeDoc = () => yaml.load(composeFileOf(appDir())!) as any;

const deploymentStatuses = (prisma: ReturnType<typeof makePrisma>) =>
  prisma.deployment.update.mock.calls.map((c) => c[0]?.data?.status).filter(Boolean);
const lastAppStatus = (prisma: ReturnType<typeof makePrisma>) =>
  prisma.application.update.mock.calls.map((c) => c[0]?.data?.status).filter(Boolean).pop();
const lastDeploymentData = (prisma: ReturnType<typeof makePrisma>) =>
  prisma.deployment.update.mock.calls[prisma.deployment.update.mock.calls.length - 1][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  installFsDefaults();
  installExecDefaults();
  vi.mocked(detectStack).mockReturnValue(null);
  // Blue-green canary: skip the 10s hold (real wall-clock sleeps would
  // blow up suite duration) and report the canary container as running so
  // the swap proceeds. Failure-path tests override the inspect handler.
  process.env.DOCKCONTROL_CANARY_HOLD_MS = '0';
  handlers.push((cmd, args) =>
    cmd === 'docker' && args[0] === 'inspect' && args.includes('{{.State.Running}} {{.State.ExitCode}}')
      ? { stdout: 'true 0' }
      : undefined,
  );
});

afterEach(() => {
  delete process.env.DOCKCONTROL_CANARY_HOLD_MS;
});

// ═══════════════════════════════════════════════════════════════════
// runDockerImageDeploy
// ═══════════════════════════════════════════════════════════════════

describe('runDockerImageDeploy', () => {
  it('writes a compose with sanitized container name, project + shared networks, then pull + up -d', async () => {
    const { service, prisma } = makeService();

    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, 'nginx:1.27', {});

    const doc = readComposeDoc();
    expect(doc.services.app.image).toBe('nginx:1.27');
    expect(doc.services.app.container_name).toBe('dockcontrol-my-app');
    expect(doc.services.app.networks).toEqual(['dockcontrol_project', 'dockcontrol_apps']);
    expect(doc.networks.dockcontrol_project).toEqual({ external: true, name: 'dockcontrol_proj_proj1' });
    expect(doc.networks.dockcontrol_apps).toEqual({ external: true, name: 'dockcontrol-apps' });

    expect(findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose pull')).toBeTruthy();
    expect(
      findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d --remove-orphans'),
    ).toBeTruthy();
    expect(lastAppStatus(prisma)).toBe('RUNNING');
    expect(deploymentStatuses(prisma)).toContain('RUNNING');
  });

  it('publishes hostPort:containerPort only when a host port was chosen', async () => {
    const { service } = makeService();
    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, 'nginx', { hostPort: 8080, port: 80 });
    expect(readComposeDoc().services.app.ports).toEqual(['8080:80']);
  });

  it('omits the ports block entirely without a hostPort (Caddy-over-bridge path)', async () => {
    const { service } = makeService();
    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, 'nginx', { port: 3000 });
    expect(readComposeDoc().services.app.ports).toBeUndefined();
  });

  it('inlines envVars into the compose environment block', async () => {
    const { service } = makeService();
    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, 'nginx', {
      envVars: { FOO: 'bar', SECRET: 'x=y' },
    });
    expect(readComposeDoc().services.app.environment).toEqual({ FOO: 'bar', SECRET: 'x=y' });
  });

  it('detects the exposed port via docker inspect when the user picked none', async () => {
    const { service, prisma } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'inspect' ? { stdout: '{"8080/tcp":{}}' } : undefined,
    );

    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, 'nginx', {});

    const insp = findExec((c) => c.cmd === 'docker' && c.args[0] === 'inspect');
    expect(insp!.args).toEqual([
      'inspect', '--format', '{{json .Config.ExposedPorts}}', 'dockcontrol-my-app',
    ]);
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ containerPort: 8080, port: 8080 }),
      }),
    );
  });

  it('a malicious image string cannot inject sibling YAML keys (yaml.dump keeps it data)', async () => {
    const { service } = makeService();
    const evil = 'nginx:latest\n    privileged: true';
    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, evil, {});
    const doc = readComposeDoc();
    expect(doc.services.app.image).toBe(evil);
    expect(doc.services.app.privileged).toBeUndefined();
  });

  it('redeploy: downs the previous stack WITHOUT -v so user volumes survive', async () => {
    const { service } = makeService();
    vfs.__dirs.add(norm(appDir())); // simulate a previous deploy

    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, 'nginx', {});

    const down = findExec((c) => c.cmd === 'docker' && c.args[0] === 'compose' && c.args[1] === 'down');
    expect(down).toBeTruthy();
    expect(down!.args).toEqual(['compose', 'down', '--remove-orphans']);
    expect(down!.args).not.toContain('-v');
  });

  it('compose up failure → app ERROR, deployment FAILED, failure notification', async () => {
    const { service, prisma, notifications } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args[1] === 'up'
        ? new Error('compose up exploded')
        : undefined,
    );

    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, 'nginx', {});

    expect(lastAppStatus(prisma)).toBe('ERROR');
    const data = lastDeploymentData(prisma);
    expect(data.status).toBe('FAILED');
    expect(data.deployLogs).toContain('compose up exploded');
    await vi.waitFor(() =>
      expect(notifications.sendDeploymentResult).toHaveBeenCalledWith(
        'u1', APP_NAME, 'failed', expect.stringContaining('compose up exploded'),
      ),
    );
  });

  it('scrubs Authorization tokens out of persisted build logs', async () => {
    const { service, prisma } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args[1] === 'pull'
        ? new Error('fatal: Authorization: Basic SECRETBLOB123 rejected')
        : undefined,
    );

    await service.runDockerImageDeploy('dep1', APP_ID, APP_NAME, 'nginx', {});

    const data = lastDeploymentData(prisma);
    expect(data.buildLogs).not.toContain('SECRETBLOB123');
    expect(data.buildLogs).toContain('<redacted>');
  });
});

// ═══════════════════════════════════════════════════════════════════
// runComposeOnlyDeploy
// ═══════════════════════════════════════════════════════════════════

const USER_COMPOSE = `services:
  web:
    image: nginx
    container_name: my-web
    ports:
      - "8080:80"
`;

describe('runComposeOnlyDeploy', () => {
  it('attaches the user compose to project + shared networks and records container info', async () => {
    const { service, prisma } = makeService();

    await service.runComposeOnlyDeploy('dep1', APP_ID, APP_NAME, USER_COMPOSE, {});

    const doc = readComposeDoc();
    expect(doc.services.web.networks).toEqual(
      expect.arrayContaining(['dockcontrol_project', 'dockcontrol_apps']),
    );
    expect(doc.networks.dockcontrol_apps).toEqual({ external: true, name: 'dockcontrol-apps' });

    // The compose publishes "8080:80" → containerPort (Caddy target) is the
    // in-container 80, but the PUBLISHED host port 8080 is what the user
    // reaches the app at, so `port` (URL) + `hostPort` reflect 8080.
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RUNNING',
          containerName: 'my-web',
          containerPort: 80,
          port: 8080,
          hostPort: 8080,
        }),
      }),
    );
  });

  it('writes envVars to .dockcontrol.env and threads --env-file into the compose argv', async () => {
    const { service } = makeService();

    await service.runComposeOnlyDeploy('dep1', APP_ID, APP_NAME, USER_COMPOSE, {
      envVars: { API_KEY: 'k1' },
    });

    const envPath = path.join(appDir(), '.dockcontrol.env');
    expect(vfs.__files.get(norm(envPath))).toBe('API_KEY=k1');
    const up = findExec((c) => c.cmd === 'docker' && c.args.includes('up'));
    expect(up!.args).toEqual([
      'compose', '--env-file', envPath, 'up', '-d', '--remove-orphans',
    ]);
  });

  it('auto-imports bundled DB services after a successful up', async () => {
    const { service, databases } = makeService();

    await service.runComposeOnlyDeploy('dep1', APP_ID, APP_NAME, USER_COMPOSE, {});

    expect(databases.importFromAppCompose).toHaveBeenCalledWith({
      applicationId: APP_ID,
      projectId: 'proj1',
      serverId: 'srv1',
      composeYaml: expect.stringContaining('my-web'),
    });
  });

  it('a DB auto-import failure does not flip the deploy red', async () => {
    const { service, prisma, databases } = makeService();
    databases.importFromAppCompose.mockRejectedValue(new Error('registry down'));

    await service.runComposeOnlyDeploy('dep1', APP_ID, APP_NAME, USER_COMPOSE, {});

    expect(deploymentStatuses(prisma)).toContain('RUNNING');
    expect(deploymentStatuses(prisma)).not.toContain('FAILED');
    expect(lastAppStatus(prisma)).toBe('RUNNING');
  });

  it('compose up failure → ERROR + FAILED', async () => {
    const { service, prisma } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args.includes('up')
        ? new Error('no such image')
        : undefined,
    );

    await service.runComposeOnlyDeploy('dep1', APP_ID, APP_NAME, USER_COMPOSE, {});

    expect(lastAppStatus(prisma)).toBe('ERROR');
    expect(lastDeploymentData(prisma).status).toBe('FAILED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// rewriteComposeForLoadedImages (project-transfer image bundling)
// ═══════════════════════════════════════════════════════════════════

describe('rewriteComposeForLoadedImages', () => {
  const noop = () => {};
  const rewrite = (svc: any, yamlStr: string, tags: string[], slug = 'my-app') =>
    yaml.load(svc.rewriteComposeForLoadedImages(yamlStr, tags, slug, noop)) as any;

  it('pins pull_policy: missing on every service (registry images run as-is)', () => {
    const { service } = makeService();
    const doc = rewrite(service,
      'services:\n  web:\n    image: prestashop/prestashop:8\n  db:\n    image: mariadb:11\n',
      ['prestashop/prestashop:8', 'mariadb:11'],
    );
    expect(doc.services.web.pull_policy).toBe('missing');
    expect(doc.services.db.pull_policy).toBe('missing');
  });

  it('converts a build: service to image: the canonical built tag (no rebuild)', () => {
    const { service } = makeService();
    // imageName('my-app') === 'dockcontrol/my-app:latest' — that tag must be in
    // savedImages for the rewrite to bind it.
    const doc = rewrite(service,
      'services:\n  app:\n    build:\n      context: .\n',
      ['dockcontrol/my-app:latest'],
    );
    expect(doc.services.app.build).toBeUndefined();
    expect(doc.services.app.image).toBe('dockcontrol/my-app:latest');
    expect(doc.services.app.pull_policy).toBe('missing');
  });

  it('keeps an explicit image on a build+image service when it was saved', () => {
    const { service } = makeService();
    const doc = rewrite(service,
      'services:\n  app:\n    build: .\n    image: ghcr.io/me/app:1.2\n',
      ['ghcr.io/me/app:1.2'],
    );
    expect(doc.services.app.build).toBeUndefined();
    expect(doc.services.app.image).toBe('ghcr.io/me/app:1.2');
  });

  it('returns the input unchanged on unparseable YAML (fail-soft)', () => {
    const { service } = makeService();
    const bad = ':\n  not: [valid';
    const out = (service as any).rewriteComposeForLoadedImages(bad, ['x:1'], 'my-app', noop);
    expect(out).toBe(bad);
  });
});

// ═══════════════════════════════════════════════════════════════════
// runDockerfileOnlyDeploy
// ═══════════════════════════════════════════════════════════════════

describe('runDockerfileOnlyDeploy', () => {
  it('writes Dockerfile + context files and runs compose build then up -d', async () => {
    const { service, prisma } = makeService();

    await service.runDockerfileOnlyDeploy('dep1', APP_ID, APP_NAME, 'FROM nginx\nEXPOSE 80', {
      contextFiles: { 'conf/nginx.conf': 'server {}' },
    });

    expect(vfs.__files.get(norm(path.join(appDir(), 'Dockerfile')))).toBe('FROM nginx\nEXPOSE 80');
    expect(vfs.__files.get(norm(path.join(appDir(), 'conf/nginx.conf')))).toBe('server {}');

    const doc = readComposeDoc();
    expect(doc.services.app.build).toEqual({ context: '.' });
    expect(doc.services.app.container_name).toBe('dockcontrol-my-app');

    expect(findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose build')).toBeTruthy();
    expect(
      findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d --remove-orphans'),
    ).toBeTruthy();
    expect(lastAppStatus(prisma)).toBe('RUNNING');
  });

  it('build failure → app ERROR, deployment FAILED with the build error', async () => {
    const { service, prisma } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args[1] === 'build'
        ? new Error('RUN apk add failed')
        : undefined,
    );

    await service.runDockerfileOnlyDeploy('dep1', APP_ID, APP_NAME, 'FROM nginx', {});

    expect(lastAppStatus(prisma)).toBe('ERROR');
    const data = lastDeploymentData(prisma);
    expect(data.status).toBe('FAILED');
    expect(data.deployLogs).toContain('RUN apk add failed');
  });
});

// ═══════════════════════════════════════════════════════════════════
// buildAuthHeader
// ═══════════════════════════════════════════════════════════════════

describe('buildAuthHeader', () => {
  const { service } = makeService();

  it('GITHUB → Basic base64(x-access-token:token)', () => {
    expect(service.buildAuthHeader('GITHUB', 'tok1')).toBe(
      `Authorization: Basic ${Buffer.from('x-access-token:tok1').toString('base64')}`,
    );
  });

  it('GITLAB → Bearer token', () => {
    expect(service.buildAuthHeader('GITLAB', 'tok1')).toBe('Authorization: Bearer tok1');
  });

  it('BITBUCKET → Basic base64(x-token-auth:token)', () => {
    expect(service.buildAuthHeader('BITBUCKET', 'tok1')).toBe(
      `Authorization: Basic ${Buffer.from('x-token-auth:tok1').toString('base64')}`,
    );
  });

  it('unknown provider → Basic base64(token:token)', () => {
    expect(service.buildAuthHeader('GITEA', 'tok1')).toBe(
      `Authorization: Basic ${Buffer.from('token:tok1').toString('base64')}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// runDeploy (git clone pipeline)
// ═══════════════════════════════════════════════════════════════════

const GIT_URL = 'https://github.com/acme/site.git';

describe('runDeploy — clone args', () => {
  it('branch-tip deploy uses a shallow clone', async () => {
    const { service } = makeService();
    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {});

    const clone = findExec((c) => c.cmd === 'git' && c.args.includes('clone'));
    expect(clone!.args).toEqual(['clone', '--depth', '1', '--branch', 'main', GIT_URL, appDir()]);
  });

  it('cloneHeader is injected via -c http.extraheader (never lands in argv-visible config)', async () => {
    const { service } = makeService();
    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      cloneHeader: 'Authorization: Basic SUPERSECRETTOKEN123',
    });

    const clone = findExec((c) => c.cmd === 'git' && c.args.includes('clone'));
    expect(clone!.args.slice(0, 2)).toEqual(['-c', 'http.extraheader=Authorization: Basic SUPERSECRETTOKEN123']);
    // defensive post-clone token strip
    expect(
      findExec((c) => c.cmd === 'git' && c.args.includes('--unset') && c.args.includes('http.extraheader')),
    ).toBeTruthy();
  });

  it('gitRef rollback deploy uses a FULL clone + detached checkout', async () => {
    const { service } = makeService();
    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', { gitRef: 'abc123' });

    const clone = findExec((c) => c.cmd === 'git' && c.args.includes('clone'));
    expect(clone!.args).toEqual(['clone', '--branch', 'main', GIT_URL, appDir()]);
    expect(clone!.args).not.toContain('--depth');
    expect(
      findExec((c) => c.cmd === 'git' && c.args.join(' ') === `-C ${appDir()} checkout --detach abc123`),
    ).toBeTruthy();
  });

  it('never persists the raw clone token in build logs (redacted form only)', async () => {
    const { service, prisma } = makeService();
    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      cloneHeader: 'Authorization: Basic SUPERSECRETTOKEN123',
    });

    let sawRedacted = false;
    for (const call of prisma.deployment.update.mock.calls) {
      const bl = call[0]?.data?.buildLogs;
      if (typeof bl === 'string') {
        expect(bl).not.toContain('SUPERSECRETTOKEN123');
        if (bl.includes('<redacted>')) sawRedacted = true;
      }
    }
    expect(sawRedacted).toBe(true);
  });
});

describe('runDeploy — env handling', () => {
  it('REGRESSION: a failed .env write fails the deploy loudly (stale build-time env)', async () => {
    const { service, prisma } = makeService();
    const defaultWrite = vfs.writeFileSync.getMockImplementation()!;
    vfs.writeFileSync.mockImplementation((p: any, c: any) => {
      if (norm(p).endsWith('/.env')) throw new Error('EACCES: permission denied');
      return defaultWrite(p, c);
    });

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      envVars: { NEXT_PUBLIC_API: 'https://api' },
    });

    expect(lastAppStatus(prisma)).toBe('ERROR');
    const data = lastDeploymentData(prisma);
    expect(data.status).toBe('FAILED');
    expect(data.deployLogs).toContain('failed to write env file .env');
    expect(data.deployLogs).toContain('EACCES');
  });

  it('merges repo env (lowest priority) under user envVars and persists encrypted', async () => {
    const { service, prisma, env } = makeService();
    env.loadRepoEnvFiles.mockReturnValue({ A: 'repo', B: 'repo' });

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      envVars: { A: 'user' },
    });

    expect(env.serializeEnv).toHaveBeenCalledWith({ A: 'user', B: 'repo' });
    expect(vfs.__files.get(norm(path.join(appDir(), '.dockcontrol.env')))).toBe('A=user\nB=repo');
    // mirrored into framework-consumed env files
    expect(vfs.__files.get(norm(path.join(appDir(), '.env')))).toBe('A=user\nB=repo');
    expect(vfs.__files.get(norm(path.join(appDir(), '.env.production')))).toBe('A=user\nB=repo');
    // persisted encrypted, never plaintext
    expect(env.encryptEnvVars).toHaveBeenCalledWith({ A: 'user', B: 'repo' });
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { envVars: { __k: 1, v: JSON.stringify({ A: 'user', B: 'repo' }) } },
      }),
    );
  });
});

describe('runDeploy — compose path', () => {
  it('composeOverride wins; domain attached → ports stripped + Caddy target recorded', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'proj1',
      project: { serverId: 'srv1', server: { id: 'srv1', host: 'localhost' } },
      domains: [{ id: 'd1' }],
    });

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    const doc = readComposeDoc();
    expect(doc.services.web.ports).toBeUndefined(); // stripped — Caddy proxies over the bridge
    expect(doc.services.web.networks).toEqual(
      expect.arrayContaining(['dockcontrol_apps', 'dockcontrol_project']),
    );
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { containerName: 'my-web', containerPort: 80, port: 80 },
      }),
    );
    expect(deploymentStatuses(prisma)).toEqual(
      expect.arrayContaining(['BUILDING', 'DEPLOYING', 'RUNNING']),
    );
  });

  it('runs a cached build and up -d --force-recreate with exact argv', async () => {
    const { service } = makeService();
    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    // Plain `build` (no --no-cache): BuildKit's content-addressed cache
    // already invalidates on source/.env/build-arg changes; deps layers
    // stay cached so redeploys are fast.
    expect(
      findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose build'),
    ).toBeTruthy();
    expect(
      findExec(
        (c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d --force-recreate --remove-orphans',
      ),
    ).toBeTruthy();
  });

  it('no domain + hostPort → remaps the compose ports to <hostPort>:<containerPort>', async () => {
    const { service, prisma } = makeService();

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
      hostPort: 9000,
    });

    const doc = readComposeDoc();
    expect(doc.services.web.ports).toEqual(['9000:80']);
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ containerPort: 80, port: 80, hostPort: 9000 }),
      }),
    );
  });

  it('injects envVars into every compose service environment', async () => {
    const { service } = makeService();
    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
      envVars: { FOO: 'bar' },
    });

    const doc = readComposeDoc();
    expect(doc.services.web.environment).toEqual(expect.objectContaining({ FOO: 'bar' }));
  });

  it('SECURITY: build.args only gets build-time-public env, never secrets', async () => {
    const { service } = makeService();
    const BUILT_COMPOSE = `services:
  web:
    build: .
    container_name: my-web
    ports:
      - "8080:80"
`;
    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: BUILT_COMPOSE,
      hostPort: 9000,
      envVars: {
        NEXT_PUBLIC_API: 'https://api',
        VITE_KEY: 'pk_123',
        DATABASE_URL: 'postgres://secret',
        JWT_SECRET: 'topsecret',
      },
    });

    const doc = readComposeDoc();
    // runtime env keeps everything (it's not in image history)
    expect(doc.services.web.environment).toEqual(
      expect.objectContaining({
        NEXT_PUBLIC_API: 'https://api',
        DATABASE_URL: 'postgres://secret',
        JWT_SECRET: 'topsecret',
      }),
    );
    // build args only the allowlisted public prefixes — secrets MUST be absent
    expect(doc.services.web.build.args).toEqual({
      NEXT_PUBLIC_API: 'https://api',
      VITE_KEY: 'pk_123',
    });
    expect(doc.services.web.build.args.DATABASE_URL).toBeUndefined();
    expect(doc.services.web.build.args.JWT_SECRET).toBeUndefined();
  });

  it('SECURITY: domainless deploy strips repo host-port publishes on reserved ports', async () => {
    const { service } = makeService();
    const RESERVED_COMPOSE = `services:
  web:
    image: nginx
    container_name: my-web
    ports:
      - "443:443"
      - "8080:80"
`;
    // No domain, no hostPort → reserved 443 publish must be dropped, 8080 kept.
    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: RESERVED_COMPOSE,
    });

    const doc = readComposeDoc();
    expect(doc.services.web.ports).toEqual(['8080:80']);
  });
});

describe('runDeploy — Dockerfile path', () => {
  it('builds the image and runs with bridge + project networks, env, no host -p by default', async () => {
    const { service, prisma } = makeService();

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      dockerfileOverride: 'FROM nginx\nEXPOSE 80',
      envVars: { FOO: 'bar' },
    });

    const build = findExec((c) => c.cmd === 'docker' && c.args[0] === 'build');
    expect(build!.args).toEqual(['build', '-t', 'dockcontrol/my-app:latest', '.']);
    expect(norm(build!.opts.cwd)).toBe(norm(appDir()));

    // The canary boots its own labeled `docker run` first — skip it.
    const run = findExec(
      (c) => c.cmd === 'docker' && c.args[0] === 'run' && !c.args.includes('dockcontrol.canary=1'),
    );
    expect(run!.args).toEqual([
      'run', '-d', '--name', 'dockcontrol-my-app', '--restart', 'unless-stopped',
      '--network', 'dockcontrol-apps', '--network-alias', 'my-app',
      '--network', 'dockcontrol_proj_proj1', '--network-alias', 'my-app',
      '-e', 'FOO=bar',
      'dockcontrol/my-app:latest',
    ]);
    expect(run!.args).not.toContain('-p');
    // Canary ran (and was cleaned up) BEFORE the old container was removed.
    const canary = findExec(
      (c) => c.cmd === 'docker' && c.args[0] === 'run' && c.args.includes('dockcontrol.canary=1'),
    );
    expect(canary).toBeTruthy();

    // Caddy coordinates from EXPOSE
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { containerName: 'dockcontrol-my-app', containerPort: 80 },
      }),
    );
    // compose mirror written for later lifecycle ops
    expect(composeFileOf(appDir())).toContain('image: dockcontrol/my-app:latest');
    expect(lastAppStatus(prisma)).toBe('RUNNING');
  });

  it('explicit portMapping opts into a host publish (-p host:container)', async () => {
    const { service } = makeService();

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      dockerfileOverride: 'FROM nginx\nEXPOSE 80',
      portMapping: { '80': 8081 },
    });

    const run = findExec(
      (c) => c.cmd === 'docker' && c.args[0] === 'run' && !c.args.includes('dockcontrol.canary=1'),
    );
    const pIdx = run!.args.indexOf('-p');
    expect(pIdx).toBeGreaterThan(-1);
    expect(run!.args[pIdx + 1]).toBe('8081:80');
  });

  it('blue-green: canary crash → deploy FAILED, old container NEVER removed', async () => {
    const { service, prisma } = makeService();
    // Canary container reports exited(1) on inspect.
    handlers.unshift((cmd, args) =>
      cmd === 'docker' && args[0] === 'inspect' && args.includes('{{.State.Running}} {{.State.ExitCode}}')
        ? { stdout: 'false 1' }
        : undefined,
    );
    // Hold > 0 so the inspect loop actually runs one iteration.
    process.env.DOCKCONTROL_CANARY_HOLD_MS = '1500';

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      dockerfileOverride: 'FROM nginx\nEXPOSE 80',
    });

    // The old production container was never freed: no rm -f on its name,
    // no production `docker run`.
    expect(
      findExec((c) => c.cmd === 'docker' && c.args[0] === 'rm' && c.args.includes('dockcontrol-my-app')),
    ).toBeUndefined();
    expect(
      findExec(
        (c) => c.cmd === 'docker' && c.args[0] === 'run' && !c.args.includes('dockcontrol.canary=1'),
      ),
    ).toBeUndefined();
    // Canary itself was cleaned up.
    expect(
      findExec((c) => c.cmd === 'docker' && c.args[0] === 'rm' && c.args.some((a) => a.startsWith('dockcontrol-canary-'))),
    ).toBeTruthy();
    expect(lastDeploymentData(prisma).status).toBe('FAILED');
  });
});

describe('runDeploy — stack autodetection', () => {
  it('generates the framework Dockerfile and locks the canonical internal port', async () => {
    const { service, prisma } = makeService();
    vi.mocked(detectStack).mockReturnValue('NEXTJS' as any);

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {});

    expect(vfs.__files.get(norm(path.join(appDir(), 'Dockerfile')))).toContain('FROM node:20-alpine');
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          port: 3000,
          framework: 'NEXTJS',
          containerName: 'dockcontrol-my-app',
          containerPort: 3000,
        }),
      }),
    );
    // proceeds through the Dockerfile build path
    expect(findExec((c) => c.cmd === 'docker' && c.args[0] === 'build')).toBeTruthy();
  });

  it('no framework match → synthesizes a node compose with sh -c, commands stay structured data', async () => {
    const { service } = makeService();

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      port: 4000,
      buildCommand: 'npm ci',
      startCommand: 'node "weird; rm -rf /" start',
    });

    const doc = readComposeDoc();
    const svc = doc.services[SLUG];
    expect(svc.image).toBe('node:20-alpine');
    expect(svc.container_name).toBe('dockcontrol-my-app');
    expect(svc.ports).toEqual(['4000:4000']);
    // YAML structured form — quotes/semicolons survive as a single argv element
    expect(svc.command).toEqual(['sh', '-c', 'npm ci && node "weird; rm -rf /" start']);
    expect(
      findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d --build --remove-orphans'),
    ).toBeTruthy();
  });
});

describe('runDeploy — healthcheck, rollback & statuses', () => {
  it('healthcheck failure (container exited) → FAILED with explicit message, app ERROR', async () => {
    const { service, prisma } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args.includes('ps')
        ? { stdout: '{"State":"exited"}' }
        : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    expect(lastAppStatus(prisma)).toBe('ERROR');
    const data = lastDeploymentData(prisma);
    expect(data.status).toBe('FAILED');
    expect(data.deployLogs).toContain('Healthcheck failed');
  });

  it('failure with a previous RUNNING deploy → rollback up, ROLLING_BACK → ROLLED_BACK, app RUNNING', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.findFirst.mockResolvedValue({ id: 'prev-dep' });
    // the new deploy's up (--force-recreate) fails; the rollback's plain `up -d` succeeds
    handlers.push((cmd, args) =>
      cmd === 'docker' && args.includes('--force-recreate') ? new Error('image broke') : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    expect(prisma.deployment.findFirst).toHaveBeenCalledWith({
      where: { applicationId: APP_ID, status: 'RUNNING', id: { not: 'dep1' } },
      orderBy: { createdAt: 'desc' },
    });
    const statuses = deploymentStatuses(prisma);
    expect(statuses).toContain('ROLLING_BACK');
    expect(statuses[statuses.length - 1]).toBe('ROLLED_BACK');
    expect(lastAppStatus(prisma)).toBe('RUNNING');
    // rollback re-up is the plain compose up -d
    expect(findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d')).toBeTruthy();
  });

  it('rollback whose healthcheck fails → FAILED + app ERROR', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.findFirst.mockResolvedValue({ id: 'prev-dep' });
    handlers.push((cmd, args) =>
      cmd === 'docker' && args.includes('--force-recreate') ? new Error('image broke') : undefined,
    );
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args.includes('ps')
        ? { stdout: '{"State":"exited"}' }
        : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    expect(deploymentStatuses(prisma)).toContain('ROLLING_BACK');
    expect(lastDeploymentData(prisma).status).toBe('FAILED');
    expect(lastAppStatus(prisma)).toBe('ERROR');
  });

  it('no previous successful deploy → no rollback attempted, straight to FAILED', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.findFirst.mockResolvedValue(null);
    handlers.push((cmd, args) =>
      cmd === 'docker' && args.includes('--force-recreate') ? new Error('boom') : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    expect(deploymentStatuses(prisma)).not.toContain('ROLLING_BACK');
    expect(lastDeploymentData(prisma).status).toBe('FAILED');
    expect(lastAppStatus(prisma)).toBe('ERROR');
  });

  it('success → app RUNNING + deployment RUNNING with commit metadata + success notification', async () => {
    const { service, prisma, notifications } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'git' && args.includes('rev-parse') ? { stdout: 'sha1234\n' } : undefined,
    );
    handlers.push((cmd, args) =>
      cmd === 'git' && args.includes('log') ? { stdout: 'feat: launch\n' } : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    expect(lastAppStatus(prisma)).toBe('RUNNING');
    const data = lastDeploymentData(prisma);
    expect(data.status).toBe('RUNNING');
    expect(data.commitSha).toBe('sha1234');
    expect(data.commitMessage).toBe('feat: launch');
    await vi.waitFor(() =>
      expect(notifications.sendDeploymentResult).toHaveBeenCalledWith('u1', APP_NAME, 'success', undefined),
    );
  });
});

describe('runDeploy — build failure & .prev snapshot rollback', () => {
  const prevDir = () => `${appDir()}.prev`;
  const OLD_COMPOSE = `services:
  old:
    image: old-image:1.0
    container_name: my-web
`;

  /** Simulate a previous successful deploy on disk. */
  function seedExistingAppDir() {
    vfs.__dirs.add(norm(appDir()));
    vfs.__files.set(norm(path.join(appDir(), 'docker-compose.yml')), OLD_COMPOSE);
  }

  it('REGRESSION: compose build failure fails the deploy — no silent up of a stale image', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.findFirst.mockResolvedValue(null); // no rollback target
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args[1] === 'build'
        ? new Error('npm ERR! build exploded')
        : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    expect(lastAppStatus(prisma)).toBe('ERROR');
    const data = lastDeploymentData(prisma);
    expect(data.status).toBe('FAILED');
    expect(data.deployLogs).toContain('docker compose build failed');
    expect(data.deployLogs).toContain('build exploded');
    expect(data.buildLogs).toContain('build exploded');
    // the broken build must never reach `up` — that's what relaunched the old image
    expect(
      findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d --force-recreate --remove-orphans'),
    ).toBeUndefined();
  });

  it('compose pull failure stays best-effort (local image / local build still deploys)', async () => {
    const { service, prisma } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args[1] === 'pull'
        ? new Error('manifest unknown')
        : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    expect(lastAppStatus(prisma)).toBe('RUNNING');
    expect(lastDeploymentData(prisma).status).toBe('RUNNING');
  });

  it('redeploy snapshots the old appDir to .prev (rename) and deletes the snapshot on success', async () => {
    const { service, prisma } = makeService();
    seedExistingAppDir();

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    // snapshot via rename — atomic + zero copy cost
    expect(
      vfs.renameSync.mock.calls.some(
        (c) => norm(c[0]) === norm(appDir()) && norm(c[1]) === norm(prevDir()),
      ),
    ).toBe(true);
    // success → snapshot discarded
    expect(vfs.rmSync.mock.calls.some((c) => norm(c[0]) === norm(prevDir()))).toBe(true);
    expect(vfs.__dirs.has(norm(prevDir()))).toBe(false);
    expect(lastDeploymentData(prisma).status).toBe('RUNNING');
  });

  it('REGRESSION: rollback restores the .prev snapshot BEFORE re-up — not the broken new dir', async () => {
    const { service, prisma } = makeService();
    seedExistingAppDir();
    prisma.deployment.findFirst.mockResolvedValue({ id: 'prev-dep' });
    // the new deploy's up (--force-recreate) fails; the rollback's plain `up -d` succeeds
    handlers.push((cmd, args) =>
      cmd === 'docker' && args.includes('--force-recreate') ? new Error('image broke') : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    const statuses = deploymentStatuses(prisma);
    expect(statuses).toContain('ROLLING_BACK');
    expect(statuses[statuses.length - 1]).toBe('ROLLED_BACK');
    expect(lastAppStatus(prisma)).toBe('RUNNING');
    // the appDir now holds the PREVIOUS compose, not the failed deploy's rewrite
    expect(composeFileOf(appDir())).toBe(OLD_COMPOSE);
    expect(vfs.__dirs.has(norm(prevDir()))).toBe(false); // swap consumed the snapshot
    expect(findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d')).toBeTruthy();
  });

  it('an orphan .prev left by a mid-deploy crash is overwritten by the next snapshot', async () => {
    const { service, prisma } = makeService();
    seedExistingAppDir();
    vfs.__dirs.add(norm(prevDir()));
    vfs.__files.set(norm(path.join(prevDir(), 'docker-compose.yml')), 'services: {stale: {image: stale}}');

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    // orphan wiped before the rename so the snapshot is the CURRENT appDir
    const rmOrphanIdx = vfs.rmSync.mock.calls.findIndex((c) => norm(c[0]) === norm(prevDir()));
    expect(rmOrphanIdx).toBeGreaterThan(-1);
    expect(
      vfs.renameSync.mock.calls.some(
        (c) => norm(c[0]) === norm(appDir()) && norm(c[1]) === norm(prevDir()),
      ),
    ).toBe(true);
    expect(lastDeploymentData(prisma).status).toBe('RUNNING');
  });

  it('first deploy (no existing appDir) → no snapshot taken, failure goes straight to FAILED', async () => {
    const { service, prisma } = makeService();
    prisma.deployment.findFirst.mockResolvedValue(null);
    handlers.push((cmd, args) =>
      cmd === 'docker' && args.includes('--force-recreate') ? new Error('boom') : undefined,
    );

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {
      composeOverride: USER_COMPOSE,
    });

    expect(vfs.renameSync).not.toHaveBeenCalled();
    expect(lastDeploymentData(prisma).status).toBe('FAILED');
  });
});

describe('runDeploy — remote server delegation', () => {
  function makeRemote() {
    const ctx = makeService();
    ctx.prisma.application.findUnique.mockResolvedValue({
      projectId: 'proj1',
      project: { serverId: 'srv-remote', server: { id: 'srv-remote', host: '203.0.113.7' } },
      domains: [],
    });
    return ctx;
  }

  it('delegates the whole deploy to the agent with the project network in the payload', async () => {
    const { service, prisma, agent } = makeRemote();
    agent.enqueueAndWait.mockResolvedValue({
      status: 'COMPLETED',
      result: { commitSha: 'abc', commitMessage: 'msg', logs: 'remote ok' },
    });

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', { port: 3000 });

    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'srv-remote',
      'DEPLOY',
      expect.objectContaining({
        // per-instance slug (remoteAppSlug) — same convention lifecycle ops
        // and remove() use, so the agent dir matches across the app's life.
        slug: `${SLUG}-${APP_ID.slice(0, 12)}`,
        appName: APP_NAME,
        gitUrl: GIT_URL,
        branch: 'main',
        projectNetwork: 'dockcontrol_proj_proj1',
      }),
      15 * 60_000,
    );
    // nothing executed locally
    expect(findExec((c) => c.cmd === 'git')).toBeUndefined();
    expect(lastAppStatus(prisma)).toBe('RUNNING');
    expect(lastDeploymentData(prisma).commitSha).toBe('abc');
  });

  it('agent task FAILED → app ERROR + deployment FAILED with the agent error', async () => {
    const { service, prisma, agent } = makeRemote();
    agent.enqueueAndWait.mockResolvedValue({ status: 'FAILED', error: 'agent boom', result: {} });

    await service.runDeploy('dep1', APP_ID, APP_NAME, GIT_URL, 'main', {});

    expect(lastAppStatus(prisma)).toBe('ERROR');
    const data = lastDeploymentData(prisma);
    expect(data.status).toBe('FAILED');
    expect(data.deployLogs).toContain('agent boom');
  });
});

// ═══════════════════════════════════════════════════════════════════
// runPhpSiteDeploy (Apache + selectable PHP version, SFTP docroot)
// ═══════════════════════════════════════════════════════════════════

describe('runPhpSiteDeploy', () => {
  const dockerfileOf = (dir: string) => vfs.__files.get(norm(path.join(dir, 'Dockerfile')));

  it('writes a parametrized Dockerfile + compose with build arg, bind-mount docroot, then build + up', async () => {
    const { service, prisma } = makeService();

    await service.runPhpSiteDeploy('dep1', APP_ID, APP_NAME, '8.2', {});

    const dockerfile = dockerfileOf(appDir())!;
    expect(dockerfile).toContain('ARG PHP_VERSION');
    expect(dockerfile).toContain('FROM php:${PHP_VERSION}-apache');

    const doc = readComposeDoc();
    expect(doc.services.app.build).toEqual({ context: '.', args: { PHP_VERSION: '8.2' } });
    expect(doc.services.app.container_name).toBe('dockcontrol-my-app');
    expect(doc.services.app.networks).toEqual(['dockcontrol_project', 'dockcontrol_apps']);
    // LIVE docroot bind mount → public/ subdir, served with no rebuild.
    expect(doc.services.app.volumes).toHaveLength(1);
    expect(norm(doc.services.app.volumes[0])).toMatch(/\/apps\/my-app-[^/]+\/public:\/var\/www\/html$/);

    // build BEFORE up (build failure must roll back before any container changes).
    expect(findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose build')).toBeTruthy();
    expect(findExec((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d --remove-orphans')).toBeTruthy();

    // Persists the two fields Caddy's mainLinked gate needs + the version.
    expect(prisma.application.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RUNNING', framework: 'PHP_SITE', phpVersion: '8.2',
          containerName: 'dockcontrol-my-app', containerPort: 80, port: 80,
        }),
      }),
    );
    expect(lastAppStatus(prisma)).toBe('RUNNING');
  });

  it('seeds a starter public/index.php on first deploy', async () => {
    const { service } = makeService();
    await service.runPhpSiteDeploy('dep1', APP_ID, APP_NAME, '8.3', {});
    const indexPath = norm(path.join(appDir(), 'public', 'index.php'));
    expect(vfs.__files.has(indexPath)).toBe(true);
    expect(vfs.__files.get(indexPath)).toContain('<?php');
  });

  it('falls back to the default PHP version for an out-of-range value', async () => {
    const { service } = makeService();
    await service.runPhpSiteDeploy('dep1', APP_ID, APP_NAME, '5.6' as any, {});
    expect(readComposeDoc().services.app.build.args.PHP_VERSION).toBe('8.3');
  });

  it('publishes a host port only when one was chosen', async () => {
    const { service } = makeService();
    await service.runPhpSiteDeploy('dep1', APP_ID, APP_NAME, '8.3', { hostPort: 8090 });
    expect(readComposeDoc().services.app.ports).toEqual(['8090:80']);
  });

  it('build failure → app ERROR, deployment FAILED', async () => {
    const { service, prisma } = makeService();
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'compose' && args[1] === 'build'
        ? new Error('build blew up') : undefined,
    );
    await service.runPhpSiteDeploy('dep1', APP_ID, APP_NAME, '8.3', {});
    expect(lastAppStatus(prisma)).toBe('ERROR');
    expect(deploymentStatuses(prisma)).toContain('FAILED');
  });

  it('a remote-placed PHP site is refused (bind mount needs the local host daemon)', async () => {
    const { service, prisma } = makeService();
    // Place the app on a remote server.
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'proj1', serverId: 'remoteSrv',
      server: { id: 'remoteSrv', host: '203.0.113.7' },
      project: { serverId: 'remoteSrv', server: { id: 'remoteSrv', host: '203.0.113.7' } },
      domains: [],
    });
    await service.runPhpSiteDeploy('dep1', APP_ID, APP_NAME, '8.3', {});
    expect(lastAppStatus(prisma)).toBe('ERROR');
    const data = lastDeploymentData(prisma);
    expect(data.status).toBe('FAILED');
    expect(data.deployLogs).toMatch(/local host/i);
  });
});
