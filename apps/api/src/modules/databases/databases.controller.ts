import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Res } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { DatabasesService } from './databases.service';
import { CreateDatabaseDto } from './dto/create-database.dto';
import { ResetPasswordDto, ChangeUsernameDto } from './dto/update-credentials.dto';
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

  @Post(':id/restart')
  @ApiOperation({ summary: 'Restart database' })
  restart(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.restart(userId, id);
  }

  @Post(':id/reset-password')
  @ApiOperation({ summary: "Reset the database user's password (applies in-container + refreshes linked app)" })
  resetPassword(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.svc.resetPassword(userId, id, dto);
  }

  @Patch(':id/username')
  @ApiOperation({ summary: 'Rename the database user (applies in-container + refreshes linked app)' })
  changeUsername(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: ChangeUsernameDto) {
    return this.svc.changeUsername(userId, id, dto);
  }

  @Get(':id/connection')
  @ApiOperation({ summary: 'Full connection info (host/port/user/password/url, public + in-network)' })
  connection(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.connectionInfo(userId, id);
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'Export (download) a logical dump of the database' })
  async export(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { stream, filename, cleanup } = await this.svc.exportDump(userId, id);
    // RFC 5987 filename + ASCII fallback — blocks Content-Disposition header
    // injection via CRLF/" in the (sanitized) basename.
    const asciiSafe = filename.replace(/[^\x20-\x7e]/g, '_');
    const encoded = encodeURIComponent(filename);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`,
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    const done = () => { if (cleanup) cleanup(); };
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', (err: Error) => {
      done();
      // Headers may already be sent (streaming started) — destroy so the
      // client sees a failed transfer instead of a truncated, silently
      // corrupt dump.
      try { res.destroy(err); } catch {}
    });
    stream.pipe(res);
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
