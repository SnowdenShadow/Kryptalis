import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PublicSettingsController } from './public-settings.controller';

@Module({
  controllers: [AdminController, PublicSettingsController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
