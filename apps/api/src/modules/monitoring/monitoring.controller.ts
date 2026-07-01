import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { MonitoringService } from './monitoring.service';
import { CreateAlertRuleDto } from './dto/create-alert-rule.dto';
import { UpdateAlertRuleDto } from './dto/update-alert-rule.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

/**
 * Monitoring is project-scoped on read (callers see metrics/alert-rules for
 * servers their projects live on) and admin-only on mutation. Server-wide
 * stats can expose load patterns / topology, so we don't leak them across
 * tenants.
 */
@ApiTags('Monitoring')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('monitoring')
export class MonitoringController {
  constructor(private svc: MonitoringService) {}

  @Get('servers/:serverId/metrics')
  @ApiOperation({ summary: 'Get server metrics (must have project access on this server)' })
  metrics(
    @CurrentUser('id') userId: string,
    @Param('serverId') serverId: string,
    @Query('period') period?: string,
  ) {
    return this.svc.getMetrics(userId, serverId, period);
  }

  @Get('applications/:appId/metrics')
  @ApiOperation({ summary: 'Per-container resource history for an app (project access required)' })
  appMetrics(
    @CurrentUser('id') userId: string,
    @Param('appId') appId: string,
    @Query('period') period?: string,
  ) {
    return this.svc.getAppMetrics(userId, appId, period);
  }

  @Get('containers/overview')
  @ApiOperation({ summary: 'Latest resource usage per container across accessible servers' })
  containerOverview(@CurrentUser('id') userId: string) {
    return this.svc.getContainerOverview(userId);
  }

  @Post('alert-rules')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Create alert rule (admin only)' })
  createRule(@Body() dto: CreateAlertRuleDto) {
    return this.svc.createAlertRule(dto);
  }

  @Get('alert-rules')
  @ApiOperation({ summary: 'List alert rules scoped to accessible servers' })
  getRules(@CurrentUser('id') userId: string, @Query('serverId') serverId?: string) {
    return this.svc.getAlertRules(userId, serverId);
  }

  @Patch('alert-rules/:id')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Update alert rule (admin only)' })
  updateRule(@Param('id') id: string, @Body() dto: UpdateAlertRuleDto) {
    return this.svc.updateAlertRule(id, dto);
  }

  @Delete('alert-rules/:id')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Delete alert rule (admin only)' })
  deleteRule(@Param('id') id: string) {
    return this.svc.deleteAlertRule(id);
  }
}
