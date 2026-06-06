import { Controller, Get, Post, Body, UseGuards, Req, Headers, HttpCode } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SystemUpdatesService } from './system-updates.service';

/**
 * GitHub webhook is PUBLIC (no JWT) — auth is the HMAC signature in the
 * X-Hub-Signature-256 header verified against the per-install secret. So
 * the webhook route lives on a separate controller without the auth guards.
 */
@ApiTags('System')
@Controller('system')
export class SystemWebhookController {
  constructor(private updates: SystemUpdatesService) {}

  @Post('updates/webhook')
  @HttpCode(202)
  @ApiOperation({ summary: 'GitHub push webhook → trigger self-update (no JWT — HMAC-verified)' })
  async webhook(
    @Req() req: any,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-event') eventType: string,
  ) {
    return this.updates.handleGithubWebhook(req.rawBody, signature, eventType);
  }
}

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

  @Post('updates/webhook/rotate')
  @ApiOperation({ summary: 'Rotate the GitHub webhook secret (must re-paste in GitHub)' })
  rotateWebhook() {
    return this.updates.rotateWebhookSecret();
  }
}
