import { describe, it, expect } from 'vitest';
import {
  parseCron,
  isValidCron,
  previousOccurrence,
  nextOccurrence,
} from './cron-schedule.util';

describe('cron-schedule.util — parseCron / isValidCron', () => {
  it('accepts standard expressions', () => {
    for (const e of [
      '* * * * *',
      '*/5 * * * *',
      '0 3 * * *',
      '0 9 * * 1-5',
      '15,45 * * * *',
      '0 0 1 * *',
      '0 0 * * 0',
      '0 0 * * 7', // 7 == Sunday
      '0-30/10 * * * *',
      '0 */2 * * *',
    ]) {
      expect(isValidCron(e), e).toBe(true);
    }
  });

  it('rejects malformed expressions', () => {
    for (const e of [
      '',
      '* * * *', // 4 fields
      '* * * * * *', // 6 fields
      '60 * * * *', // minute out of range
      '* 24 * * *', // hour out of range
      '* * 0 * *', // day-of-month min is 1
      '* * * 13 *', // month out of range
      '* * * * 8', // dow max is 7
      '5-1 * * * *', // inverted range
      '*/0 * * * *', // zero step
      'a * * * *', // non-numeric
    ]) {
      expect(isValidCron(e), e).toBe(false);
    }
  });

  it('normalises day-of-week 7 to 0 (Sunday)', () => {
    const p = parseCron('0 0 * * 7')!;
    expect(p.dow.has(0)).toBe(true);
    expect(p.dow.has(7)).toBe(false);
  });
});

describe('cron-schedule.util — previousOccurrence', () => {
  it('every-5-minutes lands on the most recent :00/:05/... boundary', () => {
    const now = new Date(2026, 5, 24, 14, 7, 30); // 14:07:30
    const occ = previousOccurrence('*/5 * * * *', now)!;
    expect(occ.getHours()).toBe(14);
    expect(occ.getMinutes()).toBe(5); // 14:05
    expect(occ.getSeconds()).toBe(0);
  });

  it('daily 03:00 returns today 03:00 when now is later the same day', () => {
    const now = new Date(2026, 5, 24, 9, 0, 0);
    const occ = previousOccurrence('0 3 * * *', now)!;
    expect(occ.getDate()).toBe(24);
    expect(occ.getHours()).toBe(3);
    expect(occ.getMinutes()).toBe(0);
  });

  it('daily 03:00 returns YESTERDAY when now is before 03:00', () => {
    const now = new Date(2026, 5, 24, 1, 0, 0);
    const occ = previousOccurrence('0 3 * * *', now)!;
    expect(occ.getDate()).toBe(23);
    expect(occ.getHours()).toBe(3);
  });

  it('weekday 09:00 (1-5) skips the weekend', () => {
    // 2026-06-20 is a Saturday; 09:00 weekday rule should fall back to Friday 19th.
    const sat = new Date(2026, 5, 20, 12, 0, 0);
    const occ = previousOccurrence('0 9 * * 1-5', sat)!;
    expect(occ.getDate()).toBe(19); // Friday
    expect(occ.getDay()).toBe(5);
    expect(occ.getHours()).toBe(9);
  });

  it('returns null for an invalid expression', () => {
    expect(previousOccurrence('not a cron', new Date())).toBeNull();
  });

  it('returns null for an unsatisfiable expression (Feb 30)', () => {
    expect(previousOccurrence('0 0 30 2 *', new Date(2026, 5, 24))).toBeNull();
  });

  it('DOM or DOW both restricted → matches on EITHER (standard cron)', () => {
    // "0 0 13 * 5" = midnight on the 13th OR any Friday.
    // 2026-06-12 is a Friday → previous occurrence at/just before noon is that day 00:00.
    const fri = new Date(2026, 5, 12, 12, 0, 0);
    const occ = previousOccurrence('0 0 13 * 5', fri)!;
    expect(occ.getDate()).toBe(12); // the Friday matched via DOW
    expect(occ.getHours()).toBe(0);
  });
});

describe('cron-schedule.util — nextOccurrence', () => {
  it('is strictly after now', () => {
    const now = new Date(2026, 5, 24, 14, 5, 0); // exactly on a */5 boundary
    const occ = nextOccurrence('*/5 * * * *', now)!;
    expect(occ.getMinutes()).toBe(10); // not 05 (strictly after)
  });

  it('returns null for invalid input', () => {
    expect(nextOccurrence('60 * * * *', new Date())).toBeNull();
  });
});
