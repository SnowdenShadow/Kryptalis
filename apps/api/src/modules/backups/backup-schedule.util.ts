/**
 * Pure helpers for the backup scheduler — no I/O, no Nest dependency
 * (same philosophy as backup-storage.util).
 *
 * No cron library ships with apps/api (no @nestjs/schedule, no cron-parser),
 * so instead of pulling a new dependency we support a documented subset:
 *
 *   @hourly                — minute 0 of every hour
 *   @daily                 — every day at 00:00
 *   @weekly                — every Sunday at 00:00
 *   "<minute> <hour> * * *" — 5-field cron limited to a numeric minute
 *                             (0-59) and a numeric hour (0-23) or `*`.
 *                             e.g. "30 3 * * *" = daily 03:30,
 *                                  "15 * * * *" = hourly at :15.
 *
 * Anything else is rejected at create time (DTO @Matches on this pattern).
 * Times are evaluated in the server's local timezone.
 */
export const BACKUP_SCHEDULE_PATTERN =
  /^(@hourly|@daily|@weekly|([0-9]|[1-5][0-9])\s+(\*|1?[0-9]|2[0-3])\s+\*\s+\*\s+\*)$/;

export const BACKUP_SCHEDULE_MESSAGE =
  'schedule must be @hourly, @daily, @weekly or a simple 5-field cron ' +
  '"<minute> <hour> * * *" (e.g. "30 3 * * *" for daily at 03:30, ' +
  '"15 * * * *" for hourly at :15)';

/**
 * Most recent occurrence of `schedule` at or before `now`, or null when the
 * expression isn't part of the supported subset (legacy rows). The scheduler
 * compares this against the template's lastRunAt: lastRunAt < occurrence
 * means the occurrence hasn't been honoured yet → a run is due.
 */
export function previousOccurrence(schedule: string, now: Date): Date | null {
  const s = schedule.trim();
  if (s === '@hourly') {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    return d;
  }
  if (s === '@daily') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (s === '@weekly') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay()); // back to Sunday
    return d;
  }

  const m = s.match(/^(\d{1,2})\s+(\*|\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!m) return null;
  const minute = Number(m[1]);
  if (minute > 59) return null;

  if (m[2] === '*') {
    // "<minute> * * * *" — hourly at :minute.
    const d = new Date(now);
    d.setMinutes(minute, 0, 0);
    if (d.getTime() > now.getTime()) d.setHours(d.getHours() - 1);
    return d;
  }

  const hour = Number(m[2]);
  if (hour > 23) return null;
  // "<minute> <hour> * * *" — daily at hour:minute.
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

/**
 * Name of the child row spawned from a schedule template. The " (…)" suffix
 * convention is also what the scheduler's double-run guard matches on, so
 * keep the two in sync.
 */
export function scheduledRunName(templateName: string, occurrence: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${occurrence.getFullYear()}-${p(occurrence.getMonth() + 1)}-${p(occurrence.getDate())}` +
    ` ${p(occurrence.getHours())}:${p(occurrence.getMinutes())}`;
  return `${templateName} (${stamp})`;
}
