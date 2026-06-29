import { Module } from '@nestjs/common';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { MailServerService } from './mail-server.service';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  // MarketplaceModule provides install() — used by the 1-click webmail
  // (Roundcube) deploy. AgentModule provides enqueueAndWait() — used to run the
  // mail stack on a REMOTE server (docker via agent tasks) instead of locally.
  imports: [MarketplaceModule, AgentModule],
  controllers: [EmailController],
  providers: [EmailService, MailServerService],
  exports: [MailServerService],
})
export class EmailModule {}
