import { Module } from '@nestjs/common';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { MailServerService } from './mail-server.service';
import { MarketplaceModule } from '../marketplace/marketplace.module';

@Module({
  // MarketplaceModule provides install() — used by the 1-click webmail
  // (Roundcube) deploy.
  imports: [MarketplaceModule],
  controllers: [EmailController],
  providers: [EmailService, MailServerService],
  exports: [MailServerService],
})
export class EmailModule {}
