import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
} from '@nestjs/common';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

/**
 * Self-update.
 *
 * One mechanism, no surprises:
 *
 *   1. Every 60s, poll GitHub for the latest commit on the tracked branch.
 *      The API endpoint /repos/{owner}/{repo}/commits/{branch} works on
 *      public repos with no auth at all (60 req/h per IP — checking every
 *      minute is 60/h, sits right at the limit with zero margin → we cache
 *      via ETag so 304 responses don't burn quota).
 *
 *   2. If the latest SHA differs from the SHA we have on disk → run
 *      `update.sh` on the host (git pull + docker compose up -d --build).
 *
 *   3. State lives in memory. No status files, no preference files, no
 *      systemd timer to babysit. A restart re-reads the on-disk SHA at
 *      boot and we're back in sync.
 *
 * That's the whole feature. No webhook. No OAuth requirement. No
 * `update-status.json` parsed by bash. No `auto-update.pref`. No
 * containerized `alpine/git` calls. No `manualTriggerAvailable` probe.
 *
 * The script is invoked via the host docker socket (mounted into the API
 * container). We spawn a one-off `docker:cli` container that mounts the
 * install dir + the host docker socket so it can run `docker compose` on
 * the host daemon. The script itself is plain sh — no systemd, no
 * self-heal, no rewriting timer units.
 */
