import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AdminModule } from '../admin/admin.module';
import { AgentModule } from '../agent/agent.module';
import { ReverseProxyModule } from '../reverse-proxy/reverse-proxy.module';

@Module({
  imports: [AdminModule, AgentModule, ReverseProxyModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
