import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DeploymentsService } from './deployments.service';
import { TriggerDeploymentDto } from './dto/trigger-deployment.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Deployments')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('deployments')
export class DeploymentsController {
  constructor(private svc: DeploymentsService) {}

  @Post()
  @ApiOperation({ summary: 'Trigger deployment' })
  trigger(@CurrentUser('id') userId: string, @Body() dto: TriggerDeploymentDto) {
    return this.svc.trigger(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List deployments' })
  findAll(
    @CurrentUser('id') userId: string,
    @Query('applicationId') applicationId?: string,
  ) {
    return this.svc.findAll(userId, applicationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get deployment' })
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.findOne(userId, id);
  }
}
