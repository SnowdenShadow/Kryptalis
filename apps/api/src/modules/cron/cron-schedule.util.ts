// Pure, dependency-free 5-field cron parser — no I/O, no Nest dependency.
//
// The backups module ships a deliberately tiny cron SUBSET
// (backup-schedule.util.ts: @hourly/@daily/@weekly + "<min> <hour> * * *").
// User-managed cron jobs need the real thing — every-N-minutes, weekday
// ranges, day-of-month, lists, steps — so this module implements a full
// standard 5-field parser rather than stretching the backup subset.
//
// Supported per field:  *  |  N  |  A-B (range)  |  A,B,C (list)  |  step "/S"
//   |  range+step "A-B/S"
// Fields:  minute(0-59)  hour(0-23)  day-of-month(1-31)  month(1-12)
//          day-of-week(0-6, Sun=0; 7 also accepted as Sunday)
//
// Day-of-month and day-of-week use the standard cron rule: when BOTH are
// restricted (not "*"), a match on EITHER fires (OR semantics). When one is
// "*", only the other constrains.
//
// Times are evaluated in the server's local timezone (same as the backups
// scheduler). Granularity is one minute — the caller ticks every 60s.

const FIELD_BOUNDS: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 == Sunday)
];

/** Human-friendly hint shown next to the DTO validator. */
export const CRON_SCHEDULE_MESSAGE =
  'schedule must be a standard 5-field cron expression ' +
  '"minute hour day-of-month month day-of-week" — supports *, ranges (1-5), ' +
  'lists (1,3,5), and steps (*/15). e.g. "*/5 * * * *", "0 3 * * *", "0 9 * * 1-5".';

/**
 * Parse a single cron field into the explicit set of values it matches,
 * constrained to [min,max]. Returns null when the token is malformed.
 */
function parseField(token: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of token.split(',')) {
    if (part === '') return null;

    // Split optional step:  <range>/<step>
    let range = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      const stepStr = part.slice(slash + 1);
      range = part.slice(0, slash);
      if (!/^\d+$/.test(stepStr)) return null;
      step = Number(stepStr);
      if (step <= 0) return null;
    }

    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(range)) {
      lo = hi = Number(range);
      // A bare number with a step means "from N to max, every step".
      if (slash !== -1) hi = max;
    } else {
      const m = range.match(/^(\d+)-(\d+)$/);
      if (!m) return null;
      lo = Number(m[1]);
      hi = Number(m[2]);
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse a full 5-field expression, or null when it isn't valid. */
export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const sets: Array<Set<number>> = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(fields[i], FIELD_BOUNDS[i].min, FIELD_BOUNDS[i].max);
    if (!s) return null;
    sets.push(s);
  }

  const dow = sets[4];
  // Normalise 7 → 0 (both mean Sunday) so getDay() (0-6) always matches.
  if (dow.has(7)) {
    dow.add(0);
    dow.delete(7);
  }

  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/** Validate a cron expression without keeping the parse. */
export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/** True when `date` (local time) matches the parsed expression to the minute. */
function matches(p: ParsedCron, date: Date): boolean {
  if (!p.minute.has(date.getMinutes())) return false;
  if (!p.hour.has(date.getHours())) return false;
  if (!p.month.has(date.getMonth() + 1)) return false;

  const domOk = p.dom.has(date.getDate());
  const dowOk = p.dow.has(date.getDay());
  // Standard cron day matching: if both DOM and DOW are restricted, match on
  // EITHER; if only one is restricted, that one must match; if neither, both
  // are "*" and pass.
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk;
  if (p.domRestricted) return domOk;
  if (p.dowRestricted) return dowOk;
  return true;
}

/**
 * Most recent occurrence of `schedule` at or before `now` (to the minute), or
 * null when the expression is invalid OR no occurrence exists within a bounded
 * look-back. The scheduler compares this against the job's lastRunAt: a stored
 * watermark older than the returned occurrence means a run is due.
 *
 * Walks back minute-by-minute from `now`. Bounded at ~370 days so an
 * impossible expression (e.g. "0 0 30 2 *" — Feb 30) terminates instead of
 * looping forever.
 */
export function previousOccurrence(schedule: string, now: Date): Date | null {
  const p = parseCron(schedule);
  if (!p) return null;

  const cursor = new Date(now);
  cursor.setSeconds(0, 0); // align to the minute boundary
  const MAX_MINUTES = 370 * 24 * 60; // a little over a year
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (matches(p, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return null;
}

/**
 * Next occurrence STRICTLY after `now` (to the minute), or null for an invalid
 * or unsatisfiable expression. Used only to show the user when a job will next
 * fire — never for scheduling decisions.
 */
export function nextOccurrence(schedule: string, now: Date): Date | null {
  const p = parseCron(schedule);
  if (!p) return null;

  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1); // strictly after
  const MAX_MINUTES = 370 * 24 * 60;
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (matches(p, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
