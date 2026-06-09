import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
} from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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

  // The shared log file written by update.sh inside the docker:cli
  // container — visible to the API through the .kryptalis bind mount.
  private readonly LOG_FILE = '/app/.kryptalis/update.log';

  // Marker file the API touches before spawning update.sh, and clears
  // when it sees a clean post-update state. Survives API restart so we
  // know an update was in progress and recover correctly.
  private readonly UPDATING_MARKER = '/app/.kryptalis/.update-running';

  // In-memory state — everything the UI cares about.
  private state: {
    status: 'UP_TO_DATE' | 'UPDATE_AVAILABLE' | 'UPDATING' | 'ERROR' | 'UNKNOWN';
    message: string;
    currentSha: string | null;
    latestSha: string | null;
    branch: string;
    repo: string | null;
    lastCheckedAt: string | null;
    lastUpdatedAt: string | null;
  } = {
    status: 'UNKNOWN',
    message: 'Boot — first check pending.',
    currentSha: null,
    latestSha: null,
    branch: process.env.KRYPTALIS_BRANCH || 'main',
    repo: null,
    lastCheckedAt: null,
    lastUpdatedAt: null,
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

    // If the API was restarted by `docker compose up -d --build` during
    // an update, the marker file is still on disk. Recover gracefully.
    if (fs.existsSync(this.UPDATING_MARKER)) {
      this.state.status = 'UPDATING';
      this.state.message = 'Recovering from in-progress update…';
      this.updating = true;
      // Watch for the marker to disappear (update.sh removes it on exit)
      // OR for the log file to stop growing for > 60s (treat as done).
      this.watchUpdateCompletion();
    }

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

  /** Poll the marker + log file mtime to detect end-of-update post-restart. */
  private watchUpdateCompletion(): void {
    const tick = async () => {
      try {
        if (!fs.existsSync(this.UPDATING_MARKER)) {
          // Update done.
          const sha = await this.readCurrentSha();
          if (sha) this.state.currentSha = sha;
          this.state.lastUpdatedAt = new Date().toISOString();
          if (this.state.currentSha && this.state.currentSha === this.state.latestSha) {
            this.state.status = 'UP_TO_DATE';
            this.state.message = `Updated to ${this.short(this.state.currentSha)}.`;
          } else {
            this.state.status = 'UP_TO_DATE';
            this.state.message = `Update finished (${this.short(this.state.currentSha)}).`;
          }
          this.updating = false;
          return;
        }
        // Stale marker check: log file untouched for > 5 min → assume crashed
        if (fs.existsSync(this.LOG_FILE)) {
          const stat = fs.statSync(this.LOG_FILE);
          if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
            this.state.status = 'ERROR';
            this.state.message = 'Update appears stuck. Check the log.';
            this.updating = false;
            try { fs.unlinkSync(this.UPDATING_MARKER); } catch {}
            return;
          }
        }
        setTimeout(tick, 2000);
      } catch (e) {
        this.logger.warn(`watchUpdateCompletion: ${(e as Error).message}`);
        setTimeout(tick, 2000);
      }
    };
    setTimeout(tick, 2000);
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
    try {
      if (fs.existsSync(this.LOG_FILE)) {
        const buf = fs.readFileSync(this.LOG_FILE, 'utf-8');
        // Cap at 200 KB to protect against runaway scripts.
        return { log: buf.length > 200_000 ? buf.slice(-200_000) : buf };
      }
    } catch (e) {
      this.logger.warn(`getLog: ${(e as Error).message}`);
    }
    return { log: '' };
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

    // Touch the marker BEFORE spawning so onModuleInit can recover if
    // we get killed mid-flight when `docker compose up -d --build api`
    // (run by update.sh) tears down THIS container.
    try {
      fs.mkdirSync(path.dirname(this.UPDATING_MARKER), { recursive: true });
      fs.writeFileSync(this.UPDATING_MARKER, new Date().toISOString());
    } catch (e) {
      this.logger.warn(`could not write marker: ${(e as Error).message}`);
    }

    const installDir = this.hostInstallDir();
    const args = [
      'run', '--rm', '-d',
      '-v', `${installDir}:/app`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-w', '/app',
      'docker:cli',
      'sh', '-c',
      // Wrapper cleans the marker on exit no matter what.
      `sh /app/update.sh; rc=$?; rm -f /app/.kryptalis/.update-running; exit $rc`,
    ];

    // Fire-and-forget. Container runs on the host docker daemon — it
    // survives THIS API container being recreated by update.sh.
    const child = spawn('docker', args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    child.unref();
    child.on('error', (err) => {
      this.logger.warn(`spawn docker failed: ${err.message}`);
      this.state.status = 'ERROR';
      this.state.message = `Failed to spawn update: ${err.message}`;
      this.updating = false;
      try { fs.unlinkSync(this.UPDATING_MARKER); } catch {}
    });

    // Watch the marker file to know when the update finishes.
    this.watchUpdateCompletion();
  }

  // ── Helpers ───────────────────────────────────────────────────────

  // Path WHERE inside the API container the install dir is mounted (RO).
  // See docker-compose.yml — `.` is bind-mounted to /app/install-host:ro.
  // Falls back to a few common paths for dev / alternative setups.
  private readonly INSTALL_RO_CANDIDATES = [
    '/app/install-host',
    '/app',
    '/opt/kryptalis',
  ];

  /**
   * Resolve `<owner>/<repo>` for the install. Order:
   *   1. KRYPTALIS_GITHUB_REPO env override
   *   2. .git/config inside any of the candidate mount paths
   */
  private resolveRepo(): string | null {
    const env = process.env.KRYPTALIS_GITHUB_REPO;
    if (env) return env;

    for (const root of this.INSTALL_RO_CANDIDATES) {
      const file = path.join(root, '.git', 'config');
      try {
        if (!fs.existsSync(file)) continue;
        const conf = fs.readFileSync(file, 'utf-8');
        // url = https://github.com/owner/repo.git OR git@github.com:owner/repo.git
        const m = conf.match(/url\s*=\s*\S*github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?\s*$/im);
        if (m) return `${m[1]}/${m[2]}`;
      } catch {}
    }
    return null;
  }

  private async readCurrentSha(): Promise<string | null> {
    // Read HEAD directly off disk. Way cheaper than spawning git, and we
    // don't need a working tree — just the current commit hash.
    for (const root of this.INSTALL_RO_CANDIDATES) {
      const gitDir = path.join(root, '.git');
      try {
        if (!fs.existsSync(gitDir)) continue;
        const headFile = path.join(gitDir, 'HEAD');
        const head = fs.readFileSync(headFile, 'utf-8').trim();
        if (head.startsWith('ref: ')) {
          const ref = head.slice(5);
          const refFile = path.join(gitDir, ref);
          if (fs.existsSync(refFile)) {
            const v = fs.readFileSync(refFile, 'utf-8').trim();
            if (/^[0-9a-f]{40}$/.test(v)) return v;
          }
          // Packed refs fallback (no per-ref file after gc)
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
