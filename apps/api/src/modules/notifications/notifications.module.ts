import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * @Global so consumers (AuthService, MonitoringService, …) inject the
 * service without each module having to import NotificationsModule —
 * which would otherwise risk circular imports once Notifications grows
 * to need anything from Users/Auth itself.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
