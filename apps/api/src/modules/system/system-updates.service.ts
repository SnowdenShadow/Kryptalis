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
 *
 * CRITICAL: the install dir is mounted at the SAME absolute path inside
 * the updater container as on the host (`-v <dir>:<dir> -w <dir>`), never
 * at /app. The compose file interpolates ${PWD} (fallback for
 * DOCKCONTROL_HOST_*_DIR) and resolves relative bind-mount sources against
 * the cwd — and the HOST docker daemon resolves those paths against the
 * HOST filesystem. Mounting at /app used to make `docker compose up`
 * recreate the stack under project name "app" with fresh empty volumes
 * (apparent data loss) and bind-mounts pointing at a nonexistent host
 * /app — bricking the install. Same-path mount + `name: dockcontrol` in
 * docker-compose.yml make the update path-stable.
 */
@Injectable()
export class SystemUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemUpdatesService.name);

  // Polling cadence. 60s = 60 calls/h, right at GitHub's anonymous limit.
  // The ETag cache below means most calls return 304 and don't count
  // toward the quota anyway.
  private readonly POLL_INTERVAL_MS = 60_000;

  // Unattended auto-APPLY is OFF by default. Polling/checking always runs
  // (so the dashboard can show "update available"), but actually running
  // update.sh — which does `git reset --hard origin/<branch>` + rebuild with
  // the host docker socket, i.e. root-equivalent code execution from whatever
  // is at the branch tip, with no commit-signature verification — only happens
  // automatically when the operator explicitly opts in. Otherwise a single
  // push to (or compromise of) the tracked branch would be fleet-wide root RCE
  // within ~60s. With auto-apply off, a detected update is surfaced as
  // UPDATE_AVAILABLE and applied only when the operator clicks "update now"
  // (forceUpdate()), after reviewing the diff/SHA.
  private readonly autoApply =
    (process.env.DOCKCONTROL_AUTO_UPDATE || '').toLowerCase() === 'true';

  private timer: NodeJS.Timeout | null = null;

  // The shared log file written by update.sh inside the docker:cli
  // container — visible to the API through the .dockcontrol bind mount.
  private readonly LOG_FILE = '/app/.dockcontrol/update.log';

  // Image for the one-off updater container. Pinned to a specific Docker CLI
  // version tag instead of the floating `docker:cli` so a re-pull can't fetch
  // arbitrarily-changed bytes for a container that holds the host docker
  // socket. Override with DOCKCONTROL_UPDATER_IMAGE (e.g. to a @sha256 digest).
  private readonly UPDATER_IMAGE =
    process.env.DOCKCONTROL_UPDATER_IMAGE || 'docker:27-cli';

  // Marker file the API touches before spawning update.sh, and clears
  // when it sees a clean post-update state. Survives API restart so we
  // know an update was in progress and recover correctly.
  private readonly UPDATING_MARKER = '/app/.dockcontrol/.update-running';

  // Result file the update wrapper writes update.sh's exit code into BEFORE
  // removing the marker. The watcher reads it to tell a real success (rc==0)
  // apart from a failed update — the marker disappearing on its own only
  // proves the wrapper ran, not that the update succeeded.
  private readonly RESULT_FILE = '/app/.dockcontrol/.update-result';

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
    branch: process.env.DOCKCONTROL_BRANCH || 'main',
    repo: null,
    lastCheckedAt: null,
    lastUpdatedAt: null,
  };

  // ETag cache so repeated polls of GitHub return 304 and don't burn quota.
  private cachedEtag: string | null = null;

  // Mutex so the webhook AND the polling loop AND the manual button can't
  // all run update.sh at the same time.
  private updating = false;

  // Guard so watchUpdateCompletion() never runs two concurrent tickers (the
  // spawn path and the boot-recovery path could otherwise both poll the marker
  // and race readUpdateResult()+unlink — flipping a real rc==0 into ERROR).
  private watching = false;

  // The latest SHA an update FAILED on. While latestSha still equals this, we
  // report ERROR (not UP_TO_DATE, even though the new code is on disk) and do
  // NOT auto-re-run — otherwise a commit with a broken build/migration would
  // be retried every 60s forever, and a half-updated install would masquerade
  // as up to date. Cleared when a NEW commit appears or on a manual forceUpdate.
  private lastFailedSha: string | null = null;

  // Hard ceiling on how long an update may run before the watcher treats a
  // still-present marker as a dead updater. The wrapper's own
  // `up -d --wait --wait-timeout 300` bounds the run, so this is a backstop for
  // the case where the whole docker:cli container died (OOM, daemon restart)
  // without ever clearing the marker. Generous because build + image pull on a
  // small VPS can legitimately take many minutes — keyed off the MARKER's mtime
  // (a true wall-clock age of the whole run), NOT the log mtime (which stalls
  // for minutes during a single long `RUN`/`pull` layer and used to trigger a
  // false "stuck" → a SECOND concurrent updater).
  private readonly MAX_UPDATE_MS = 30 * 60 * 1000;

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
      // Watch for the marker to disappear (the wrapper removes it on exit, after
      // recording the rc) OR for the run to exceed MAX_UPDATE_MS (dead updater).
      this.watchUpdateCompletion();
    }

    if (!this.state.repo) {
      this.logger.warn(
        'DOCKCONTROL_GITHUB_REPO not set and origin remote unresolved — auto-update disabled.',
      );
      this.state.status = 'ERROR';
      this.state.message = 'Repo unresolved — set DOCKCONTROL_GITHUB_REPO.';
      return;
    }

    this.logger.log(
      `Auto-update: tracking ${this.state.repo}@${this.state.branch}, polling every ${this.POLL_INTERVAL_MS / 1000}s ` +
        `(${this.autoApply ? 'AUTO-APPLY on' : 'check-only — apply from dashboard'}).`,
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

  /**
   * Read the wrapper's recorded exit code, if it has been written. Returns
   * the rc, or null when the result file is absent/unparseable (treated as
   * "no verdict yet"). Cleared after consumption so a stale rc from a prior
   * run can't poison the next update.
   */
  private readUpdateResult(): number | null {
    try {
      if (!fs.existsSync(this.RESULT_FILE)) return null;
      const raw = fs.readFileSync(this.RESULT_FILE, 'utf-8').trim();
      if (!/^-?\d+$/.test(raw)) return null;
      return Number(raw);
    } catch {
      return null;
    }
  }

  /**
   * Poll the marker file to detect end-of-update post-restart. Idempotent: a
   * second invocation (e.g. boot recovery firing while the spawn-path watcher
   * still runs) returns immediately, so only ONE ticker ever races the
   * marker-gone → readUpdateResult()+unlink path.
   */
  private watchUpdateCompletion(): void {
    if (this.watching) return;
    this.watching = true;
    const stop = () => { this.watching = false; };
    const tick = async () => {
      try {
        if (!fs.existsSync(this.UPDATING_MARKER)) {
          // Wrapper finished. Trust the recorded exit code over the bare
          // marker removal: rc==0 → success, rc!=0 → the update actually
          // failed and we must surface it rather than reporting UP_TO_DATE.
          const rc = this.readUpdateResult();
          const sha = await this.readCurrentSha();
          if (sha) this.state.currentSha = sha;
          this.state.lastUpdatedAt = new Date().toISOString();
          // Fail CLOSED: success is claimed ONLY on an explicit rc==0. A
          // missing/unparseable result (rc===null) means the wrapper never
          // recorded a verdict — update.sh was killed, the disk filled, or
          // the marker was cleared out-of-band — so we surface ERROR rather
          // than falsely reporting UP_TO_DATE while stale code keeps running.
          if (rc === 0) {
            // Clean success — drop any sticky failure for this SHA.
            this.lastFailedSha = null;
            this.state.status = 'UP_TO_DATE';
            this.state.message =
              this.state.currentSha && this.state.currentSha === this.state.latestSha
                ? `Updated to ${this.short(this.state.currentSha)}.`
                : `Update finished (${this.short(this.state.currentSha)}).`;
          } else {
            // Remember the SHA we tried to reach so poll() stays ERROR and does
            // NOT auto-re-run it every tick (broken-commit retry loop) and does
            // not flip to UP_TO_DATE just because the new SHA is now on disk.
            this.lastFailedSha = this.state.latestSha;
            this.state.status = 'ERROR';
            this.state.message =
              rc !== null
                ? `Update failed (exit ${rc}). Check the log.`
                : 'Update ended without recording a result — it may have failed. Check the log.';
          }
          // Consume the result so the next run starts from a clean slate.
          try { fs.unlinkSync(this.RESULT_FILE); } catch {}
          this.updating = false;
          stop();
          return;
        }
        // Dead-updater backstop: key off the MARKER's own mtime (true wall-clock
        // age of the run), NOT the log mtime. The log stalls for minutes during
        // a single long build/pull layer, which used to trip a 5-min "stuck"
        // check and spawn a SECOND concurrent updater. The marker is written
        // once at run start and never touched again, so its age is the honest
        // run duration. Only the genuine case — the whole updater container died
        // without clearing the marker — trips this.
        try {
          const markerAge = Date.now() - fs.statSync(this.UPDATING_MARKER).mtimeMs;
          if (markerAge > this.MAX_UPDATE_MS) {
            this.lastFailedSha = this.state.latestSha;
            this.state.status = 'ERROR';
            this.state.message = 'Update appears stuck (updater did not finish). Check the log.';
            this.updating = false;
            try { fs.unlinkSync(this.UPDATING_MARKER); } catch {}
            stop();
            return;
          }
        } catch {
          // Marker vanished between existsSync and statSync — next tick handles it.
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
    // Manual retry overrides the sticky-failure guard: the operator has chosen
    // to try again (presumably after fixing the cause), so don't let a prior
    // lastFailedSha short-circuit this run.
    this.lastFailedSha = null;
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
      'User-Agent': 'dockcontrol-self-update',
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

    // A SHA that just failed to update stays ERROR — even if `git reset` already
    // landed it on disk (currentSha === sha) so it would otherwise read as
    // "up to date". Keeps the dashboard honest about a half-updated/broken
    // install and stops the 60s auto-retry loop on a known-bad commit. Cleared
    // automatically once a NEWER commit appears (sha !== lastFailedSha below),
    // or by a manual forceUpdate().
    if (this.lastFailedSha && sha === this.lastFailedSha) {
      this.state.status = 'ERROR';
      this.state.message =
        `Last update to ${this.short(sha)} failed. Fix the cause and retry from the dashboard, or push a new commit.`;
      return;
    }

    if (this.state.currentSha === sha) {
      this.state.status = 'UP_TO_DATE';
      this.state.message = `Up to date on ${this.state.branch} (${this.short(sha)}).`;
      return;
    }

    // A genuinely newer commit supersedes any prior failure — allow it to run.
    this.lastFailedSha = null;

    // New commit available.
    this.state.status = 'UPDATE_AVAILABLE';
    this.state.message = `New commit on ${this.state.branch} (${this.short(sha)}).`;

    if (!this.autoApply) {
      // Check-only mode (default). Surface the available update but DO NOT
      // apply it unattended — the operator applies from the dashboard after
      // reviewing it. This is the safe default; see `autoApply` above.
      this.logger.log(
        `Update available: ${this.short(this.state.currentSha)} → ${this.short(sha)}. ` +
          `Auto-apply is disabled — apply it from the dashboard (set ` +
          `DOCKCONTROL_AUTO_UPDATE=true to apply automatically).`,
      );
      return;
    }

    this.logger.log(
      `Update available: ${this.short(this.state.currentSha)} → ${this.short(sha)}. ` +
        `Auto-apply enabled — running update.sh.`,
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
      // Seed the log file NOW so it always exists for the dashboard tail even if
      // the docker:cli updater never starts (image pull fails, daemon restart,
      // OOM) and never reaches update.sh's own `date > LOG_FILE`. The watcher's
      // backstop keys off the MARKER mtime, not the log, so recovery no longer
      // depends on the log existing — but a present log keeps the UI from
      // showing an empty panel during the window before update.sh writes.
      try { fs.writeFileSync(this.LOG_FILE, `[${new Date().toISOString()}] update queued…\n`); } catch {}
      // Drop any stale result from a prior run so the watcher can't read an
      // old rc before the wrapper records this run's.
      try { fs.unlinkSync(this.RESULT_FILE); } catch {}
    } catch (e) {
      this.logger.warn(`could not write marker: ${(e as Error).message}`);
    }

    // HOST path of the install dir. Mount it at the SAME path inside the
    // updater container so the host docker daemon resolves the compose
    // file's relative bind mounts and ${PWD} fallbacks against the real
    // install dir (see class doc above). DOCKCONTROL_DIR pins update.sh's
    // INSTALL_DIR to the same value (belt + braces with `-w`).
    const installDir = this.hostInstallDir();
    const args = [
      'run', '--rm', '-d',
      '-v', `${installDir}:${installDir}`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-w', installDir,
      '-e', `DOCKCONTROL_DIR=${installDir}`,
      '-e', `DOCKCONTROL_BRANCH=${this.state.branch}`,
      this.UPDATER_IMAGE,
      'sh', '-c',
      // Wrapper records update.sh's exit code to the result file BEFORE
      // clearing the marker, then removes the marker so the lock releases no
      // matter what. The watcher keys success off the recorded rc — the
      // marker disappearing alone proves only that the wrapper ran. Paths are
      // double-quoted in case the install dir contains spaces.
      `sh "${installDir}/update.sh"; rc=$?; echo "$rc" > "${installDir}/.dockcontrol/.update-result"; rm -f "${installDir}/.dockcontrol/.update-running"; exit $rc`,
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
    '/opt/dockcontrol',
  ];

  /**
   * Resolve `<owner>/<repo>` for the install. Order:
   *   1. DOCKCONTROL_GITHUB_REPO env override
   *   2. .git/config inside any of the candidate mount paths
   */
  private resolveRepo(): string | null {
    const env = process.env.DOCKCONTROL_GITHUB_REPO;
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
    return process.env.DOCKCONTROL_HOST_INSTALL_DIR
      || process.env.DOCKCONTROL_HOST_DATA_DIR?.replace(/[\\/]\.dockcontrol[\\/]*$/, '')
      || '/opt/dockcontrol';
  }

  private short(sha: string | null): string {
    return sha ? sha.slice(0, 7) : '?';
  }
}
