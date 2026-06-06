import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemUpdatesService } from './system-updates.service';

@Module({
  controllers: [SystemController],
  providers: [SystemUpdatesService],
})
export class SystemModule {}
