import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { BackupsService } from './backups.service';
import { CreateBackupDto } from './dto/create-backup.dto';
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
