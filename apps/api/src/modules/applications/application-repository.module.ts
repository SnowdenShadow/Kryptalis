import { Global, Module } from '@nestjs/common';
import { ApplicationRepository } from './application.repository';

/**
 * Provides {@link ApplicationRepository} app-wide. @Global because the
 * Application write boundary is consumed by several modules that should NOT
 * have to import the whole ApplicationsModule (agent, marketplace, projects),
 * exactly like CryptoModule / NotificationsModule. PrismaModule is itself
 * global, so the repository's only dependency is already in scope.
 */
@Global()
@Module({
  providers: [ApplicationRepository],
  exports: [ApplicationRepository],
})
export class ApplicationRepositoryModule {}
