import { Module } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { DomainsModule } from '../domains/domains.module';
import { DatabasesModule } from '../databases/databases.module';
import { AgentModule } from '../agent/agent.module';
import { ApplicationEnvService } from '../applications/application-env.service';

@Module({
  imports: [DomainsModule, DatabasesModule, AgentModule],
  controllers: [MarketplaceController],
  // ApplicationEnvService is stateless (PrismaService + EncryptionService,
  // both @Global) — providing it here avoids exporting it from
  // ApplicationsModule just for the install path's env snapshot.
  providers: [MarketplaceService, ApplicationEnvService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
