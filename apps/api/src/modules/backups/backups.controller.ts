import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { BackupsService } from './backups.service';
import { CreateBackupDto } from './dto/create-backup.dto';
import { SetProjectStorageDto } from './dto/project-storage.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Backups')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('backups')
export class BackupsController {
  constructor(private svc: BackupsService) {}

  @Post()
  @ApiOperation({ summary: 'Create backup (scoped to caller projects)' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateBackupDto) {
    return this.svc.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List backups for accessible servers' })
  findAll(@CurrentUser('id') userId: string, @Query('serverId') serverId?: string) {
    return this.svc.findAll(userId, serverId);
  }

  // NB: declared before ':id' so 'targets' is not captured as an id.
  @Get('targets')
  @ApiOperation({ summary: 'Available backup targets + whether S3 storage is configured (optionally for a project)' })
  getTargets(@CurrentUser('id') userId: string, @Query('projectId') projectId?: string) {
    return this.svc.getTargets(userId, projectId);
  }

  // ── per-project remote storage config ──────────────────────────────
  // Declared before ':id' so 'projects' isn't captured as a backup id.
  @Get('projects/:projectId/storage')
  @ApiOperation({ summary: "Read a project's remote backup storage config (no secret)" })
  getProjectStorage(@CurrentUser('id') userId: string, @Param('projectId') projectId: string) {
    return this.svc.getProjectStorage(userId, projectId);
  }

  @Put('projects/:projectId/storage')
  @ApiOperation({ summary: "Set a project's remote backup storage (project ADMIN)" })
  setProjectStorage(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: SetProjectStorageDto,
  ) {
    return this.svc.setProjectStorage(userId, projectId, dto);
  }

  @Delete('projects/:projectId/storage')
  @ApiOperation({ summary: "Remove a project's remote backup storage (project ADMIN)" })
  deleteProjectStorage(@CurrentUser('id') userId: string, @Param('projectId') projectId: string) {
    return this.svc.deleteProjectStorage(userId, projectId);
  }

  @Post('projects/:projectId/storage/test')
  @ApiOperation({ summary: "Validate a project's stored S3 credentials by listing the bucket" })
  testProjectStorage(@CurrentUser('id') userId: string, @Param('projectId') projectId: string) {
    return this.svc.testProjectStorage(userId, projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get backup' })
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.findOne(userId, id);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore backup (must be COMPLETED)' })
  restore(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.restore(userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete backup' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.remove(userId, id);
  }
}
