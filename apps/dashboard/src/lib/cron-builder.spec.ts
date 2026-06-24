import { describe, it, expect } from 'vitest';
import { buildCron, parseToSimple, DEFAULT_SIMPLE } from './cron-builder';

describe('buildCron', () => {
  it('every N minutes', () => {
    expect(buildCron({ ...DEFAULT_SIMPLE, frequency: 'minutes', everyMinutes: 5 })).toBe('*/5 * * * *');
    // clamps out-of-range
    expect(buildCron({ ...DEFAULT_SIMPLE, frequency: 'minutes', everyMinutes: 0 })).toBe('*/1 * * * *');
    expect(buildCron({ ...DEFAULT_SIMPLE, frequency: 'minutes', everyMinutes: 90 })).toBe('*/59 * * * *');
  });
  it('hourly at minute', () => {
    expect(buildCron({ ...DEFAULT_SIMPLE, frequency: 'hourly', minute: 15 })).toBe('15 * * * *');
  });
  it('daily at HH:MM', () => {
    expect(buildCron({ ...DEFAULT_SIMPLE, frequency: 'daily', hour: 3, atMinute: 30 })).toBe('30 3 * * *');
  });
  it('weekly on weekday at HH:MM', () => {
    expect(buildCron({ ...DEFAULT_SIMPLE, frequency: 'weekly', weekday: 1, hour: 9, atMinute: 0 })).toBe('0 9 * * 1');
  });
  it('monthly on day at HH:MM', () => {
    expect(buildCron({ ...DEFAULT_SIMPLE, frequency: 'monthly', monthday: 1, hour: 0, atMinute: 0 })).toBe('0 0 1 * *');
    // day capped at 28 so it always fires
    expect(buildCron({ ...DEFAULT_SIMPLE, frequency: 'monthly', monthday: 31, hour: 0, atMinute: 0 })).toBe('0 0 28 * *');
  });
});

describe('parseToSimple', () => {
  it('round-trips every-N-minutes', () => {
    expect(parseToSimple('*/5 * * * *')).toMatchObject({ frequency: 'minutes', everyMinutes: 5 });
  });
  it('round-trips hourly', () => {
    expect(parseToSimple('15 * * * *')).toMatchObject({ frequency: 'hourly', minute: 15 });
  });
  it('round-trips daily', () => {
    expect(parseToSimple('30 3 * * *')).toMatchObject({ frequency: 'daily', hour: 3, atMinute: 30 });
  });
  it('round-trips weekly', () => {
    expect(parseToSimple('0 9 * * 1')).toMatchObject({ frequency: 'weekly', weekday: 1, hour: 9, atMinute: 0 });
  });
  it('round-trips monthly', () => {
    expect(parseToSimple('0 0 1 * *')).toMatchObject({ frequency: 'monthly', monthday: 1 });
  });
  it('returns null for expressions outside the simple subset', () => {
    expect(parseToSimple('0 9 * * 1-5')).toBeNull(); // weekday range
    expect(parseToSimple('15,45 * * * *')).toBeNull(); // minute list
    expect(parseToSimple('not a cron')).toBeNull();
    expect(parseToSimple('* * * * *')).toBeNull(); // not a recognised simple shape
  });
  it('build → parse is stable for each frequency', () => {
    for (const s of [
      { ...DEFAULT_SIMPLE, frequency: 'minutes' as const, everyMinutes: 10 },
      { ...DEFAULT_SIMPLE, frequency: 'hourly' as const, minute: 5 },
      { ...DEFAULT_SIMPLE, frequency: 'daily' as const, hour: 6, atMinute: 45 },
      { ...DEFAULT_SIMPLE, frequency: 'weekly' as const, weekday: 5, hour: 18, atMinute: 0 },
      { ...DEFAULT_SIMPLE, frequency: 'monthly' as const, monthday: 15, hour: 2, atMinute: 0 },
    ]) {
      const expr = buildCron(s);
      const back = parseToSimple(expr)!;
      expect(buildCron(back)).toBe(expr);
    }
  });
});
