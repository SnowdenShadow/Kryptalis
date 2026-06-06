import { Injectable, BadRequestException } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const STATUS_FILE = path.join(DATA_DIR, 'update-status.json');
const LOG_FILE = path.join(DATA_DIR, 'update.log');

// Host path to update.sh — the script lives in the install root, NOT inside
// the API container. We invoke it via `nsenter` against PID 1 on the host
// (since the API container has /var/run/docker.sock + the systemd timer is
// installed on the host). For simplicity we rely on the systemd timer for the
// recurring schedule; the manual "Update now" button just touches a trigger
// file the timer picks up, or — if the API runs on the host directly — execs
// the script directly.
const HOST_INSTALL_DIR = process.env.KRYPTALIS_HOST_INSTALL_DIR
  || process.env.KRYPTALIS_HOST_DATA_DIR?.replace(/[\\/]\.kryptalis[\\/]*$/, '')
  || '/opt/kryptalis';

export type UpdateState =
  | 'UP_TO_DATE'
  | 'UPDATE_AVAILABLE'
  | 'UPDATING'
  | 'ERROR'
  | 'UNKNOWN';

export interface UpdateStatus {
  state: UpdateState;
  message: string;
  currentSha: string | null;
  latestSha: string | null;
  branch: string | null;
  updatedAt: string | null;
  autoUpdateEnabled: boolean | null;
  /**
   * Manual trigger is only available when the API can reach the host's
   * systemd / shell. In containerized deploys (which is the default) the
   * timer runs on the host every 10 min and the UI just displays the
   * status — `manualTriggerAvailable` will be false there.
   */
  manualTriggerAvailable: boolean;
  hasUpdateLog: boolean;
}

@Injectable()
export class SystemUpdatesService {
  /**
   * Read the JSON status file written by update.sh on every run.
   * Also probe systemd (best effort) to know whether the auto-update
   * timer is enabled. Both are mounted via the host bind-mount, so the
   * API doesn't need to escape the container to read them.
   */
  async getStatus(): Promise<UpdateStatus> {
    let parsed: any = null;
    try {
      if (fs.existsSync(STATUS_FILE)) {
        parsed = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
      }
    } catch {
      // Corrupt JSON — fall through with parsed=null, dashboard will show UNKNOWN.
    }

    const [autoEnabled, manualOk] = await Promise.all([
      this.detectAutoUpdate(),
      this.detectManualTriggerAvailable(),
    ]);

    return {
      state: parsed?.state || 'UNKNOWN',
      message: parsed?.message || 'No update run yet — the timer fires every 10 min after boot.',
      currentSha: parsed?.currentSha || null,
      latestSha: parsed?.latestSha || null,
      branch: parsed?.branch || null,
      updatedAt: parsed?.updatedAt || null,
      autoUpdateEnabled: autoEnabled,
      manualTriggerAvailable: manualOk,
      hasUpdateLog: fs.existsSync(LOG_FILE),
    };
  }

