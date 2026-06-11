/** GET /system/updates — auto-updater status (admin Updates tab). */
export interface UpdateStatus {
  status: 'UP_TO_DATE' | 'UPDATE_AVAILABLE' | 'UPDATING' | 'ERROR' | 'UNKNOWN';
  message: string;
  currentSha: string | null;
  latestSha: string | null;
  branch: string;
  repo: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  pollIntervalSec: number;
}
