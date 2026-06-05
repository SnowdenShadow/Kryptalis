import { Module } from '@nestjs/common';
import { GitProvidersController } from './git-providers.controller';
import { GitProvidersService } from './git-providers.service';

@Module({
  controllers: [GitProvidersController],
  providers: [GitProvidersService],
  exports: [GitProvidersService],
})
export class GitProvidersModule {}
