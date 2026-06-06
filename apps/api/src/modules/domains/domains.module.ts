import { Module, forwardRef } from '@nestjs/common';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { DomainAttachService } from './domain-attach.service';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [forwardRef(() => EmailModule)],
  controllers: [DomainsController],
  providers: [DomainsService, DomainAttachService],
  exports: [DomainsService, DomainAttachService],
})
export class DomainsModule {}
