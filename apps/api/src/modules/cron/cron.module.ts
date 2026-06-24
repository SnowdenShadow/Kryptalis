import { Module } from '@nestjs/common';
import { CronController } from './cron.controller';
import { CronService } from './cron.service';
import { ApplicationsModule } from '../applications/applications.module';

/**
 * User-managed cron jobs: schedule a command to run inside an app/site
 * container on a standard 5-field cron expression. Reuses
 * ApplicationOpsService.execCommand (local docker exec OR remote EXEC agent
 * task) — exported by ApplicationsModule — for execution.
 */
@Module({
  imports: [ApplicationsModule],
  controllers: [CronController],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
