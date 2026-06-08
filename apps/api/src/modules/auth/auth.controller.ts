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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

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
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Login (TOTP code required when 2FA is enabled)' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Refresh tokens' })
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.authService.refreshTokens(dto.refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Logout (revokes the refresh-token family)' })
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Verify email with a one-time token and receive a token pair' })
  verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    return this.authService.verifyEmail(dto.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
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
