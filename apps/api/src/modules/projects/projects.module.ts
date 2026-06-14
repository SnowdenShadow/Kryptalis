import { Module, forwardRef } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AdminModule } from '../admin/admin.module';
import { AgentModule } from '../agent/agent.module';
import { ReverseProxyModule } from '../reverse-proxy/reverse-proxy.module';
import { EmailModule } from '../email/email.module';
import { ApplicationsModule } from '../applications/applications.module';

@Module({
  imports: [
    AdminModule,
    AgentModule,
    ReverseProxyModule,
    forwardRef(() => EmailModule),
    // migrate() relocates each app via ApplicationOpsService.redeploy (the
    // real remote-capable deploy path) instead of hand-rolling DEPLOY tasks.
    ApplicationsModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
