import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * DeploymentTargetService tests — the single seam that decides "run it on the
 * API box myself" vs "hand it to the agent on a remote host". Same recipe as
 * the other service specs: plain vi.fn() deps, no real docker/disk.
 *
 * child_process.execFile is mocked via promisify.custom so the local branch's
 * `execFileAsync` resolves/rejects synchronously; fs.promises is stubbed so no
 * real files move. The agent is a plain object of vi.fn()s.
 */

const { execFileAsyncMock, mkdirMock, writeFileMock, rmMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
  rmMock: vi.fn(),
}));

vi.mock('child_process', async () => {
  const util = await import('util');
  const execFile: any = vi.fn();
  execFile[util.promisify.custom] = (...args: unknown[]) => execFileAsyncMock(...args);
  return { execFile };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...real,
    promises: {
      ...real.promises,
      mkdir: mkdirMock,
      writeFile: writeFileMock,
      rm: rmMock,
    },
  };
  return { ...mocked, default: mocked };
});

import {
  DeploymentTargetService,
  isLocalHost,
  LOCAL_HOSTS,
} from './deployment-target.service';

function makeAgent() {
  return {
    enqueueAndWait: vi.fn().mockResolvedValue({ status: 'COMPLETED', result: {}, error: null }),
  };
}

function makeService() {
  const agent = makeAgent();
  const service = new DeploymentTargetService(agent as any);
  return { service, agent };
}

const REMOTE = { id: 'srv-remote', host: '10.0.0.9' };
const LOCAL = { id: 'srv-local', host: '127.0.0.1' };

beforeEach(() => {
  vi.clearAllMocks();
  execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
});

describe('isLocalHost / LOCAL_HOSTS', () => {
  it('treats null/undefined/empty as local (no server attached → in-process)', () => {
    expect(isLocalHost(null)).toBe(true);
    expect(isLocalHost(undefined)).toBe(true);
    expect(isLocalHost('')).toBe(true);
  });

  it('recognises every loopback/self alias as local', () => {
    for (const h of ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal', '::1']) {
      expect(isLocalHost(h)).toBe(true);
      expect(LOCAL_HOSTS.has(h)).toBe(true);
    }
  });

  it('treats a real remote host/IP as NOT local', () => {
    expect(isLocalHost('10.0.0.9')).toBe(false);
    expect(isLocalHost('example.com')).toBe(false);
  });
});

describe('isLocal (instance predicate)', () => {
  it('a null/undefined server is local', () => {
    const { service } = makeService();
    expect(service.isLocal(null)).toBe(true);
    expect(service.isLocal(undefined)).toBe(true);
  });

  it('mirrors isLocalHost on the server.host', () => {
    const { service } = makeService();
    expect(service.isLocal(LOCAL)).toBe(true);
    expect(service.isLocal(REMOTE)).toBe(false);
  });
});

describe('execute', () => {
  it('local: runs execFile directly and normalises a success to code 0', async () => {
    const { service, agent } = makeService();
    execFileAsyncMock.mockResolvedValue({ stdout: 'hi', stderr: '' });

    const res = await service.execute(LOCAL, 'echo', ['hi']);

    expect(res).toEqual({ stdout: 'hi', stderr: '', code: 0 });
    // Never touches the agent on the local path.
    expect(agent.enqueueAndWait).not.toHaveBeenCalled();
    const [cmd, argv] = execFileAsyncMock.mock.calls[0];
    expect(cmd).toBe('echo');
    expect(argv).toEqual(['hi']);
  });

  it('local: a non-zero exit is surfaced (not thrown) with stdout/stderr/code preserved', async () => {
    const { service } = makeService();
    // execFile rejects on non-zero exit; the service must catch and normalise.
    execFileAsyncMock.mockRejectedValue({ stdout: 'partial', stderr: 'boom', code: 3 });

    const res = await service.execute(LOCAL, 'docker', ['rm', 'ghost']);

    expect(res).toEqual({ stdout: 'partial', stderr: 'boom', code: 3 });
  });

  it('local: a rejection without a numeric code defaults to code 1 and uses message as stderr', async () => {
    const { service } = makeService();
    execFileAsyncMock.mockRejectedValue(new Error('spawn ENOENT'));

    const res = await service.execute(LOCAL, 'nope', []);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('ENOENT');
  });

  it('local: merges opts.env over process.env and forwards cwd + timeout', async () => {
    const { service } = makeService();
    process.env.__DT_BASE = 'base';
    await service.execute(LOCAL, 'env', [], { cwd: '/work', timeoutMs: 1234, env: { FOO: 'bar' } });

    const opts = execFileAsyncMock.mock.calls[0][2];
    expect(opts.cwd).toBe('/work');
    expect(opts.timeout).toBe(1234);
    expect(opts.env.FOO).toBe('bar');
    expect(opts.env.__DT_BASE).toBe('base'); // inherited from process.env
    delete process.env.__DT_BASE;
  });

  it('remote: enqueues an EXEC task and normalises the agent result', async () => {
    const { service, agent } = makeService();
    agent.enqueueAndWait.mockResolvedValue({
      status: 'COMPLETED',
      result: { stdout: 'out', stderr: 'err', code: 0 },
      error: null,
    });

    const res = await service.execute(REMOTE, 'ls', ['-la'], { cwd: '/srv', env: { A: '1' } });

    expect(res).toEqual({ stdout: 'out', stderr: 'err', code: 0 });
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'srv-remote',
      'EXEC',
      { command: 'ls', args: ['-la'], cwd: '/srv', env: { A: '1' } },
      300_000,
    );
  });

  it('remote: a FAILED task with no result code maps to code 1 and surfaces task.error', async () => {
    const { service, agent } = makeService();
    agent.enqueueAndWait.mockResolvedValue({ status: 'FAILED', result: null, error: 'agent offline' });

    const res = await service.execute(REMOTE, 'ls', []);
    expect(res.code).toBe(1);
    expect(res.stderr).toBe('agent offline');
  });
});

