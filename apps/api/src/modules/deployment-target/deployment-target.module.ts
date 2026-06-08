import { Global, Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { DeploymentTargetService } from './deployment-target.service';

/**
 * Global so applications/projects/databases services (and anything else
 * straddling the LOCAL/MULTI split) can inject it without each module
 * having to import DeploymentTargetModule.
 */
@Global()
@Module({
  imports: [AgentModule],
  providers: [DeploymentTargetService],
  exports: [DeploymentTargetService],
})
export class DeploymentTargetModule {}
