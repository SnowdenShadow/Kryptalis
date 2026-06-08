import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ApplicationWebhooksController } from './webhooks.controller';
import { AgentModule } from '../agent/agent.module';
import { DomainsModule } from '../domains/domains.module';
import { DatabasesModule } from '../databases/databases.module';

@Module({
  imports: [AgentModule, DomainsModule, DatabasesModule],
  controllers: [ApplicationsController, ApplicationWebhooksController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
