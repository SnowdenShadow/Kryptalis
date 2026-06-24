import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CronService } from './cron.service';
import { CreateCronJobDto } from './dto/create-cron-job.dto';
import { UpdateCronJobDto } from './dto/update-cron-job.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Cron')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('cron-jobs')
export class CronController {
  constructor(private svc: CronService) {}

  @Get()
  @ApiOperation({ summary: 'List cron jobs (optionally filtered by application)' })
  list(@CurrentUser('id') userId: string, @Query('applicationId') applicationId?: string) {
    return this.svc.list(userId, applicationId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a cron job on an application' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateCronJobDto) {
    return this.svc.create(userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a cron job' })
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdateCronJobDto) {
    return this.svc.update(userId, id, dto);
  }

  @Post(':id/run')
  @ApiOperation({ summary: 'Run a cron job now (manual trigger)' })
  runNow(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.runNow(userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a cron job' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.remove(userId, id);
  }
}
