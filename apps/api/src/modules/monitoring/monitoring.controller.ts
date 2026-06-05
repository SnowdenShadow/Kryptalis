import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { MonitoringService } from './monitoring.service';
import { CreateAlertRuleDto } from './dto/create-alert-rule.dto';

@ApiTags('Monitoring')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('monitoring')
export class MonitoringController {
  constructor(private svc: MonitoringService) {}

  @Get('servers/:serverId/metrics')
  @ApiOperation({ summary: 'Get server metrics' })
  metrics(@Param('serverId') serverId: string, @Query('period') period?: string) {
    return this.svc.getMetrics(serverId, period);
  }

  @Post('alert-rules')
  @ApiOperation({ summary: 'Create alert rule' })
  createRule(@Body() dto: CreateAlertRuleDto) { return this.svc.createAlertRule(dto); }

  @Get('alert-rules')
  @ApiOperation({ summary: 'List alert rules' })
  getRules(@Query('serverId') serverId?: string) { return this.svc.getAlertRules(serverId); }

  @Delete('alert-rules/:id')
  @ApiOperation({ summary: 'Delete alert rule' })
  deleteRule(@Param('id') id: string) { return this.svc.deleteAlertRule(id); }
}
