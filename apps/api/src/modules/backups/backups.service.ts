import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBackupDto } from './dto/create-backup.dto';

@Injectable()
export class BackupsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateBackupDto) {
    return this.prisma.backup.create({ data: dto as any });
  }

  async findAll(serverId?: string) {
    return this.prisma.backup.findMany({
      where: serverId ? { serverId } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const backup = await this.prisma.backup.findUnique({ where: { id } });
    if (!backup) throw new NotFoundException('Backup not found');
    return backup;
  }

  async restore(id: string) {
    await this.findOne(id);
    await this.prisma.backup.update({ where: { id }, data: { status: 'PENDING' } });
    return { message: 'Restore queued' };
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.backup.delete({ where: { id } });
    return { message: 'Backup deleted' };
  }
}
