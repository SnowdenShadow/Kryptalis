import { Module } from '@nestjs/common';
import { SystemController, SystemWebhookController } from './system.controller';
import { SystemUpdatesService } from './system-updates.service';

@Module({
  controllers: [SystemController, SystemWebhookController],
  providers: [SystemUpdatesService],
})
export class SystemModule {}
