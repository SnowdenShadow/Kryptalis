import { Module } from '@nestjs/common';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { MailServerService } from './mail-server.service';

@Module({
  controllers: [EmailController],
  providers: [EmailService, MailServerService],
})
export class EmailModule {}
