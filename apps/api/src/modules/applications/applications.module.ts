import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ApplicationDeployService } from './application-deploy.service';
import { ApplicationOpsService } from './application-ops.service';
import { ApplicationNetworkService } from './application-network.service';
import { ApplicationEnvService } from './application-env.service';
import { ApplicationWebhooksController } from './webhooks.controller';
import { AgentModule } from '../agent/agent.module';
import { DomainsModule } from '../domains/domains.module';
import { DatabasesModule } from '../databases/databases.module';
import { SftpModule } from '../sftp/sftp.module';
import { GitProvidersModule } from '../git-providers/git-providers.module';

@Module({
  // SftpModule: remove() deprovisions the OS-level SFTP account in the sftp
  // container before deleting the app (the FK cascade drops only the DB row).
  // GitProvidersModule: branch listing + 1-click webhook auto-registration on
  // the provider (reuses its per-provider token/auth dispatch).
  imports: [AgentModule, DomainsModule, DatabasesModule, SftpModule, GitProvidersModule],
  controllers: [ApplicationsController, ApplicationWebhooksController],
  providers: [
    ApplicationsService,
    ApplicationDeployService,
    ApplicationOpsService,
    ApplicationNetworkService,
    ApplicationEnvService,
  ],
  exports: [ApplicationsService, ApplicationOpsService, ApplicationEnvService],
})
export class ApplicationsModule {}
