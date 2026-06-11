import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  twoFactorEnabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Whitelists for the notificationPrefs Json column — anything outside is
// silently dropped so a crafted payload can't bloat the row.
const NOTIF_EVENTS = [
  'deployOk',
  'deployFail',
  'serverOff',
  'sslExpire',
  'backupOk',
  'backupFail',
] as const;
// Only email delivery is implemented at the user level today — re-extend
// this whitelist (and the settings UI columns) when discord/slack/webhook
// user-level channels exist.
const NOTIF_CHANNELS = ['email'] as const;

export type NotificationPrefs = Record<string, Record<string, boolean>>;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.user.findMany({ select: USER_SELECT });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: USER_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async update(id: string, dto: UpdateUserDto) {
    await this.findOne(id);
    return this.prisma.user.update({
      where: { id },
      data: dto,
      select: USER_SELECT,
    });
  }

  /**
   * Update + role-hierarchy-aware variant. Used by the public /users CRUD
   * (admin path) to make sure an ADMIN can never modify another ADMIN or a
   * SUPERADMIN (only SUPERADMIN can). Self-edits via /users/me are allowed
   * regardless.
   */
  async updateAsAdmin(actorId: string, targetId: string, dto: UpdateUserDto) {
    if (actorId !== targetId) {
      await this.assertCanModifyTarget(actorId, targetId);
    }
    return this.update(targetId, dto);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.user.delete({ where: { id } });
    return { message: 'User deleted' };
  }

  /**
   * Hierarchy-aware delete. Refuses an ADMIN trying to wipe another ADMIN
   * or a SUPERADMIN. Self-delete is rejected at the controller layer
   * (no admin should accidentally wipe their own account from the admin
   * users panel — use the admin dashboard's dedicated flow).
   */
  async removeAsAdmin(actorId: string, targetId: string) {
    await this.assertCanModifyTarget(actorId, targetId);
    return this.remove(targetId);
  }

  // ── notification preferences ─────────────────────────────────────

  async getNotificationPrefs(userId: string): Promise<{ prefs: NotificationPrefs }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return { prefs: (user.notificationPrefs as NotificationPrefs | null) ?? {} };
  }

  async updateNotificationPrefs(
    userId: string,
    prefs: NotificationPrefs,
  ): Promise<{ prefs: NotificationPrefs }> {
    const sanitized: NotificationPrefs = {};
    for (const event of NOTIF_EVENTS) {
      const channels = prefs?.[event];
      if (!channels || typeof channels !== 'object') continue;
      const row: Record<string, boolean> = {};
      for (const channel of NOTIF_CHANNELS) {
        if (typeof channels[channel] === 'boolean') row[channel] = channels[channel];
      }
      if (Object.keys(row).length > 0) sanitized[event] = row;
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: sanitized },
      select: { notificationPrefs: true },
    });
    return { prefs: (updated.notificationPrefs as NotificationPrefs | null) ?? {} };
  }

  // ── role hierarchy ────────────────────────────────────────────────

  private async assertCanModifyTarget(actorId: string, targetId: string) {
    const [actor, target] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: actorId }, select: { role: true } }),
      this.prisma.user.findUnique({ where: { id: targetId }, select: { role: true } }),
    ]);
    if (!actor) throw new NotFoundException('Actor user not found');
    if (!target) throw new NotFoundException('Target user not found');
    if (actor.role === 'SUPERADMIN') return;
    if (actor.role === 'ADMIN') {
      if (target.role === 'ADMIN' || target.role === 'SUPERADMIN') {
        throw new ForbiddenException('Only SUPERADMIN can modify other admins.');
      }
      return;
    }
    throw new ForbiddenException('You do not have permission to modify this user.');
  }
}
