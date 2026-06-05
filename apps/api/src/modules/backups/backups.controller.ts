import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { BackupsService } from './backups.service';
import { CreateBackupDto } from './dto/create-backup.dto';

@ApiTags('Backups')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('backups')
export class BackupsController {
  constructor(private svc: BackupsService) {}

  @Post()
  @ApiOperation({ summary: 'Create backup' })
  create(@Body() dto: CreateBackupDto) { return this.svc.create(dto); }

  @Get()
  @ApiOperation({ summary: 'List backups' })
  findAll(@Query('serverId') serverId?: string) { return this.svc.findAll(serverId); }

  @Get(':id')
  @ApiOperation({ summary: 'Get backup' })
  findOne(@Param('id') id: string) { return this.svc.findOne(id); }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore backup' })
  restore(@Param('id') id: string) { return this.svc.restore(id); }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete backup' })
  remove(@Param('id') id: string) { return this.svc.remove(id); }
}
