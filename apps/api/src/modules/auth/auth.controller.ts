import {
  Controller,
  Post,
  Patch,
  Get,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  REFRESH_COOKIE_NAME,
  refreshCookieOptions,
  extractRefreshToken,
  isSecureContext,
  parseTtlMs,
} from './auth-cookie';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private config: ConfigService,
  ) {}

  // ── refresh-token cookie plumbing ──────────────────────────────────
  //
  // Every endpoint that returns a token pair ALSO sets the refresh token
  // as an httpOnly cookie scoped to /api/auth. The JSON body keeps the
  // refreshToken field for backward compatibility — new dashboard builds
  // simply never store it. See auth-cookie.ts for the policy itself.

  private setRefreshCookie(req: Request, res: Response, refreshToken?: string) {
    if (!refreshToken) return;
    const isHttps = isSecureContext(req, this.config.get<string>('PUBLIC_API_URL', ''));
    const maxAge = parseTtlMs(this.config.get<string>('JWT_REFRESH_EXPIRATION', '7d'));
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(isHttps, maxAge));
  }

  private clearRefreshCookie(req: Request, res: Response) {
    const isHttps = isSecureContext(req, this.config.get<string>('PUBLIC_API_URL', ''));
    // clearCookie must repeat the same path/flags or the browser keeps the
    // original cookie alive. maxAge is irrelevant for deletion.
    const opts = refreshCookieOptions(isHttps);
    delete opts.maxAge;
    res.clearCookie(REFRESH_COOKIE_NAME, opts);
  }

  /** Cookie-first, body-fallback refresh-token lookup. */
  private refreshTokenFrom(req: Request, dto?: { refreshToken?: string }): string | undefined {
    return extractRefreshToken(
      (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME],
      dto?.refreshToken,
    );
  }

  /**
   * Public endpoint — tells the dashboard whether this install needs to
   * run the first-admin wizard. Drives the redirect on the landing page:
   * `needsSetup: true` → /register (with a "you're the first user" hint);
   * `false` → /login as usual. Throttled lightly so a bot can't probe
   * for "is this install fresh" cheaply, but not so tight that legit
   * page loads get blocked.
   */
  @Get('setup-status')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Whether the first SUPERADMIN still needs to be created' })
  setupStatus() {
    return this.authService.getSetupStatus();
  }

  // Tight throttler on the unauthenticated endpoints — defends against
  // brute-force and credential-stuffing without slowing down legit users.
  @Post('register')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Register a new account' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    // Bootstrap (first-install) path returns tokens immediately — cookie
    // it like a login so the fresh SUPERADMIN session can refresh.
    this.setRefreshCookie(req, res, (result as { refreshToken?: string }).refreshToken);
    return result;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Login (TOTP code required when 2FA is enabled)' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setRefreshCookie(req, res, result.refreshToken);
    return result;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Refresh tokens (httpOnly cookie preferred, body fallback)' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(req, dto);
    const result = await this.authService.refreshTokens(token ?? '', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setRefreshCookie(req, res, result.refreshToken);
    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Logout (revokes the refresh-token family)' })
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(req, dto);
    const result = await this.authService.logout(token ?? '');
    this.clearRefreshCookie(req, res);
    return result;
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Verify email with a one-time token and receive a token pair' })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyEmail(dto.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setRefreshCookie(req, res, result.refreshToken);
    return result;
  }

  // 3/hour per IP — the throttler is the real anti-enumeration / anti-spam
  // gate (the service returns a generic success either way).
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60 * 60_000, limit: 3 } })
  @ApiOperation({ summary: 'Re-send verification email (always returns generic success)' })
  resendVerification(@Body() body: { email: string }) {
    return this.authService.resendVerification(body.email);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: 'Request a password reset link by email' })
  forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Reset password using a one-time token' })
  resetPassword(
    @Body() body: { token: string; newPassword: string; totpCode?: string; backupCode?: string },
  ) {
    return this.authService.resetPassword(body.token, body.newPassword, {
      totpCode: body.totpCode,
      backupCode: body.backupCode,
    });
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Current user' })
  me(@CurrentUser() user: { id: string }) {
    return this.authService.getMe(user.id);
  }

  @Patch('profile')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Update name / email of the current user' })
  updateProfile(
    @CurrentUser() user: { id: string },
    @Body() body: { name?: string; email?: string },
  ) {
    return this.authService.updateProfile(user.id, body);
  }

  @Post('change-password')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change own password (current → new)' })
  changePassword(
    @CurrentUser() user: { id: string },
    @Body() body: { currentPassword: string; newPassword: string; totpCode?: string; backupCode?: string },
  ) {
    return this.authService.changePassword(user.id, body);
  }

  // ── sessions ───────────────────────────────────────────────────────

  @Get('sessions')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'List the caller’s active/pending sessions' })
  listSessions(@CurrentUser() user: { id: string; sessionId?: string }) {
    return this.authService.listSessions(user.id, user.sessionId);
  }

  @Delete('sessions/:id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a single session (revokes all OTHERS if it is the current one)' })
  revokeSession(
    @CurrentUser() user: { id: string; sessionId?: string },
    @Param('id') id: string,
  ) {
    return this.authService.revokeSession(user.id, id, user.sessionId);
  }

  @Delete('sessions')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log out everywhere else (revoke all sessions except current)' })
  revokeOtherSessions(@CurrentUser() user: { id: string; sessionId?: string }) {
    return this.authService.revokeOtherSessions(user.id, user.sessionId);
  }

  // ── onboarding ─────────────────────────────────────────────────────

  @Get('me/onboarding')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Whether the current user has completed first-run onboarding' })
  getOnboarding(@CurrentUser() user: { id: string }) {
    return this.authService.getOnboarding(user.id);
  }

  @Post('me/onboarding/complete')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark first-run onboarding as completed for the current user' })
  completeOnboarding(@CurrentUser() user: { id: string }) {
    return this.authService.completeOnboarding(user.id);
  }

  // ── 2FA ────────────────────────────────────────────────────────────

  @Post('2fa/setup')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a TOTP secret + otpauth URI for enrollment' })
  setup2fa(@CurrentUser() user: { id: string }) {
    return this.authService.startTwoFactorSetup(user.id);
  }

  @Post('2fa/enable')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm enrollment with a TOTP code and receive backup codes' })
  enable2fa(@CurrentUser() user: { id: string }, @Body() body: { code: string }) {
    return this.authService.enableTwoFactor(user.id, body.code);
  }

  @Post('2fa/disable')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable 2FA (requires password + current TOTP code)' })
  disable2fa(
    @CurrentUser() user: { id: string },
    @Body() body: { password: string; code: string },
  ) {
    return this.authService.disableTwoFactor(user.id, body.password, body.code);
  }
}
