import { Module, Global } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemUpdatesService } from './system-updates.service';
import { SystemConfigService } from './system-config.service';

/**
 * @Global so any module can inject SystemConfigService without listing it
 * in its own imports — same pattern as CryptoModule and NotificationsModule.
 */
@Global()
@Module({
  controllers: [SystemController],
  providers: [SystemUpdatesService, SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemModule {}
