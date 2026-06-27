import { describe, it, expect, afterEach } from 'vitest';
import { SchedulerLeaderService } from './scheduler-leader.service';

const ORIG_NODE_ENV = process.env.NODE_ENV;
const ORIG_FLAG = process.env.SCHEDULER_ENABLED;

afterEach(() => {
  process.env.NODE_ENV = ORIG_NODE_ENV;
  if (ORIG_FLAG === undefined) delete process.env.SCHEDULER_ENABLED;
  else process.env.SCHEDULER_ENABLED = ORIG_FLAG;
});

describe('SchedulerLeaderService', () => {
  it('does NOT run in test mode (NODE_ENV=test)', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.SCHEDULER_ENABLED;
    expect(new SchedulerLeaderService().shouldRun()).toBe(false);
  });

  it('runs by default (leader) outside tests when the flag is unset', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SCHEDULER_ENABLED;
    expect(new SchedulerLeaderService().shouldRun()).toBe(true);
  });

  it('runs when SCHEDULER_ENABLED=true', () => {
    process.env.NODE_ENV = 'production';
    process.env.SCHEDULER_ENABLED = 'true';
    expect(new SchedulerLeaderService().shouldRun()).toBe(true);
  });

  it('does NOT run on a follower (SCHEDULER_ENABLED=false), case-insensitive', () => {
    process.env.NODE_ENV = 'production';
    for (const v of ['false', 'False', 'FALSE']) {
      process.env.SCHEDULER_ENABLED = v;
      expect(new SchedulerLeaderService().shouldRun(), v).toBe(false);
    }
  });

  it('test mode wins even if SCHEDULER_ENABLED=true', () => {
    process.env.NODE_ENV = 'test';
    process.env.SCHEDULER_ENABLED = 'true';
    expect(new SchedulerLeaderService().shouldRun()).toBe(false);
  });
});
