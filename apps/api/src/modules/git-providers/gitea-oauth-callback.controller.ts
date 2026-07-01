import { Controller, Get, Query, Res, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { GitOAuthService } from './git-oauth.service';

/**
 * Public OAuth callback for self-hosted Gitea/Forgejo. Separate from
 * GitProvidersController because that controller is JWT-guarded at the class
 * level, and THIS route is hit by the user's BROWSER coming back from the Gitea
 * instance — it carries no Bearer token. Identity is instead proven by the
 * single-use `state` we minted in startGiteaOAuth (CSRF binding), so the route
 * is safe to expose unauthenticated (same rationale as the webhook receiver).
 *
 * On success/failure we 302 the browser back to the dashboard with an `oauth`
 * result marker rather than rendering anything here.
 */
@ApiTags('Git Providers')
@Controller('git-providers/oauth/gitea')
export class GiteaOAuthCallbackController {
  private readonly logger = new Logger('GiteaOAuth');

  constructor(private oauth: GitOAuthService) {}

  @Get('callback')
  @ApiOperation({ summary: 'Gitea/Forgejo OAuth redirect callback (browser-facing, public)' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    const base = (process.env.PUBLIC_DASHBOARD_URL || process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    const dest = (result: string) =>
      `${base}/dashboard/settings?tab=git&oauth=${result}`;
    try {
      await this.oauth.handleGiteaCallback(code, state);
      res.redirect(dest('gitea_ok'));
    } catch (err) {
      // Never reflect the error detail into the redirect (avoid an open
      // reflection); log it and send a generic marker the dashboard toasts.
      this.logger.warn(`gitea callback failed: ${(err as Error).message}`);
      res.redirect(dest('gitea_err'));
    }
  }
}
