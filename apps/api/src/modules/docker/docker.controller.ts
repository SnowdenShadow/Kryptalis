import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DockerService } from './docker.service';
import { ContainerActionDto } from './dto/container-action.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Docker')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
// Docker introspection + container actions touch every container on the host
// (including platform infra like postgres/redis/api/caddy/agent). This is a
// platform-admin-only surface; no project-scoped exposure.
@Roles('ADMIN', 'SUPERADMIN')
@Controller('docker')
export class DockerController {
  constructor(private svc: DockerService) {}

  @Get('servers/:serverId/containers')
  @ApiOperation({ summary: 'List containers' })
  containers(@Param('serverId') serverId: string) { return this.svc.listContainers(serverId); }

  @Post('servers/:serverId/containers/action')
  @ApiOperation({ summary: 'Container action (start/stop/restart/remove/kill)' })
  action(@Param('serverId') serverId: string, @Body() dto: ContainerActionDto) {
    return this.svc.containerAction(serverId, dto.containerId, dto.action);
  }

  @Get('servers/:serverId/images')
  @ApiOperation({ summary: 'List images' })
  images(@Param('serverId') serverId: string) { return this.svc.listImages(serverId); }

  @Get('servers/:serverId/networks')
  @ApiOperation({ summary: 'List networks' })
  networks(@Param('serverId') serverId: string) { return this.svc.listNetworks(serverId); }

  @Get('servers/:serverId/volumes')
  @ApiOperation({ summary: 'List volumes' })
  volumes(@Param('serverId') serverId: string) { return this.svc.listVolumes(serverId); }
}
