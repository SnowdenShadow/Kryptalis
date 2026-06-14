import { Module } from '@nestjs/common';
import { SslController } from './ssl.controller';
import { SslService } from './ssl.service';
import { DomainsModule } from '../domains/domains.module';

@Module({
  // DomainsModule provides DomainsService for the SSL diagnostics' DNS check.
  imports: [DomainsModule],
  controllers: [SslController],
  providers: [SslService],
  exports: [SslService],
})
export class SslModule {}
