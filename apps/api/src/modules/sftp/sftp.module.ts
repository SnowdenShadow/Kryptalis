import { Module } from '@nestjs/common';
import { SftpController } from './sftp.controller';
import { SftpService } from './sftp.service';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [AgentModule],
  controllers: [SftpController],
  providers: [SftpService],
  exports: [SftpService],
})
export class SftpModule {}
