import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
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
  @ApiOperation({ summary: 'Current update status (SHA, branch, last run)' })
  getStatus() {
    return this.updates.getStatus();
  }

  @Get('updates/log')
  @ApiOperation({ summary: 'Tail of the update.sh log file' })
  async getLog() {
    return { log: await this.updates.getLog() };
  }

  @Post('updates/check')
  @ApiOperation({ summary: 'Force a fetch from origin (does not rebuild)' })
  check() {
    return this.updates.checkNow();
  }

  @Post('updates/apply')
  @ApiOperation({ summary: 'Pull + rebuild now (instead of waiting for the timer)' })
  apply() {
    return this.updates.applyNow();
  }

  @Post('updates/auto')
  @ApiOperation({ summary: 'Enable or disable the 10-min auto-update timer' })
  setAuto(@Body('enabled') enabled: boolean) {
    return this.updates.setAutoUpdate(!!enabled);
  }
}
