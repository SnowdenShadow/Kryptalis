import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { GitService } from './git.service';

/**
 * /git exposes ONLY a read of the available providers, gated by JWT.
 *
 * The previous unauthenticated POST /git/webhooks/:applicationId route is
 * removed: it forged Deployment rows with no HMAC verification and attributed
 * them to whichever user had the lowest createdAt (typically a superadmin).
 * The legitimate webhook entrypoint is /webhooks/applications/:id
 * (ApplicationWebhooksController), which signs and verifies.
 */
@ApiTags('Git')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('git')
export class GitController {
  constructor(private svc: GitService) {}

  @Get('providers')
  @ApiOperation({ summary: 'List git providers' })
  providers() {
    return this.svc.getProviders();
  }
}
