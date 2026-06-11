import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { AgentService } from '../agent/agent.service';

const execFileAsync = promisify(execFile);

/**
 * Hosts considered "local" — the API process executes commands itself via
 * execFile/fs instead of delegating to an agent. Kept as a single source of
 * truth so applications.service, projects.service, databases.service and
 * anything else needing the check all agree.
 *
 * `null`/`undefined` host is also treated as local (no server attached →
 * runs in-process). Callers should use `isLocalHost(server?.host)` or the
 * DeploymentTargetService.isLocal() instance method below.
 */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'host.docker.internal',
  '::1',
]);

export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return true;
  return LOCAL_HOSTS.has(host);
}

/**
 * Minimal shape of a server we need to route. We accept anything with
 * `id` + `host` so callers can pass the same select-narrowed object they
 * already pull from prisma without having to re-query.
 */
export interface TargetServer {
  id: string;
  host: string | null | undefined;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Single abstraction over "run this on the API box" vs "tell the agent to
 * run this on a remote box". applications/projects/databases services
 * currently duplicate the LOCAL_HOSTS check + branch into two execution
 * paths — every change has to be made in three files. This service is the
 * seam to collapse that.
 *
 * NOTE: this ships the abstraction only. Migration of the three callers
 * is deliberately a separate task to avoid merge conflicts with parallel
 * work touching the same files.
 */
@Injectable()
export class DeploymentTargetService {
  private readonly logger = new Logger(DeploymentTargetService.name);

  constructor(private readonly agent: AgentService) {}

  /** Same predicate every caller has been re-implementing. */
  isLocal(server: TargetServer | null | undefined): boolean {
    if (!server) return true;
    return isLocalHost(server.host);
  }

