import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * In-app notification feed. Strictly self-scoped: every route operates on
 * the authenticated user's own rows (the service WHEREs on userId), so no
 * RolesGuard is needed — a USER simply has an empty feed unless an event
 * targeted them directly.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List my notifications (newest first)' })
  list(
    @CurrentUser('id') userId: string,
    @Query('unread') unread?: string,
    @Query('take') take?: string,
  ) {
    const takeNum = take ? Number.parseInt(take, 10) : undefined;
    return this.svc.listNotifications(userId, {
      unread: unread === 'true',
      take: Number.isFinite(takeNum) ? takeNum : undefined,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count my unread notifications' })
  unreadCount(@CurrentUser('id') userId: string) {
    return this.svc.unreadCount(userId);
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one of my notifications as read' })
  markRead(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.markRead(userId, id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  markAllRead(@CurrentUser('id') userId: string) {
    return this.svc.markAllRead(userId);
  }
}
