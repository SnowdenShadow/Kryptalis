import { Injectable, Logger } from '@nestjs/common';

/**
 * SchedulerLeaderService — a single, process-wide answer to "should THIS API
 * instance run the background schedulers?".
 *
 * DockControl is architected for a single API instance. Every module that owns
 * a `setInterval` scheduler (metric collection, backup runner, cron tick, alert
 * evaluation, SSL sync, offline sweep, deployment prune, notification/audit
 * cleanup, …) assumes it is the only one running. Under a multi-replica
 * deployment those timers fire on EVERY replica, which means duplicated backup
 * runs, double metric rows, N× cron executions, etc.
 *
 * Proper distributed leader election (a Postgres advisory lock or a lease row)
 * is a larger change; this service is the pragmatic guard in front of it:
 *
 *   - Default (`SCHEDULER_ENABLED` unset or "true"): this instance IS the
 *     leader → schedulers run. Single-instance installs are unchanged.
 *   - `SCHEDULER_ENABLED=false`: this instance is a follower → it serves HTTP
 *     but runs NO schedulers. In a multi-replica deploy, set this on every
 *     replica except one so exactly one runs the timers.
 *
 * `shouldRun()` also keeps the existing `NODE_ENV==='test'` opt-out (tests must
 * never start live intervals), centralizing that check too.
 *
 * Registered @Global so any module can inject it without an import edge.
 */
@Injectable()
export class SchedulerLeaderService {
  private readonly logger = new Logger(SchedulerLeaderService.name);
  private warned = false;

  /** True when env explicitly disables schedulers on this instance. */
  private get disabledByEnv(): boolean {
    return (process.env.SCHEDULER_ENABLED || '').toLowerCase() === 'false';
  }

  /**
   * Whether background schedulers should run on this instance. False in tests
   * (no live timers) and when SCHEDULER_ENABLED=false (a follower replica).
   */
  shouldRun(): boolean {
    if (process.env.NODE_ENV === 'test') return false;
    if (this.disabledByEnv) {
      if (!this.warned) {
        this.warned = true;
        this.logger.log(
          'SCHEDULER_ENABLED=false — background schedulers are DISABLED on this instance ' +
            '(follower). It serves HTTP only; another instance must run the schedulers.',
        );
      }
      return false;
    }
    return true;
  }
}