@Injectable()
export class SystemUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemUpdatesService.name);

  // Polling cadence. 60s = 60 calls/h, right at GitHub's anonymous limit.
  // The ETag cache below means most calls return 304 and don't count
  // toward the quota anyway.
  private readonly POLL_INTERVAL_MS = 60_000;

  private timer: NodeJS.Timeout | null = null;

  // In-memory state — everything the UI cares about. No files, no DB.
  private state: {
    status: 'UP_TO_DATE' | 'UPDATE_AVAILABLE' | 'UPDATING' | 'ERROR' | 'UNKNOWN';
    message: string;
    currentSha: string | null;
    latestSha: string | null;
    branch: string;
    repo: string | null;
    lastCheckedAt: string | null;
    lastUpdatedAt: string | null;
    updateLog: string[];
  } = {
    status: 'UNKNOWN',
    message: 'Boot — first check pending.',
    currentSha: null,
    latestSha: null,
    branch: process.env.KRYPTALIS_BRANCH || 'main',
    repo: null,
    lastCheckedAt: null,
    lastUpdatedAt: null,
    updateLog: [],
  };

  // ETag cache so repeated polls of GitHub return 304 and don't burn quota.
  private cachedEtag: string | null = null;

  // Mutex so the webhook AND the polling loop AND the manual button can't
  // all run update.sh at the same time.
  private updating = false;

  // ── Lifecycle ─────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    this.state.repo = this.resolveRepo();
    this.state.currentSha = await this.readCurrentSha();

    if (!this.state.repo) {
      this.logger.warn(
        'KRYPTALIS_GITHUB_REPO not set and origin remote unresolved — auto-update disabled.',
      );
      this.state.status = 'ERROR';
      this.state.message = 'Repo unresolved — set KRYPTALIS_GITHUB_REPO.';
      return;
    }

    this.logger.log(
      `Auto-update: tracking ${this.state.repo}@${this.state.branch}, polling every ${this.POLL_INTERVAL_MS / 1000}s.`,
    );

    // Kick off an immediate check, then schedule.
    void this.poll().catch((e) =>
      this.logger.warn(`first poll failed: ${e?.message || e}`),
    );
    this.timer = setInterval(
      () => void this.poll().catch((e) =>
        this.logger.warn(`poll failed: ${e?.message || e}`),
      ),
      this.POLL_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  getStatus() {
    return {
      status: this.state.status,
      message: this.state.message,
      currentSha: this.state.currentSha,
      latestSha: this.state.latestSha,
      branch: this.state.branch,
      repo: this.state.repo,
      lastCheckedAt: this.state.lastCheckedAt,
      lastUpdatedAt: this.state.lastUpdatedAt,
      pollIntervalSec: this.POLL_INTERVAL_MS / 1000,
    };
  }

  getLog(): { log: string } {
    return { log: this.state.updateLog.join('') };
  }

  async forceCheck() {
    await this.poll();
    return this.getStatus();
  }

  async forceUpdate(): Promise<{ message: string }> {
    if (this.updating) {
      return { message: 'An update is already running.' };
    }
    if (!this.state.repo) {
      throw new BadRequestException('No repo configured.');
    }
    void this.runUpdate().catch((e) =>
      this.logger.warn(`forced update failed: ${e?.message || e}`),
    );
    return { message: 'Update started.' };
  }

  // ── Polling loop ──────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.state.repo) return;
    if (this.updating) return; // a run is already in progress

    const url = `https://api.github.com/repos/${this.state.repo}/commits/${this.state.branch}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kryptalis-self-update',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.cachedEtag) headers['If-None-Match'] = this.cachedEtag;

    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e: any) {
      this.state.status = 'ERROR';
      this.state.message = `GitHub unreachable: ${e?.message || e}`;
      this.state.lastCheckedAt = new Date().toISOString();
      return;
    }

    this.state.lastCheckedAt = new Date().toISOString();

    if (res.status === 304) {
      // No change since last check — leave state untouched, just refresh
      // current SHA from disk in case a manual git pull happened.
      const onDisk = await this.readCurrentSha();
      if (onDisk && onDisk !== this.state.currentSha) {
        this.state.currentSha = onDisk;
      }
      if (this.state.latestSha && this.state.currentSha === this.state.latestSha) {
        this.state.status = 'UP_TO_DATE';
        this.state.message = `Up to date on ${this.state.branch} (${this.short(this.state.currentSha)}).`;
      }
      return;
    }

    if (!res.ok) {
      this.state.status = 'ERROR';
      const body = await res.text().catch(() => '');
      this.state.message = `GitHub ${res.status}: ${body.slice(0, 200) || 'unknown error'}`;
      return;
    }

    const etag = res.headers.get('etag');
    if (etag) this.cachedEtag = etag;

    const data: any = await res.json();
    const sha: string = data?.sha;
    if (!sha) {
      this.state.status = 'ERROR';
      this.state.message = 'GitHub response missing sha.';
      return;
    }

    this.state.latestSha = sha;

    // Refresh on-disk SHA in case of out-of-band change.
    const onDisk = await this.readCurrentSha();
    if (onDisk) this.state.currentSha = onDisk;

    if (!this.state.currentSha) {
      // First boot — adopt whatever's on disk as "current". Without this
      // we'd loop-update on every poll because currentSha stays null.
      this.state.currentSha = sha;
      this.state.status = 'UP_TO_DATE';
      this.state.message = `First boot — adopted ${this.short(sha)}.`;
      return;
    }

    if (this.state.currentSha === sha) {
      this.state.status = 'UP_TO_DATE';
      this.state.message = `Up to date on ${this.state.branch} (${this.short(sha)}).`;
      return;
    }

    // New commit available → run the update.
    this.state.status = 'UPDATE_AVAILABLE';
    this.state.message = `New commit on ${this.state.branch} (${this.short(sha)}).`;
    this.logger.log(
      `Update available: ${this.short(this.state.currentSha)} → ${this.short(sha)}. Running update.sh.`,
    );
    void this.runUpdate().catch((e) =>
      this.logger.warn(`update run failed: ${e?.message || e}`),
    );
  }

  // ── Running update.sh ─────────────────────────────────────────────

  private async runUpdate(): Promise<void> {
    if (this.updating) return;
    this.updating = true;
    this.state.status = 'UPDATING';
    this.state.message = 'Pulling and rebuilding…';
    this.state.updateLog = [];

    const installDir = this.hostInstallDir();
    const args = [
      'run', '--rm',
      '-v', `${installDir}:/app`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-w', '/app',
      'docker:cli',
      'sh', '/app/update.sh',
    ];

    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onData = (buf: Buffer) => {
      const text = buf.toString('utf-8');
      this.state.updateLog.push(text);
      // Cap log so it doesn't grow forever on a broken update loop.
      if (this.state.updateLog.length > 2000) {
        this.state.updateLog.splice(0, this.state.updateLog.length - 2000);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    await new Promise<void>((resolve) => {
      child.on('exit', async (code) => {
        const onDisk = await this.readCurrentSha();
        if (code === 0) {
          this.state.currentSha = onDisk || this.state.latestSha;
          this.state.lastUpdatedAt = new Date().toISOString();
          if (this.state.currentSha === this.state.latestSha) {
            this.state.status = 'UP_TO_DATE';
            this.state.message = `Updated to ${this.short(this.state.currentSha)}.`;
          } else {
            this.state.status = 'UPDATE_AVAILABLE';
            this.state.message = `Update finished but SHA mismatch — re-running on next poll.`;
          }
        } else {
          this.state.status = 'ERROR';
          this.state.message = `update.sh exited with code ${code}. See log.`;
        }
        this.updating = false;
        resolve();
      });
      child.on('error', (err) => {
        this.state.status = 'ERROR';
        this.state.message = `Failed to spawn update.sh: ${err.message}`;
        this.updating = false;
        resolve();
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /**
   * Resolve `<owner>/<repo>` for the install. Order:
   *   1. KRYPTALIS_GITHUB_REPO env override
   *   2. .git/config inside the install dir (mounted into the container)
   */
  private resolveRepo(): string | null {
    const env = process.env.KRYPTALIS_GITHUB_REPO;
    if (env) return env;

    // The install dir is bind-mounted into the API container at the same
    // path it lives on the host (see docker-compose.yml). Read .git/config
    // directly — no `docker run alpine/git` shenanigans.
    const candidates = [
      // Most common: install dir bind-mounted at a known path
      process.env.KRYPTALIS_HOST_INSTALL_DIR && path.join(process.env.KRYPTALIS_HOST_INSTALL_DIR, '.git', 'config'),
      '/app/.git/config',
      '/opt/kryptalis/.git/config',
    ].filter(Boolean) as string[];

    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const conf = fs.readFileSync(file, 'utf-8');
        const m = conf.match(/url\s*=\s*([^\n]+github\.com[:/][^/]+\/[^/.\s]+)/);
        if (m) {
          const owner = m[1].match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
          if (owner) return `${owner[1]}/${owner[2]}`;
        }
      } catch {}
    }
    return null;
  }

  private async readCurrentSha(): Promise<string | null> {
    // Read HEAD directly off disk. Way cheaper than spawning git, and we
    // don't need a working tree — just the current commit hash.
    const candidates = [
      process.env.KRYPTALIS_HOST_INSTALL_DIR && path.join(process.env.KRYPTALIS_HOST_INSTALL_DIR, '.git'),
      '/app/.git',
      '/opt/kryptalis/.git',
    ].filter(Boolean) as string[];

    for (const gitDir of candidates) {
      try {
        if (!fs.existsSync(gitDir)) continue;
        const headFile = path.join(gitDir, 'HEAD');
        const head = fs.readFileSync(headFile, 'utf-8').trim();
        if (head.startsWith('ref: ')) {
          const ref = head.slice(5);
          const refFile = path.join(gitDir, ref);
          if (fs.existsSync(refFile)) {
            return fs.readFileSync(refFile, 'utf-8').trim();
          }
          // Packed refs fallback
          const packed = path.join(gitDir, 'packed-refs');
          if (fs.existsSync(packed)) {
            const lines = fs.readFileSync(packed, 'utf-8').split('\n');
            const hit = lines.find((l) => l.endsWith(' ' + ref));
            if (hit) return hit.split(' ')[0];
          }
        } else if (/^[0-9a-f]{40}$/.test(head)) {
          return head; // detached HEAD
        }
      } catch {}
    }

    // Last resort: ask `git` if it's on PATH (it usually isn't inside
    // the API container, but worth a shot for dev).
    try {
      const dir = process.env.KRYPTALIS_HOST_INSTALL_DIR || '/opt/kryptalis';
      const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 5_000 });
      const sha = stdout.trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    } catch {}

    return null;
  }

  private hostInstallDir(): string {
    return process.env.KRYPTALIS_HOST_INSTALL_DIR
      || process.env.KRYPTALIS_HOST_DATA_DIR?.replace(/[\\/]\.kryptalis[\\/]*$/, '')
      || '/opt/kryptalis';
  }

  private short(sha: string | null): string {
    return sha ? sha.slice(0, 7) : '?';
  }
}
