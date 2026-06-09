import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SystemUpdatesService } from './system-updates.service';

@ApiTags('System')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN', 'SUPERADMIN')
@Controller('system')
export class SystemController {
  constructor(private updates: SystemUpdatesService) {}

  @Get('updates')
  @ApiOperation({ summary: 'Current update state (poll-based)' })
  getStatus() {
    return this.updates.getStatus();
  }

  @Get('updates/log')
  @ApiOperation({ summary: 'In-memory log of the last update.sh run' })
  getLog() {
    return this.updates.getLog();
  }

  @Post('updates/check')
  @ApiOperation({ summary: 'Force an immediate poll (instead of waiting for the 60s tick)' })
  check() {
    return this.updates.forceCheck();
  }

  @Post('updates/apply')
  @ApiOperation({ summary: 'Force an update run (bypasses the SHA check)' })
  apply() {
    return this.updates.forceUpdate();
  }
}
