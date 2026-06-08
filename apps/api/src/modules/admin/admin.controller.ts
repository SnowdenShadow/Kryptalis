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
import { Role, UserStatus } from '@prisma/client';
import { AdminService } from './admin.service';
import { ReaperService } from './reaper.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN', 'SUPERADMIN')
@Controller('admin')
export class AdminController {
  constructor(private svc: AdminService, private reaper: ReaperService) {}

  // ── docker reaper ─────────────────────────────────────────────────

  @Get('reaper/scan')
  @ApiOperation({ summary: 'Dry-run: list orphan docker artefacts (containers / images / volumes / networks)' })
  reaperScan() {
    return this.reaper.scan();
  }

  @Post('reaper/reap')
  @ApiOperation({ summary: 'Delete every orphan flagged by /reaper/scan' })
  reaperReap() {
    return this.reaper.reap();
  }

  @Get('overview')
  @ApiOperation({ summary: 'Platform overview (stats + recent signups)' })
  overview() {
    return this.svc.getOverview();
  }

  // ── settings ──────────────────────────────────────────────────────

  @Get('settings')
  @ApiOperation({ summary: 'List all system settings' })
  settings() {
    return this.svc.getSettings();
  }

  @Patch('settings/:key')
  @ApiOperation({ summary: 'Update a system setting' })
  updateSetting(
    @CurrentUser('id') userId: string,
    @Param('key') key: string,
    @Body('value') value: unknown,
  ) {
    return this.svc.updateSetting(key, value, userId);
  }

  // ── runtime config (Admin → System Config tab) ────────────────────

  @Get('config')
  @ApiOperation({ summary: 'Public snapshot of runtime config (secrets masked)' })
  getConfig() {
    return this.svc.getConfigSnapshot();
  }

  @Patch('config')
  @ApiOperation({ summary: 'Update runtime config (SMTP, URLs, retention, etc.)' })
  updateConfig(
    @CurrentUser('id') userId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.svc.updateConfigBulk(body, userId);
  }

  @Post('config/test-smtp')
  @ApiOperation({ summary: 'Send a test email using current SMTP config' })
  testSmtp(
    @CurrentUser('id') userId: string,
    @Body() body: { to?: string },
  ) {
    return this.svc.testSmtp(userId, body.to);
  }

  // ── users ─────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'List users' })
  listUsers(
    @Query('search') search?: string,
    @Query('role') role?: Role,
    @Query('status') status?: UserStatus,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.listUsers({
      search,
      role,
      status,
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get a single user' })
  getUser(@Param('id') id: string) {
    return this.svc.getUser(id);
  }

  @Post('users')
  @ApiOperation({ summary: 'Create a user (admin only)' })
  createUser(
    @CurrentUser() actor: { id: string; role: Role },
    @Body() body: { name: string; email: string; password: string; role: Role },
  ) {
    return this.svc.createUser(actor, body);
  }

  @Patch('users/:id/role')
  @ApiOperation({ summary: 'Change a user role' })
  changeRole(
    @CurrentUser() actor: { id: string; role: Role },
    @Param('id') id: string,
    @Body('role') role: Role,
  ) {
    return this.svc.updateUserRole(actor, id, role);
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Suspend / ban / reactivate a user' })
  changeStatus(
    @CurrentUser() actor: { id: string; role: Role },
    @Param('id') id: string,
    @Body('status') status: UserStatus,
  ) {
    return this.svc.updateUserStatus(actor, id, status);
  }

  @Post('users/:id/reset-password')
  @ApiOperation({ summary: 'Reset a user password' })
  resetPassword(
    @CurrentUser() actor: { id: string; role: Role },
    @Param('id') id: string,
    @Body('password') password: string,
  ) {
    return this.svc.resetUserPassword(actor, id, password);
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Delete a user' })
  deleteUser(
    @CurrentUser() actor: { id: string; role: Role },
    @Param('id') id: string,
  ) {
    return this.svc.deleteUser(actor, id);
  }

  // ── audit ─────────────────────────────────────────────────────────

  @Get('audit-logs')
  @ApiOperation({ summary: 'Recent audit log entries' })
  audit(
    @Query('userId') userId?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.listAuditLogs({
      userId,
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }
}
