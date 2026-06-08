import { Module } from '@nestjs/common';
import { SftpController } from './sftp.controller';
import { SftpService } from './sftp.service';

@Module({
  controllers: [SftpController],
  providers: [SftpService],
  exports: [SftpService],
})
export class SftpModule {}
