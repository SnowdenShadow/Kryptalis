import {
  Controller,
  Get,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateNotificationPrefsDto } from './dto/update-notification-prefs.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

/**
 * /users is a thin self-service surface:
 *   - GET /users/me               — own profile (any authenticated user)
 *   - PATCH /users/me             — update own profile (display name only)
 *
 * Cross-user CRUD lives under /admin/users (gated to ADMIN/SUPERADMIN with
 * the assertCanModifyTarget hierarchy enforced in AdminService). We used to
 * also expose findAll/findOne/update/remove here with only JWT auth, which
 * let any logged-in user dump every user's email/role and even delete other
 * accounts. Those are now ADMIN-only and routed through assertCanModifyTarget.
 */
@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@CurrentUser('id') userId: string) {
    return this.usersService.findOne(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update own profile' })
  updateMe(@CurrentUser('id') userId: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(userId, dto);
  }

  @Get('me/notification-preferences')
  @ApiOperation({ summary: 'Get own notification preferences' })
  getNotificationPrefs(@CurrentUser('id') userId: string) {
    return this.usersService.getNotificationPrefs(userId);
  }

  @Put('me/notification-preferences')
  @ApiOperation({ summary: 'Replace own notification preferences' })
  updateNotificationPrefs(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateNotificationPrefsDto,
  ) {
    return this.usersService.updateNotificationPrefs(userId, dto.prefs);
  }

  @Get()
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'List all users (admin only)' })
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Get user by ID (admin only)' })
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Update user (admin only — ADMIN cannot modify other ADMIN/SUPERADMIN)' })
  update(
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateAsAdmin(actorId, id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Delete user (admin only — hierarchy enforced)' })
  remove(@CurrentUser('id') actorId: string, @Param('id') id: string) {
    if (actorId === id) {
      throw new ForbiddenException(
        'You cannot delete yourself — ask another admin or use the admin panel.',
      );
    }
    return this.usersService.removeAsAdmin(actorId, id);
  }
}
