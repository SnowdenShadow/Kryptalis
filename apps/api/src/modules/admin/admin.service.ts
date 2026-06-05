import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { Role, UserStatus } from '@prisma/client';

const SETTING_KEYS = [
  'registration_enabled',
  'require_admin_approval',
  'default_user_role',
  'platform_name',
  'maintenance_mode',
  'deployment_mode',
] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // ── settings ──────────────────────────────────────────────────────

  /**
   * Returns 'LOCAL' or 'MULTI'. Default 'LOCAL' for safety.
   */
  async getDeploymentMode(): Promise<'LOCAL' | 'MULTI'> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: 'deployment_mode' },
    });
    const v = row?.value as string | undefined;
    return v === 'MULTI' ? 'MULTI' : 'LOCAL';
  }

  async getSettings(): Promise<Record<SettingKey, unknown>> {
    const rows = await this.prisma.systemSetting.findMany();
    const out: Record<string, unknown> = {};
    for (const k of SETTING_KEYS) out[k] = null;
    for (const r of rows) out[r.key] = r.value;
    return out as Record<SettingKey, unknown>;
  }

  async updateSetting(key: string, value: unknown, actorId: string) {
    if (!SETTING_KEYS.includes(key as SettingKey)) {
      throw new BadRequestException(`Unknown setting: ${key}`);
    }
    return this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: value as any, updatedBy: actorId },
      update: { value: value as any, updatedBy: actorId },
    });
  }

  async getPublicSettings() {
    const rows = await this.prisma.systemSetting.findMany({
      where: {
        key: { in: ['registration_enabled', 'platform_name', 'maintenance_mode', 'deployment_mode'] },
      },
    });
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ── users ─────────────────────────────────────────────────────────

  async listUsers(opts: { search?: string; role?: Role; status?: UserStatus; skip?: number; take?: number }) {
    const where: any = {};
    if (opts.search) {
      where.OR = [
        { email: { contains: opts.search, mode: 'insensitive' } },
        { name: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    if (opts.role) where.role = opts.role;
    if (opts.status) where.status = opts.status;

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          twoFactorEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          _count: {
            select: {
              projects: true,
              memberships: true,
              gitProviders: true,
              deployments: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: opts.skip ?? 0,
        take: Math.min(opts.take ?? 50, 200),
      }),
    ]);
    return { total, users };
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        twoFactorEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        projects: { select: { id: true, name: true } },
        memberships: {
          select: {
            role: true,
            project: { select: { id: true, name: true } },
          },
        },
        gitProviders: {
          select: { id: true, provider: true, name: true, username: true, createdAt: true },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async createUser(
    actor: { id: string; role: Role },
    payload: { name: string; email: string; password: string; role: Role },
  ) {
    if (await this.prisma.user.findUnique({ where: { email: payload.email } })) {
      throw new BadRequestException('Email already in use');
    }
    this.assertCanGrantRole(actor.role, payload.role);
    const hash = await bcrypt.hash(payload.password, 12);
    return this.prisma.user.create({
      data: {
        name: payload.name,
        email: payload.email,
        password: hash,
        role: payload.role,
        status: 'ACTIVE',
      },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
    });
  }

  async updateUserRole(actor: { id: string; role: Role }, userId: string, role: Role) {
    if (actor.id === userId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanModifyTarget(actor.role, target.role);
    this.assertCanGrantRole(actor.role, role);
    return this.prisma.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, email: true, role: true },
    });
  }

  async updateUserStatus(actor: { id: string; role: Role }, userId: string, status: UserStatus) {
    if (actor.id === userId) {
      throw new BadRequestException('You cannot suspend or ban yourself');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanModifyTarget(actor.role, target.role);
    return this.prisma.user.update({
      where: { id: userId },
      data: { status },
      select: { id: true, email: true, status: true },
    });
  }

  async resetUserPassword(actor: { id: string; role: Role }, userId: string, newPassword: string) {
    if (newPassword.length < 8) throw new BadRequestException('Password too short (min 8)');
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanModifyTarget(actor.role, target.role);
    const hash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hash } });
    // invalidate sessions
    await this.prisma.session.deleteMany({ where: { userId } });
    return { message: 'Password reset and sessions revoked' };
  }

  async deleteUser(actor: { id: string; role: Role }, userId: string) {
    if (actor.id === userId) {
      throw new BadRequestException('You cannot delete your own account here');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!target) throw new NotFoundException('User not found');
    this.assertCanModifyTarget(actor.role, target.role);
    if (target.role === 'SUPERADMIN') {
      // never let the last superadmin be deleted
      const count = await this.prisma.user.count({ where: { role: 'SUPERADMIN' } });
      if (count <= 1) {
        throw new BadRequestException('Cannot delete the last SUPERADMIN');
      }
    }
    await this.prisma.user.delete({ where: { id: userId } });
    return { message: 'User deleted' };
  }

  // ── stats / overview ──────────────────────────────────────────────

  async getOverview() {
    const [users, projects, apps, deployments, gitProviders, recentSignups, runningApps, errorApps] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.project.count(),
      this.prisma.application.count(),
      this.prisma.deployment.count(),
      this.prisma.gitProvider.count(),
      this.prisma.user.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, email: true, createdAt: true, status: true },
      }),
      this.prisma.application.count({ where: { status: 'RUNNING' } }),
      this.prisma.application.count({ where: { status: 'ERROR' } }),
    ]);
    const dau = await this.prisma.user.count({
      where: { lastLoginAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
    });
    return {
      totals: { users, projects, apps, deployments, gitProviders, runningApps, errorApps, dau },
      recentSignups,
    };
  }

  async listAuditLogs(opts: { skip?: number; take?: number; userId?: string }) {
    const where: any = {};
    if (opts.userId) where.userId = opts.userId;
    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: opts.skip ?? 0,
        take: Math.min(opts.take ?? 100, 200),
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
    ]);
    return { total, logs };
  }

  // ── guardrails ────────────────────────────────────────────────────

  /** A SUPERADMIN can grant anything. An ADMIN cannot grant ADMIN or SUPERADMIN. */
  private assertCanGrantRole(actorRole: Role, targetRole: Role) {
    if (actorRole === 'SUPERADMIN') return;
    if (actorRole === 'ADMIN') {
      if (targetRole === 'SUPERADMIN' || targetRole === 'ADMIN') {
        throw new ForbiddenException('Only SUPERADMIN can grant ADMIN/SUPERADMIN roles');
      }
      return;
    }
    throw new ForbiddenException('Forbidden');
  }

  /** An ADMIN cannot modify other ADMIN/SUPERADMIN users. */
  private assertCanModifyTarget(actorRole: Role, targetRole: Role) {
    if (actorRole === 'SUPERADMIN') return;
    if (actorRole === 'ADMIN') {
      if (targetRole === 'ADMIN' || targetRole === 'SUPERADMIN') {
        throw new ForbiddenException('Only SUPERADMIN can modify other admins');
      }
      return;
    }
    throw new ForbiddenException('Forbidden');
  }
}
