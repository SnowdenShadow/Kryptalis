import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DockerService } from './docker.service';
import { ContainerActionDto } from './dto/container-action.dto';

@ApiTags('Docker')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('docker')
export class DockerController {
  constructor(private svc: DockerService) {}

  @Get('servers/:serverId/containers')
  @ApiOperation({ summary: 'List containers' })
  containers(@Param('serverId') serverId: string) { return this.svc.listContainers(serverId); }

  @Post('servers/:serverId/containers/action')
  @ApiOperation({ summary: 'Container action' })
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