describe('composeUp / composeDown / composeStop / composeRestart', () => {
  it('local composeUp runs `docker compose up -d --remove-orphans` in dir', async () => {
    const { service } = makeService();
    await service.composeUp(LOCAL, '/apps/foo');
    const [cmd, argv, opts] = execFileAsyncMock.mock.calls[0];
    expect(cmd).toBe('docker');
    expect(argv).toEqual(['compose', 'up', '-d', '--remove-orphans']);
    expect(opts.cwd).toBe('/apps/foo');
  });

  it('remote composeUp fires a START task carrying the slug (never the local dir)', async () => {
    const { service, agent } = makeService();
    await service.composeUp(REMOTE, '/ignored/on/remote', { slug: 'foo-abc', legacySlug: 'foo' });
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'srv-remote',
      'START',
      { slug: 'foo-abc', legacySlug: 'foo' },
      180_000,
    );
  });

  it('local composeDown adds -v only when purgeVolumes is true', async () => {
    const { service } = makeService();
    await service.composeDown(LOCAL, '/apps/foo', false);
    expect(execFileAsyncMock.mock.calls[0][1]).toEqual(['compose', 'down', '--remove-orphans']);

    execFileAsyncMock.mockClear();
    await service.composeDown(LOCAL, '/apps/foo', true);
    expect(execFileAsyncMock.mock.calls[0][1]).toEqual(['compose', 'down', '-v', '--remove-orphans']);
  });

  it('remote composeDown forwards purgeVolumes to the REMOVE task', async () => {
    const { service, agent } = makeService();
    await service.composeDown(REMOTE, '/x', true, { slug: 'foo-abc' });
    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'srv-remote',
      'REMOVE',
      { slug: 'foo-abc', legacySlug: undefined, purgeVolumes: true },
      120_000,
    );
  });

  it('local composeStop runs `docker compose stop` (no container/volume removal)', async () => {
    const { service } = makeService();
    await service.composeStop(LOCAL, '/apps/foo');
    expect(execFileAsyncMock.mock.calls[0][1]).toEqual(['compose', 'stop']);
  });

  it('remote composeStop / composeRestart fire STOP / RESTART tasks', async () => {
    const { service, agent } = makeService();
    await service.composeStop(REMOTE, '/x', { slug: 's' });
    await service.composeRestart(REMOTE, '/x', { slug: 's' });
    const types = agent.enqueueAndWait.mock.calls.map((c: any[]) => c[1]);
    expect(types).toEqual(['STOP', 'RESTART']);
  });

  it('local composeRestart runs `docker compose restart`', async () => {
    const { service } = makeService();
    await service.composeRestart(LOCAL, '/apps/foo');
    expect(execFileAsyncMock.mock.calls[0][1]).toEqual(['compose', 'restart']);
  });
});

describe('writeFile / removeFile / removeDir', () => {
  it('local writeFile mkdirs the parent then writes the content', async () => {
    const { service, agent } = makeService();
    await service.writeFile(LOCAL, '/apps/foo/docker-compose.yml', 'services: {}');
    expect(mkdirMock).toHaveBeenCalledWith('/apps/foo', { recursive: true });
    expect(writeFileMock).toHaveBeenCalledWith('/apps/foo/docker-compose.yml', 'services: {}');
    expect(agent.enqueueAndWait).not.toHaveBeenCalled();
  });

  it('remote writeFile sends a utf8 FILE_WRITE for a string payload', async () => {
    const { service, agent } = makeService();
    await service.writeFile(REMOTE, '/etc/app.conf', 'hello');
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'srv-remote',
      'FILE_WRITE',
      { path: '/etc/app.conf', content: 'hello', encoding: 'utf8' },
      60_000,
    );
  });

  it('remote writeFile base64-encodes a Buffer payload', async () => {
    const { service, agent } = makeService();
    await service.writeFile(REMOTE, '/etc/blob', Buffer.from('binary'));
    const payload = agent.enqueueAndWait.mock.calls[0][2];
    expect(payload.encoding).toBe('base64');
    expect(payload.content).toBe(Buffer.from('binary').toString('base64'));
  });

  it('local removeFile rm -f; remote sends an EXEC rm -f', async () => {
    const { service, agent } = makeService();
    await service.removeFile(LOCAL, '/tmp/x');
    expect(rmMock).toHaveBeenCalledWith('/tmp/x', { force: true });

    await service.removeFile(REMOTE, '/tmp/x');
    expect(agent.enqueueAndWait).toHaveBeenCalledWith(
      'srv-remote',
      'EXEC',
      { command: 'rm', args: ['-f', '/tmp/x'] },
      30_000,
    );
  });

  it('local removeDir recurses; remote EXEC uses -rf when force, -r otherwise', async () => {
    const { service, agent } = makeService();
    await service.removeDir(LOCAL, '/apps/foo');
    expect(rmMock).toHaveBeenCalledWith('/apps/foo', { recursive: true, force: true });

    await service.removeDir(REMOTE, '/apps/foo', true);
    expect(agent.enqueueAndWait.mock.calls.at(-1)![2]).toEqual({ command: 'rm', args: ['-rf', '/apps/foo'] });

    await service.removeDir(REMOTE, '/apps/foo', false);
    expect(agent.enqueueAndWait.mock.calls.at(-1)![2]).toEqual({ command: 'rm', args: ['-r', '/apps/foo'] });
  });
});
