import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';

/**
 * DockerService tests — the admin-only raw docker surface. Every invocation
 * goes through `execFileAsync('docker', argv)`, mocked via promisify.custom so
 * no real daemon is touched. The focus is the safety logic: serverId/container
 * validation, the protected-container guard (incl. the hex-ID + fail-closed
 * paths), verb allowlisting, and the redacted error surface.
 */

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }));

vi.mock('child_process', async () => {
  const util = await import('util');
  const execFile: any = vi.fn();
  execFile[util.promisify.custom] = (...args: unknown[]) => execFileAsyncMock(...args);
  return { execFile };
});

import { DockerService } from './docker.service';

function makeService() {
  return new DockerService();
}

beforeEach(() => {
  vi.clearAllMocks();
  execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('serverId validation', () => {
  it('rejects a malformed serverId before running docker', async () => {
    const service = makeService();
    await expect(service.listContainers('bad id!')).rejects.toThrow(BadRequestException);
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('accepts a well-formed serverId', async () => {
    const service = makeService();
    await service.listContainers('srv_1-abc');
    expect(execFileAsyncMock).toHaveBeenCalled();
  });
});

describe('listContainers / listImages / listNetworks / listVolumes', () => {
  it('parses JSON-lines output and maps container fields', async () => {
    const service = makeService();
    execFileAsyncMock.mockResolvedValue({
      stdout:
        JSON.stringify({ ID: 'abc', Names: 'web', Image: 'nginx', State: 'running', Ports: '80', Status: 'Up 2h' }) +
        '\n',
      stderr: '',
    });
    const res = await service.listContainers('s1');
    expect(res[0]).toMatchObject({ id: 'abc', name: 'web', image: 'nginx', status: 'running' });
  });

  it('derives status from Status text when State is absent', async () => {
    const service = makeService();
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ ID: 'x', Names: 'db', Image: 'pg', Status: 'Up 10m' }) + '\n',
      stderr: '',
    });
    const res = await service.listContainers('s1');
    expect(res[0].status).toBe('running');
  });

  it('skips a single malformed JSON line instead of dropping the whole list', async () => {
    const service = makeService();
    execFileAsyncMock.mockResolvedValue({
      stdout:
        JSON.stringify({ ID: '1', Names: 'a', Image: 'i' }) +
        '\n{ this is not json }\n' +
        JSON.stringify({ ID: '2', Names: 'b', Image: 'i' }) +
        '\n',
      stderr: '',
    });
    const res = await service.listContainers('s1');
    expect(res.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('listImages drops <none> tags', async () => {
    const service = makeService();
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ ID: 'img1', Repository: '<none>', Tag: '<none>', Size: '5MB' }) + '\n',
      stderr: '',
    });
    const res = await service.listImages('s1');
    expect(res[0].tags).toEqual([]);
  });

  it('listNetworks / listVolumes map their rows', async () => {
    const service = makeService();
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ ID: 'n1', Name: 'bridge', Driver: 'bridge', Scope: 'local' }) + '\n',
      stderr: '',
    });
    expect((await service.listNetworks('s1'))[0]).toMatchObject({ id: 'n1', name: 'bridge' });

    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ Name: 'vol1', Driver: 'local', Mountpoint: '/m' }) + '\n',
      stderr: '',
    });
    expect((await service.listVolumes('s1'))[0]).toMatchObject({ name: 'vol1', driver: 'local' });
  });
});

describe('containerAction — verb + id validation', () => {
  it('rejects an unknown action', async () => {
    const service = makeService();
    await expect(service.containerAction('s1', 'web', 'nuke')).rejects.toThrow(
      /Unknown container action/,
    );
  });

  it('rejects an invalid container id/name', async () => {
    const service = makeService();
    await expect(service.containerAction('s1', 'bad name!', 'start')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('start (non-destructive) maps to `docker start -- <id>` with no protected-name lookup', async () => {
    const service = makeService();
    const res = await service.containerAction('s1', 'mycontainer', 'start');
    // Only the action call — no `inspect` resolve for non-destructive verbs.
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    expect(execFileAsyncMock.mock.calls[0][1]).toEqual(['start', '--', 'mycontainer']);
    expect(res.message).toBe('Container start successful');
  });
});

describe('containerAction — protected-container guard', () => {
  it('refuses a destructive action on a protected NAME directly', async () => {
    const service = makeService();
    await expect(service.containerAction('s1', 'dockcontrol-postgres', 'remove')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses when a hex ID RESOLVES to a protected name (guard cannot be bypassed by ID)', async () => {
    const service = makeService();
    // inspect resolves the hex id to a protected name.
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '/dockcontrol-api\n', stderr: '' });
    await expect(service.containerAction('s1', 'abcdef012345', 'kill')).rejects.toThrow(
      /protected container/,
    );
  });

  it('fail-closed: an unverifiable id (inspect fails) is refused for destructive actions', async () => {
    const service = makeService();
    execFileAsyncMock.mockRejectedValueOnce(new Error('daemon down')); // inspect fails → null name
    await expect(service.containerAction('s1', 'abcdef012345', 'stop')).rejects.toThrow(
      /Could not verify/,
    );
  });

  it('allows a destructive action on a normal, resolvable, non-protected container', async () => {
    const service = makeService();
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '/my-app\n', stderr: '' }) // inspect resolve
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // rm
    const res = await service.containerAction('s1', 'my-app', 'remove');
    expect(res.message).toBe('Container remove successful');
    // Last call is the rm with the -- separator.
    expect(execFileAsyncMock.mock.calls.at(-1)![1]).toEqual(['rm', '-f', '--', 'my-app']);
  });
});

describe('error surface', () => {
  it('maps a docker failure to a 500 with only a correlation ref (no stderr leak)', async () => {
    const service = makeService();
    execFileAsyncMock.mockRejectedValue({ stderr: 'No such container: secret-adjacent' });
    try {
      await service.listContainers('s1');
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(InternalServerErrorException);
      // The adjacent-container name from stderr must NOT reach the client.
      expect(e.message).not.toContain('secret-adjacent');
      expect(e.message).toMatch(/ref [a-f0-9]{8}/);
    }
  });
});
