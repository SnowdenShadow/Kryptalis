import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { GitService } from './git.service';

@ApiTags('Git')
@Controller('git')
export class GitController {
  constructor(private svc: GitService) {}

  @Get('providers')
  @ApiOperation({ summary: 'List git providers' })
  providers() { return this.svc.getProviders(); }

  @Post('webhooks/:applicationId')
  @ApiOperation({ summary: 'Git webhook endpoint' })
  webhook(@Param('applicationId') id: string, @Body() payload: any) {
    return this.svc.handleWebhook(id, payload);
  }
}