  /**
   * Run an arbitrary command on the target. Locally this is a direct
   * execFile; on a remote agent it's enqueued as an EXEC task and awaited.
   * Output is normalized to { stdout, stderr, code } in both branches so
   * callers don't have to differentiate.
   */
  async execute(
    server: TargetServer | null,
    command: string,
    args: string[],
    opts: ExecOpts = {},
  ): Promise<ExecResult> {
    if (this.isLocal(server)) {
      try {
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? 300_000,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          maxBuffer: 50 * 1024 * 1024,
        });
        return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 };
      } catch (err: any) {
        // execFile rejects on non-zero exit; surface stdout/stderr so callers
        // can decide if they care (e.g. `docker rm -f` of a missing container).
        return {
          stdout: String(err?.stdout ?? ''),
          stderr: String(err?.stderr ?? err?.message ?? ''),
          code: typeof err?.code === 'number' ? err.code : 1,
        };
      }
    }
    // Remote: enqueue an EXEC task and await its terminal state.
    const task = await this.agent.enqueueAndWait(
      server!.id,
      'EXEC',
      { command, args, cwd: opts.cwd, env: opts.env },
      opts.timeoutMs ?? 300_000,
    );
    const r: any = task.result || {};
    return {
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? task.error ?? ''),
      code: typeof r.code === 'number' ? r.code : (task.status === 'FAILED' ? 1 : 0),
    };
  }

  /**
   * `docker compose up -d --remove-orphans` in `dir`. Returns the normalized
   * exec result on local; on remote, fires a START task.
   *
   * `remote` carries the slug(s) the agent resolves its own app dir from
   * (/opt/kryptalis/apps/<slug>) — the agent reads payload.slug, NOT a dir
   * path. Passing {dir} here used to fail every remote lifecycle op with
   * "missing slug": the local dir path means nothing on the agent's disk.
   * `legacySlug` covers apps deployed before the per-instance convention.
   */
  async composeUp(
    server: TargetServer | null,
    dir: string,
    remote?: { slug: string; legacySlug?: string },
  ): Promise<ExecResult> {
    if (this.isLocal(server)) {
      return this.execute(server, 'docker', ['compose', 'up', '-d', '--remove-orphans'], {
        cwd: dir,
        timeoutMs: 180_000,
      });
    }
    const task = await this.agent.enqueueAndWait(
      server!.id,
      'START',
      { slug: remote?.slug, legacySlug: remote?.legacySlug },
      180_000,
    );
    return this.taskToExec(task);
  }

  /**
   * `docker compose down [-v] --remove-orphans`. `purgeVolumes=true` deletes
   * named volumes (destructive — only call on full removal flows).
   */
  async composeDown(
    server: TargetServer | null,
    dir: string,
    purgeVolumes = false,
    remote?: { slug: string; legacySlug?: string },
  ): Promise<ExecResult> {
    const args = ['compose', 'down'];
    if (purgeVolumes) args.push('-v');
    args.push('--remove-orphans');
    if (this.isLocal(server)) {
      return this.execute(server, 'docker', args, { cwd: dir, timeoutMs: 120_000 });
    }
    const task = await this.agent.enqueueAndWait(
      server!.id,
      'REMOVE',
      { slug: remote?.slug, legacySlug: remote?.legacySlug, purgeVolumes },
      120_000,
    );
    return this.taskToExec(task);
  }

  /**
   * `docker compose stop` — stops services without removing containers or
   * volumes. Distinct from composeDown (which tears down containers and,
   * with purgeVolumes, deletes named volumes). Used by the "Stop" lifecycle
   * button so the user can hit "Start" later without redeploying.
   */
  async composeStop(
    server: TargetServer | null,
    dir: string,
    remote?: { slug: string; legacySlug?: string },
  ): Promise<ExecResult> {
    if (this.isLocal(server)) {
      return this.execute(server, 'docker', ['compose', 'stop'], {
        cwd: dir,
        timeoutMs: 120_000,
      });
    }
    const task = await this.agent.enqueueAndWait(
      server!.id,
      'STOP',
      { slug: remote?.slug, legacySlug: remote?.legacySlug },
      120_000,
    );
    return this.taskToExec(task);
  }

  async composeRestart(
    server: TargetServer | null,
    dir: string,
    remote?: { slug: string; legacySlug?: string },
  ): Promise<ExecResult> {
    if (this.isLocal(server)) {
      return this.execute(server, 'docker', ['compose', 'restart'], {
        cwd: dir,
        timeoutMs: 120_000,
      });
    }
    const task = await this.agent.enqueueAndWait(
      server!.id,
      'RESTART',
      { slug: remote?.slug, legacySlug: remote?.legacySlug },
      120_000,
    );
    return this.taskToExec(task);
  }

  /**
   * Write `content` to `path` on the target. Parent dirs are created
   * recursively on local; the agent's FILE_WRITE handler is expected to do
   * the same on remote.
   */
  async writeFile(
    server: TargetServer | null,
    filePath: string,
    content: string | Buffer,
  ): Promise<void> {
    if (this.isLocal(server)) {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content);
      return;
    }
    // Remote writes are quick — but we still wait so callers can sequence
    // (write compose, then compose up) without races.
    await this.agent.enqueueAndWait(
      server!.id,
      'FILE_WRITE',
      {
        path: filePath,
        content: typeof content === 'string' ? content : content.toString('base64'),
        encoding: typeof content === 'string' ? 'utf8' : 'base64',
      },
      60_000,
    );
  }

  async removeFile(server: TargetServer | null, filePath: string): Promise<void> {
    if (this.isLocal(server)) {
      await fs.promises.rm(filePath, { force: true });
      return;
    }
    await this.agent.enqueueAndWait(
      server!.id,
      'EXEC',
      { command: 'rm', args: ['-f', filePath] },
      30_000,
    );
  }

  async removeDir(
    server: TargetServer | null,
    dirPath: string,
    force = true,
  ): Promise<void> {
    if (this.isLocal(server)) {
      await fs.promises.rm(dirPath, { recursive: true, force });
      return;
    }
    await this.agent.enqueueAndWait(
      server!.id,
      'EXEC',
      { command: 'rm', args: force ? ['-rf', dirPath] : ['-r', dirPath] },
      60_000,
    );
  }

  /** Normalize an agent task result into the same ExecResult shape. */
  private taskToExec(task: { status: string; result: any; error: string | null }): ExecResult {
    const r: any = task.result || {};
    return {
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? task.error ?? ''),
      code: typeof r.code === 'number' ? r.code : (task.status === 'FAILED' ? 1 : 0),
    };
  }
}
