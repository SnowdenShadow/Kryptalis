import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { Role, UserStatus } from '@prisma/client';
import { SystemConfigService } from '../system/system-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';

const AUDIT_LOG_RETENTION_DAYS = 365;
const AUDIT_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

const SETTING_KEYS = [
  'registration_enabled',
  'require_admin_approval',
  'default_user_role',
  'platform_name',
  'maintenance_mode',
  'deployment_mode',
  // Public hostname the DASHBOARD itself is served on (e.g.
  // panel.acme.com). When set, Caddy renders a block serving the dashboard
  // + proxying /api/* — https://<domain> replaces http://ip:3000.
  'system_domain',
] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

@Injectable()
export class AdminService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminService.name);
  private auditLogCleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    private systemConfig: SystemConfigService,
    private notifications: NotificationsService,
    // @Global ReverseProxyModule — system_domain changes re-render the
    // Caddyfile so the dashboard block appears/disappears immediately.
    private proxy: ReverseProxyService,
  ) {}

  /** Snapshot of runtime config for the Admin UI. Secrets are masked. */
  getConfigSnapshot() {
    return this.systemConfig.getPublicSnapshot();
  }

  /**
   * Bulk update of runtime config. The frontend posts the full diff;
   * any key whose value is empty string AND was previously a secret is
   * treated as 'no change' (so users can leave the SMTP password field
   * blank to keep the existing one). Any key explicitly set to null
   * deletes that override (reverts to env / default).
   */
  async updateConfigBulk(updates: Record<string, any>, actorId: string) {
    const SECRET_KEYS = new Set([
      'smtp_pass',
      'backup_encryption_key',
      'github_webhook_secret',
      's3_access_key',
      's3_secret_key',
    ]);
    const cleaned: Record<string, any> = {};
    const removed: string[] = [];
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) {
        removed.push(k);
        continue;
      }
      if (SECRET_KEYS.has(k) && (v === '' || v === undefined)) {
        // Blank field on a secret → keep existing value.
        continue;
      }
      cleaned[k] = v;
    }
    if (Object.keys(cleaned).length > 0) {
      await this.systemConfig.setMany(cleaned, actorId);
    }
    for (const k of removed) {
      await this.systemConfig.unset(k);
    }
    return { updated: Object.keys(cleaned).length, removed: removed.length };
  }

  /**
   * Send a test email to verify SMTP creds without leaving the dashboard.
   * Defaults the recipient to the actor's own email.
   */
  async testSmtp(actorId: string, to?: string): Promise<{ ok: true; sentTo: string }> {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { email: true, name: true },
    });
    if (!actor) {
      throw new BadRequestException('Actor not found.');
    }
    const recipient = (to || actor.email).trim();
    if (!recipient || !/.+@.+\..+/.test(recipient)) {
      throw new BadRequestException('Invalid recipient email.');
    }
    await this.notifications.sendTestEmail(recipient, actor.name);
    return { ok: true, sentTo: recipient };
  }

  onModuleInit() {
    // Run once at startup, then hourly
    void this.cleanupAuditLogs();
    this.auditLogCleanupTimer = setInterval(
      () => void this.cleanupAuditLogs(),
      AUDIT_LOG_CLEANUP_INTERVAL_MS,
    );
  }

  onModuleDestroy() {
    if (this.auditLogCleanupTimer) {
      clearInterval(this.auditLogCleanupTimer);
      this.auditLogCleanupTimer = null;
    }
  }

  private async cleanupAuditLogs() {
    try {
      const cutoff = new Date(
        Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const result = await this.prisma.auditLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        this.logger.log(
          `Pruned ${result.count} AuditLog rows older than ${AUDIT_LOG_RETENTION_DAYS} days`,
        );
      }
    } catch (err) {
      this.logger.error('AuditLog cleanup failed', err as Error);
    }
  }

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
    // system_domain lands verbatim in the Caddyfile — validate the hostname
    // shape here so a crafted value can't inject directives. Empty string
    // clears the domain (back to ip:3000-only).
    if (key === 'system_domain' && value) {
      const v = String(value).trim().toLowerCase();
      if (!/^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/.test(v)) {
        throw new BadRequestException('system_domain must be a valid hostname (e.g. panel.acme.com)');
      }
      value = v;
    }
    const result = await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: value as any, updatedBy: actorId },
      update: { value: value as any, updatedBy: actorId },
    });
    // The platform-domain Caddy block reads this setting at render time —
    // refresh immediately so the operator doesn't wait for the next regen.
    if (key === 'system_domain') {
      this.proxy.regenerate().catch(() => {});
    }
    return result;
  }

  async getPublicSettings() {
    const rows = await this.prisma.systemSetting.findMany({
      where: {
        key: { in: ['registration_enabled', 'platform_name', 'maintenance_mode', 'deployment_mode'] },
      },
    });
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;

    // public_ip — the IP/hostname the dashboard tells users to point their DNS
    // A records at. Derived from PUBLIC_API_URL set by install.sh (e.g.
    // http://203.0.113.10:4000 → "203.0.113.10"). Falls back to the host where
    // the API is reachable.
    try {
      const u = new URL(process.env.PUBLIC_API_URL || 'http://localhost:4000');
      out.public_ip = u.hostname;
    } catch {
      out.public_ip = 'localhost';
    }

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