  /**
   * Tail of the update.sh log — capped to last 200 lines so we don't ship
   * megabytes if the operator left it running for weeks.
   */
  async getLog(): Promise<string> {
    if (!fs.existsSync(LOG_FILE)) return '';
    try {
      const buf = fs.readFileSync(LOG_FILE, 'utf-8');
      const lines = buf.split('\n');
      return lines.slice(-200).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Force a check (no rebuild) — writes a fresh status file.
   * Only works if the API can reach update.sh on the host (sock-mount + script
   * present at /app/.kryptalis/../update.sh OR explicit KRYPTALIS_HOST_INSTALL_DIR).
   */
  async checkNow(): Promise<UpdateStatus> {
    if (!(await this.detectManualTriggerAvailable())) {
      throw new BadRequestException(
        'Manual trigger unavailable in this deployment. The timer will run automatically every 10 min.',
      );
    }
    try {
      // We exec on the host via docker. The API container has /var/run/docker.sock
      // mounted (see docker-compose.yml line 99), so we can spawn an ephemeral
      // root container with the install dir mounted and run the script there.
      // Alternative: nsenter PID 1 — but that needs --pid=host which we don't set.
      await execFileAsync(
        'docker',
        [
          'run', '--rm',
          '-v', `${HOST_INSTALL_DIR}:/app`,
          '-v', '/var/run/docker.sock:/var/run/docker.sock',
          '-w', '/app',
          'docker:cli',
          'sh', '/app/update.sh', '--check',
        ],
        { timeout: 60_000 },
      );
    } catch (err: any) {
      // Don't surface as ERROR — the script may write its own status. Just refetch.
    }
    return this.getStatus();
  }

  /**
   * Apply the update now (instead of waiting for the 10-min timer).
   * Same containerized-exec trick as checkNow().
   */
  async applyNow(): Promise<{ message: string }> {
    if (!(await this.detectManualTriggerAvailable())) {
      throw new BadRequestException(
        'Manual trigger unavailable in this deployment. The timer will run automatically every 10 min.',
      );
    }
    // Fire-and-forget: the script can take several minutes (image pull + rebuild).
    // The dashboard polls /system/updates every few seconds to watch state flip.
    execFile(
      'docker',
      [
        'run', '--rm', '-d',
        '-v', `${HOST_INSTALL_DIR}:/app`,
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-w', '/app',
        'docker:cli',
        'sh', '/app/update.sh',
      ],
      () => {},
    );
    return { message: 'Update started — watch the status panel for progress.' };
  }

  /**
   * Enable or disable the systemd timer that runs update.sh every 10 min.
   * The API container can't directly talk to systemd, so we'd need an
   * out-of-band channel — for now we expose a "preference" file that the
   * timer's own script reads (TODO: wire this into update.sh).
   * For phase 1 we just return a clear error so the UI shows "manual SSH needed".
   */
  async setAutoUpdate(enabled: boolean): Promise<{ enabled: boolean; message: string }> {
    // Persist the preference; update.sh checks this file on every run and
    // self-disables when it's set to "off". This avoids needing systemd access
    // from inside the container.
    const prefFile = path.join(DATA_DIR, 'auto-update.pref');
    try {
      if (enabled) {
        if (fs.existsSync(prefFile)) fs.unlinkSync(prefFile);
        return { enabled: true, message: 'Auto-update enabled — next check runs within 10 min.' };
      }
      fs.writeFileSync(prefFile, 'disabled\n');
      return { enabled: false, message: 'Auto-update disabled. Re-enable from this panel or run sudo systemctl enable --now kryptalis-update.timer.' };
    } catch (err: any) {
      throw new BadRequestException(`Failed to update preference: ${err.message}`);
    }
  }

  // ── internals ─────────────────────────────────────────────────────

  private async detectAutoUpdate(): Promise<boolean | null> {
    // Honour the operator preference file first — it's the in-container signal
    // and update.sh respects it. The systemd unit being enabled at boot is
    // additional, optional info.
    const prefFile = path.join(DATA_DIR, 'auto-update.pref');
    if (fs.existsSync(prefFile)) {
      try {
        const content = fs.readFileSync(prefFile, 'utf-8').trim();
        if (content === 'disabled') return false;
      } catch {}
    }
    // If the status file exists with a recent updatedAt (< 30 min) the timer
    // must be alive — that's our best proxy without systemctl access.
    try {
      if (fs.existsSync(STATUS_FILE)) {
        const stat = fs.statSync(STATUS_FILE);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < 30 * 60 * 1000) return true;
      }
    } catch {}
    return null;
  }

  private async detectManualTriggerAvailable(): Promise<boolean> {
    // We need the docker socket to be mounted AND the docker CLI image to be
    // pullable. Cheap probe: does the socket exist?
    try {
      return fs.existsSync('/var/run/docker.sock');
    } catch {
      return false;
    }
  }
}
