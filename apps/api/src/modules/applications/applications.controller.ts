import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { ExecCommandDto } from './dto/exec-command.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Applications')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('applications')
export class ApplicationsController {
  constructor(private svc: ApplicationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create application' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateApplicationDto) {
    return this.svc.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List applications' })
  findAll(@CurrentUser('id') userId: string) {
    return this.svc.findAll(userId);
  }

  @Get('next-free-port/:projectId')
  @ApiOperation({ summary: 'Suggest the next free host port for a project\'s server' })
  nextFreePort(@CurrentUser('id') userId: string, @Param('projectId') projectId: string) {
    return this.svc.suggestNextFreePort(userId, projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get application' })
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.findOne(userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update application' })
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdateApplicationDto) {
    return this.svc.update(userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete application' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.remove(userId, id);
  }

  @Get(':id/logs')
  @ApiOperation({ summary: 'Get application logs' })
  logs(@CurrentUser('id') userId: string, @Param('id') id: string, @Query('lines') lines?: string) {
    return this.svc.getLogs(userId, id, lines ? parseInt(lines, 10) : 100);
  }

  @Post(':id/exec')
  @ApiOperation({ summary: 'Execute command in container' })
  exec(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: ExecCommandDto) {
    return this.svc.execCommand(userId, id, dto.command);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start application' })
  start(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.start(userId, id);
  }

  @Post(':id/stop')
  @ApiOperation({ summary: 'Stop application' })
  stop(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.stop(userId, id);
  }

  @Post(':id/restart')
  @ApiOperation({ summary: 'Restart application' })
  restart(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.restart(userId, id);
  }

  @Post(':id/redeploy')
  @ApiOperation({ summary: 'Redeploy application (pull + rebuild)' })
  redeploy(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.redeploy(userId, id);
  }

  @Post(':id/rollback')
  @ApiOperation({ summary: 'Roll back to the commit of an earlier successful deployment' })
  rollback(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('deploymentId') deploymentId: string,
  ) {
    return this.svc.rollback(userId, id, deploymentId);
  }

  @Get(':id/files/compose')
  @ApiOperation({ summary: 'Read docker-compose.yml of the app' })
  readCompose(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.readComposeFile(userId, id);
  }

  @Patch(':id/files/compose')
  @ApiOperation({ summary: 'Update docker-compose.yml of the app' })
  writeCompose(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('content') content: string,
  ) {
    return this.svc.writeComposeFile(userId, id, content);
  }

  @Get(':id/files/dockerfile')
  @ApiOperation({ summary: 'Read Dockerfile of the app' })
  readDockerfile(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.readDockerfile(userId, id);
  }

  @Patch(':id/files/dockerfile')
  @ApiOperation({ summary: 'Update Dockerfile of the app' })
  writeDockerfile(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('content') content: string,
  ) {
    return this.svc.writeDockerfile(userId, id, content);
  }

  @Get(':id/ports')
  @ApiOperation({ summary: 'List exposed ports parsed from compose/Dockerfile' })
  ports(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.listPorts(userId, id);
  }

  @Patch(':id/ports')
  @ApiOperation({ summary: 'Remap host ports for the compose stack' })
  remapPorts(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('mapping') mapping: Record<string, number>,
  ) {
    return this.svc.remapPorts(userId, id, mapping);
  }

  @Patch(':id/url-mode')
  @ApiOperation({ summary: 'Toggle clean URL (Caddy on 443) vs port URL (https://domain:port)' })
  setUrlMode(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('customPort') customPort: boolean,
  ) {
    return this.svc.setUrlMode(userId, id, customPort);
  }

  @Post(':id/move-server')
  @ApiOperation({ summary: 'Move this app to another server (transferVolumes=true ships docker volumes, local→remote only)' })
  moveServer(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('targetServerId') targetServerId: string,
    @Body('transferVolumes') transferVolumes?: boolean,
  ) {
    return this.svc.moveServer(userId, id, targetServerId, !!transferVolumes);
  }

  // Port bindings — for apps co-hosted on a domain on a custom port. See
  // DomainPortBinding in the Prisma schema.
  @Post(':id/port-bindings')
  @ApiOperation({ summary: 'Bind this app to <domain>:<port> (co-hosted with other apps)' })
  addBinding(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: { domainId: string; port: number },
  ) {
    return this.svc.addPortBinding(userId, id, body.domainId, body.port);
  }

  @Delete('port-bindings/:bindingId')
  @ApiOperation({ summary: 'Remove a port binding (detach app from <domain>:<port>)' })
  removeBinding(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
  ) {
    return this.svc.removePortBinding(userId, bindingId);
  }

  @Get(':id/env')
  @ApiOperation({ summary: 'Read application env vars' })
  getEnv(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getEnv(userId, id);
  }

  @Patch(':id/env')
  @ApiOperation({ summary: 'Update application env vars' })
  setEnv(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('envVars') envVars: Record<string, string>,
  ) {
    return this.svc.setEnv(userId, id, envVars);
  }

  @Get(':id/databases')
  @ApiOperation({ summary: 'List managed databases attached to this app' })
  listDatabases(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.listDatabases(userId, id);
  }

  @Post(':id/databases/:databaseId')
  @ApiOperation({ summary: 'Attach a managed database + inject DB_* env vars, then redeploy' })
  attachDatabase(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('databaseId') databaseId: string,
  ) {
    return this.svc.attachDatabase(userId, id, databaseId);
  }

  @Delete(':id/databases/:databaseId')
  @ApiOperation({ summary: 'Detach a managed database + strip its DB_* env vars, then redeploy' })
  detachDatabase(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('databaseId') databaseId: string,
  ) {
    return this.svc.detachDatabase(userId, id, databaseId);
  }

  @Get(':id/webhook')
  @ApiOperation({ summary: 'Get webhook URL + secret for git auto-deploy' })
  getWebhook(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getWebhook(userId, id);
  }

  @Post(':id/webhook/rotate')
  @ApiOperation({ summary: 'Rotate webhook secret' })
  rotateWebhook(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.rotateWebhookSecret(userId, id);
  }

  @Patch(':id/auto-deploy')
  @ApiOperation({ summary: 'Toggle auto-deploy on push' })
  toggleAutoDeploy(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('enabled') enabled: boolean,
  ) {
    return this.svc.setAutoDeploy(userId, id, enabled);
  }

  @Get(':id/deployments')
  @ApiOperation({ summary: 'List deployments of this application' })
  deployments(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.listDeployments(userId, id);
  }

  @Get(':id/deployments/:depId')
  @ApiOperation({ summary: 'Get one deployment (with live logs)' })
  deployment(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('depId') depId: string,
  ) {
    return this.svc.getDeployment(userId, id, depId);
  }
}
