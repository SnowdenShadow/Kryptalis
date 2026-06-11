import { Module } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { DomainsModule } from '../domains/domains.module';
import { DatabasesModule } from '../databases/databases.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [DomainsModule, DatabasesModule, AgentModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
