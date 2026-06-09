import { Module, Global } from '@nestjs/common';
import { SystemController, SystemWebhookController } from './system.controller';
import { SystemUpdatesService } from './system-updates.service';
import { SystemConfigService } from './system-config.service';
import { GitProvidersModule } from '../git-providers/git-providers.module';

/**
 * @Global so any module can inject SystemConfigService without listing it
 * in its own imports — same pattern as CryptoModule and NotificationsModule.
 */
@Global()
@Module({
  imports: [GitProvidersModule],
  controllers: [SystemController, SystemWebhookController],
  providers: [SystemUpdatesService, SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemModule {}
