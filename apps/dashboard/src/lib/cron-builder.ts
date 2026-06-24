// Helpers for the cron scheduler UI: build a standard 5-field cron expression
// from simple inputs (frequency + time), and describe an expression back in
// plain language. Mirrors the subset the API parser supports
// (apps/api/.../cron/cron-schedule.util.ts): * , ranges, lists, steps.

export type CronFrequency = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface SimpleSchedule {
  frequency: CronFrequency;
  /** every N minutes (frequency=minutes) */
  everyMinutes: number;
  /** minute of the hour (frequency=hourly) */
  minute: number;
  /** hour 0-23 (daily/weekly/monthly) */
  hour: number;
  /** minute 0-59 (daily/weekly/monthly) */
  atMinute: number;
  /** day of week 0-6, Sun=0 (weekly) */
  weekday: number;
  /** day of month 1-28 (monthly) — capped at 28 so it fires every month */
  monthday: number;
}

export const DEFAULT_SIMPLE: SimpleSchedule = {
  frequency: 'daily',
  everyMinutes: 5,
  minute: 0,
  hour: 3,
  atMinute: 0,
  weekday: 1,
  monthday: 1,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Build a 5-field cron expression from the simple form. */
export function buildCron(s: SimpleSchedule): string {
  switch (s.frequency) {
    case 'minutes': {
      const n = Math.min(Math.max(s.everyMinutes, 1), 59);
      return `*/${n} * * * *`;
    }
    case 'hourly':
      return `${clamp(s.minute, 0, 59)} * * * *`;
    case 'daily':
      return `${clamp(s.atMinute, 0, 59)} ${clamp(s.hour, 0, 23)} * * *`;
    case 'weekly':
      return `${clamp(s.atMinute, 0, 59)} ${clamp(s.hour, 0, 23)} * * ${clamp(s.weekday, 0, 6)}`;
    case 'monthly':
      return `${clamp(s.atMinute, 0, 59)} ${clamp(s.hour, 0, 23)} ${clamp(s.monthday, 1, 28)} * *`;
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(Math.round(n || 0), lo), hi);
}

/**
 * Try to read a cron expression back INTO the simple form, so opening the
 * simple editor on an existing/typed expression keeps the dropdowns in sync.
 * Returns null when the expression is outside the simple subset (the UI then
 * stays in advanced mode).
 */
export function parseToSimple(expr: string): SimpleSchedule | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hr, dom, mon, dow] = f;
  if (mon !== '*') return null;

  // every N minutes:  */N * * * *
  const stepM = min.match(/^\*\/(\d{1,2})$/);
  if (stepM && hr === '*' && dom === '*' && dow === '*') {
    const n = Number(stepM[1]);
    if (n >= 1 && n <= 59) return { ...DEFAULT_SIMPLE, frequency: 'minutes', everyMinutes: n };
  }

  const isNum = (x: string) => /^\d{1,2}$/.test(x);

  // hourly:  M * * * *
  if (isNum(min) && hr === '*' && dom === '*' && dow === '*') {
    return { ...DEFAULT_SIMPLE, frequency: 'hourly', minute: Number(min) };
  }
  // daily:  M H * * *
  if (isNum(min) && isNum(hr) && dom === '*' && dow === '*') {
    return { ...DEFAULT_SIMPLE, frequency: 'daily', atMinute: Number(min), hour: Number(hr) };
  }
  // weekly:  M H * * D
  if (isNum(min) && isNum(hr) && dom === '*' && isNum(dow)) {
    return { ...DEFAULT_SIMPLE, frequency: 'weekly', atMinute: Number(min), hour: Number(hr), weekday: Number(dow) };
  }
  // monthly:  M H DOM * *
  if (isNum(min) && isNum(hr) && isNum(dom) && dow === '*') {
    return { ...DEFAULT_SIMPLE, frequency: 'monthly', atMinute: Number(min), hour: Number(hr), monthday: Number(dom) };
  }
  return null;
}

/**
 * Plain-language description of a cron expression. `t` is the i18n translator
 * and `weekdayNames`/`ordinal` provide localized words. Falls back to echoing
 * the raw expression for anything outside the simple subset.
 */
export function describeCron(
  expr: string,
  opts: {
    everyMinutes: (n: number) => string;
    hourlyAt: (m: string) => string;
    dailyAt: (time: string) => string;
    weeklyAt: (day: string, time: string) => string;
    monthlyAt: (day: number, time: string) => string;
    weekdayNames: string[]; // index 0 = Sunday
    raw: (expr: string) => string;
  },
): string {
  const s = parseToSimple(expr);
  if (!s) return opts.raw(expr.trim());
  switch (s.frequency) {
    case 'minutes':
      return opts.everyMinutes(s.everyMinutes);
    case 'hourly':
      return opts.hourlyAt(pad(s.minute));
    case 'daily':
      return opts.dailyAt(`${pad(s.hour)}:${pad(s.atMinute)}`);
    case 'weekly':
      return opts.weeklyAt(opts.weekdayNames[s.weekday] ?? String(s.weekday), `${pad(s.hour)}:${pad(s.atMinute)}`);
    case 'monthly':
      return opts.monthlyAt(s.monthday, `${pad(s.hour)}:${pad(s.atMinute)}`);
  }
}
