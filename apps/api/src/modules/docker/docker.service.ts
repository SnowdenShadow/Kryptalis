import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Action names allowed on `containerAction`. We map them to actual docker
 * verbs so we don't echo a user-controlled string back into the argv —
 * defense in depth on top of `execFile` (which already avoids shell).
 */
const CONTAINER_ACTION_VERBS: Record<string, string[]> = {
  start: ['start'],
  stop: ['stop'],
  restart: ['restart'],
  remove: ['rm', '-f'],
  kill: ['kill'],
};

// Docker container IDs are 64-char hex (or 12-char short form); container
// names allow [a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}. We accept both.
const CONTAINER_ID_RE = /^([a-f0-9]{12}|[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$/;

/**
 * Docker management — exposed only to platform admins (gated at the
 * controller). All shell invocations use `execFile` (no shell) with argv
 * arrays so user input can never escape into a command. Failures throw
 * properly so the frontend can distinguish daemon-down / permission-denied
 * from genuinely-empty state.
 *
 * Container actions also accept only a fixed allowlist of verbs; the action
 * the dashboard sends is mapped to canonical docker argv before exec.
 *
 * serverId is intentionally a string param (no real multi-server routing
 * yet — every action runs against the local daemon). The path shape is kept
 * so the future multi-host plumbing only needs to inject a docker context.
 */
@Injectable()
export class DockerService {
  async listContainers(_serverId: string) {
    const { stdout } = await this.runDocker(
      ['ps', '-a', '--format', '{{json .}}'],
      10_000,
    );
    return this.parseJsonLines(stdout).map((c) => ({
      id: c.ID,
      name: c.Names,
      image: c.Image,
      status:
        c.State ||
        (typeof c.Status === 'string' && c.Status.includes('Up') ? 'running' : 'exited'),
      ports: c.Ports || '',
      created: c.CreatedAt || c.RunningFor,
      state: c.Status,
    }));
  }

  async containerAction(_serverId: string, containerId: string, action: string) {
    const verbArgs = CONTAINER_ACTION_VERBS[action];
    if (!verbArgs) {
      throw new BadRequestException(`Unknown container action: ${action}`);
    }
    if (typeof containerId !== 'string' || !CONTAINER_ID_RE.test(containerId)) {
      throw new BadRequestException('Invalid container id or name.');
    }
    await this.runDocker([...verbArgs, containerId], 30_000);
    return { message: `Container ${action} successful` };
  }

  async listImages(_serverId: string) {
    const { stdout } = await this.runDocker(
      ['images', '--format', '{{json .}}'],
      10_000,
    );
    return this.parseJsonLines(stdout).map((img) => ({
      id: img.ID,
      tags: [img.Repository + ':' + img.Tag].filter((t) => !t.includes('<none>')),
      size: img.Size,
      created: img.CreatedAt || img.CreatedSince,
    }));
  }

  async listNetworks(_serverId: string) {
    const { stdout } = await this.runDocker(
      ['network', 'ls', '--format', '{{json .}}'],
      10_000,
    );
    return this.parseJsonLines(stdout).map((n) => ({
      id: n.ID,
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
    }));
  }

  async listVolumes(_serverId: string) {
    const { stdout } = await this.runDocker(
      ['volume', 'ls', '--format', '{{json .}}'],
      10_000,
    );
    return this.parseJsonLines(stdout).map((v) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint || '',
      size: v.Size || null,
      createdAt: '',
    }));
  }

  // ── internals ──────────────────────────────────────────────────────

  private async runDocker(args: string[], timeoutMs: number) {
    try {
      return await execFileAsync('docker', args, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (err: any) {
      const msg = err?.stderr || err?.message || 'docker command failed';
      throw new InternalServerErrorException(
        `docker ${args.join(' ')}: ${String(msg).split('\n')[0]}`,
      );
    }
  }

  // A single malformed line shouldn't drop the whole list — skip per-line.
  private parseJsonLines(stdout: string): any[] {
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
}
