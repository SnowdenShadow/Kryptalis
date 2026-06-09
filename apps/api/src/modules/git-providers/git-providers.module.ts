import { Module } from '@nestjs/common';
import { GitProvidersController } from './git-providers.controller';
import { GitProvidersService } from './git-providers.service';
import { GitOAuthService } from './git-oauth.service';

@Module({
  controllers: [GitProvidersController],
  providers: [GitProvidersService, GitOAuthService],
  exports: [GitProvidersService, GitOAuthService],
})
export class GitProvidersModule {}
