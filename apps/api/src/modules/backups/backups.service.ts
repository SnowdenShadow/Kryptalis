import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBackupDto } from './dto/create-backup.dto';

/**
 * Backups module — current state.
 *
 * The actual backup engine (pg_dump/mysqldump/mongodump, volume snapshotting,
 * S3/R2/B2 upload, scheduler, restore) is not yet implemented. Until it ships,
 * this service:
 *   1. Refuses to create entries with non-LOCAL targets so users can't expect
 *      remote storage that doesn't exist.
 *   2. Refuses restore until status === COMPLETED (which today never happens),
 *      so accidentally clicking restore on a stale row can't silently corrupt
 *      live data later.
 *   3. Scopes every list/read/mutation to the caller's accessible projects,
 *      via the server.projects[].userId graph. Platform admins see everything.
 *      Previously every authenticated user could enumerate / restore / delete
 *      every backup on the platform.
 *
 * When the engine is ready, swap the create body and call into a job runner;
 * the RBAC checks below stay valid.
 */
@Injectable()
export class BackupsService {
  constructor(private prisma: PrismaService) {}

  // ── access helpers ─────────────────────────────────────────────────

  private async isAdmin(userId: string): Promise<boolean> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';
  }

  private async accessibleServerIds(userId: string): Promise<string[]> {
    if (await this.isAdmin(userId)) {
      const all = await this.prisma.server.findMany({ select: { id: true } });
      return all.map((s) => s.id);
    }
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { project: { select: { serverId: true } } },
    });
    return Array.from(new Set(memberships.map((m) => m.project.serverId).filter(Boolean))) as string[];
  }

  private async assertBackupAccess(userId: string, backupId: string) {
    const backup = await this.prisma.backup.findUnique({ where: { id: backupId } });
    if (!backup) throw new NotFoundException('Backup not found');
    const allowed = await this.accessibleServerIds(userId);
    if (!allowed.includes(backup.serverId)) {
      throw new ForbiddenException('You do not have access to this backup.');
    }
    return backup;
  }

  // ── operations ─────────────────────────────────────────────────────

  async create(userId: string, dto: CreateBackupDto) {
    const allowed = await this.accessibleServerIds(userId);
    if (!allowed.includes(dto.serverId)) {
      throw new ForbiddenException('You do not have access to this server.');
    }
    if (dto.target && dto.target !== 'LOCAL') {
      throw new BadRequestException(
        `Remote backup targets (${dto.target}) are not yet supported. Use LOCAL.`,
      );
    }
    return this.prisma.backup.create({
      data: {
        name: dto.name,
        serverId: dto.serverId,
        target: 'LOCAL',
        includeApplications: dto.includeApplications ?? true,
        includeDatabases: dto.includeDatabases ?? true,
        includeVolumes: dto.includeVolumes ?? true,
        schedule: dto.schedule ?? null,
      },
    });
  }

  async findAll(userId: string, serverId?: string) {
    const allowed = await this.accessibleServerIds(userId);
    const where: any = { serverId: { in: allowed } };
    if (serverId) {
      if (!allowed.includes(serverId)) {
        throw new ForbiddenException('You do not have access to this server.');
      }
      where.serverId = serverId;
    }
    return this.prisma.backup.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async findOne(userId: string, id: string) {
    return this.assertBackupAccess(userId, id);
  }

  async restore(userId: string, id: string) {
    const backup = await this.assertBackupAccess(userId, id);
    if (backup.status !== 'COMPLETED') {
      throw new BadRequestException(
        `Only COMPLETED backups can be restored. This backup is ${backup.status}.`,
      );
    }
    // Engine not implemented yet — leave the row alone so we don't clobber the
    // status. When the engine ships, replace this with a real enqueue.
    return {
      message: 'Restore queued — engine implementation pending.',
      backupId: id,
    };
  }

  async remove(userId: string, id: string) {
    await this.assertBackupAccess(userId, id);
    await this.prisma.backup.delete({ where: { id } });
    return { message: 'Backup deleted' };
  }
}
