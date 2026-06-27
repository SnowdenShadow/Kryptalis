import { Global, Module } from '@nestjs/common';
import { SchedulerLeaderService } from './scheduler-leader.service';

/**
 * Provides {@link SchedulerLeaderService} app-wide so any module that runs a
 * background `setInterval` scheduler can gate it on `shouldRun()` without an
 * import edge. @Global, like CryptoModule / ApplicationRepositoryModule.
 */
@Global()
@Module({
  providers: [SchedulerLeaderService],
  exports: [SchedulerLeaderService],
})
export class SchedulerModule {}
