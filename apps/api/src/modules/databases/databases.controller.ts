import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DatabasesService } from './databases.service';
import { CreateDatabaseDto } from './dto/create-database.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Databases')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('databases')
export class DatabasesController {
  constructor(private svc: DatabasesService) {}

  @Post()
  @ApiOperation({ summary: 'Create database' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateDatabaseDto) {
    return this.svc.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List databases' })
  findAll(
    @CurrentUser('id') userId: string,
    @Query('serverId') serverId?: string,
    @Query('projectId') projectId?: string,
    @Query('applicationId') applicationId?: string,
  ) {
    return this.svc.findAll(userId, { serverId, projectId, applicationId });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get database' })
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.findOne(userId, id);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start database' })
  start(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.start(userId, id);
  }

  @Post(':id/stop')
  @ApiOperation({ summary: 'Stop database' })
  stop(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.stop(userId, id);
  }

  @Patch(':id/parent')
  @ApiOperation({ summary: 'Re-link a database to a project / application' })
  setParent(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: { projectId?: string | null; applicationId?: string | null },
  ) {
    return this.svc.setParent(userId, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete database' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.remove(userId, id);
  }
}
