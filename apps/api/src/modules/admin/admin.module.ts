import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PublicSettingsController } from './public-settings.controller';
import { ReaperService } from './reaper.service';

@Module({
  controllers: [AdminController, PublicSettingsController],
  providers: [AdminService, ReaperService],
  exports: [AdminService, ReaperService],
})
export class AdminModule {}
