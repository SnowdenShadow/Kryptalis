import { Module, Global } from '@nestjs/common';
import { ReverseProxyController } from './reverse-proxy.controller';
import { ReverseProxyService } from './reverse-proxy.service';

@Global()
@Module({
  controllers: [ReverseProxyController],
  providers: [ReverseProxyService],
  exports: [ReverseProxyService],
})
export class ReverseProxyModule {}
