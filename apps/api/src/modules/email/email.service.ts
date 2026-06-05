import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMailboxDto } from './dto/create-mailbox.dto';
import { UpdateMailboxDto } from './dto/update-mailbox.dto';
import { CreateAliasDto } from './dto/create-alias.dto';
import { MailServerService } from './mail-server.service';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';

@Injectable()
export class EmailService {
  constructor(
    private prisma: PrismaService,
    private mailServer: MailServerService,
  ) {}

  // ── access ────────────────────────────────────────────────────────

  private async assertDomainAccess(
    userId: string,
    domainId: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'VIEWER',
  ) {
    const domain = await this.prisma.domain.findUnique({
      where: { id: domainId },
      include: { application: { select: { projectId: true } } },
    });
    if (!domain) throw new NotFoundException('Domain not found');
    // prefer direct projectId, fall back to app.projectId (legacy)
    const projectId = domain.projectId || domain.application?.projectId;
    if (!projectId) {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (me?.role !== 'ADMIN' && me?.role !== 'SUPERADMIN') {
        throw new ForbiddenException('Domain has no project');
      }
      return domain;
    }
    await assertProjectAccess(this.prisma, userId, projectId, minRole);
    return domain;
  }

  private async assertMailboxAccess(
    userId: string,
    id: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'VIEWER',
  ) {
    const mb = await this.prisma.mailbox.findUnique({ where: { id } });
    if (!mb) throw new NotFoundException('Mailbox not found');
    if (!mb.projectId) {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (me?.role !== 'ADMIN' && me?.role !== 'SUPERADMIN') {
        throw new ForbiddenException('Mailbox has no project');
      }
      return mb;
    }
    await assertProjectAccess(this.prisma, userId, mb.projectId, minRole);
    return mb;
  }

  // ── mailboxes ─────────────────────────────────────────────────────

  async createMailbox(userId: string, dto: CreateMailboxDto) {
    await assertProjectAccess(this.prisma, userId, dto.projectId, 'DEVELOPER');
    const domain = await this.assertDomainAccess(userId, dto.domainId, 'DEVELOPER');

    if (dto.password.length < 8) {
      throw new BadRequestException('Password too short (min 8)');
    }
    const address = `${dto.localPart.toLowerCase()}@${domain.domain}`;
    const existing = await this.prisma.mailbox.findUnique({ where: { address } });
    if (existing) throw new ConflictException(`Mailbox ${address} already exists`);

    if (dto.catchAll) {
      const otherCatchAll = await this.prisma.mailbox.findFirst({
        where: { domainId: dto.domainId, catchAll: true },
      });
      if (otherCatchAll) {
        throw new ConflictException(`Domain already has a catch-all mailbox: ${otherCatchAll.address}`);
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const mb = await this.prisma.mailbox.create({
      data: {
        address,
        localPart: dto.localPart.toLowerCase(),
        domainId: dto.domainId,
        projectId: dto.projectId,
        passwordHash,
        quotaMb: dto.quotaMb ?? 2048,
        forwardTo: dto.forwardTo,
        catchAll: dto.catchAll ?? false,
      },
      include: {
        domain: { select: { id: true, domain: true } },
        project: { select: { id: true, name: true } },
      },
    });
    this.mailServer.syncAccounts(dto.domainId).catch(() => {});
    return mb;
  }

  async listMailboxes(userId: string, opts: { projectId?: string; domainId?: string }) {
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    const where: any = {};
    if (opts.projectId) {
      await assertProjectAccess(this.prisma, userId, opts.projectId, 'VIEWER');
      where.projectId = opts.projectId;
    } else {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      const isPlatformAdmin = me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';
      if (!isPlatformAdmin) {
        where.projectId = { in: projectIds };
      }
    }
    if (opts.domainId) where.domainId = opts.domainId;

    return this.prisma.mailbox.findMany({
      where,
      include: {
        domain: { select: { id: true, domain: true } },
        project: { select: { id: true, name: true } },
        _count: { select: { aliases: true } },
      },
      orderBy: { address: 'asc' },
    });
  }

  async getMailbox(userId: string, id: string) {
    await this.assertMailboxAccess(userId, id, 'VIEWER');
    return this.prisma.mailbox.findUnique({
      where: { id },
      include: {
        domain: { select: { id: true, domain: true } },
        project: { select: { id: true, name: true } },
        aliases: true,
      },
    });
  }

  async updateMailbox(userId: string, id: string, dto: UpdateMailboxDto) {
    const mb = await this.assertMailboxAccess(userId, id, 'DEVELOPER');
    const data: any = {};
    if (dto.password !== undefined) {
      if (dto.password.length < 8) throw new BadRequestException('Password too short');
      data.passwordHash = await bcrypt.hash(dto.password, 12);
    }
    if (dto.quotaMb !== undefined) data.quotaMb = dto.quotaMb;
    if (dto.forwardTo !== undefined) data.forwardTo = dto.forwardTo;
    if (dto.catchAll !== undefined) {
      if (dto.catchAll && !mb.catchAll) {
        const other = await this.prisma.mailbox.findFirst({
          where: { domainId: mb.domainId, catchAll: true, NOT: { id } },
        });
        if (other) throw new ConflictException('Another catch-all already exists');
      }
      data.catchAll = dto.catchAll;
    }
    if (dto.status !== undefined) data.status = dto.status;
    const updated = await this.prisma.mailbox.update({
      where: { id },
      data,
      include: {
        domain: { select: { id: true, domain: true } },
        project: { select: { id: true, name: true } },
      },
    });
    this.mailServer.syncAccounts(updated.domainId).catch(() => {});
    return updated;
  }

  async removeMailbox(userId: string, id: string) {
    const mb = await this.assertMailboxAccess(userId, id, 'ADMIN');
    await this.prisma.mailbox.delete({ where: { id } });
    this.mailServer.syncAccounts(mb.domainId).catch(() => {});
    return { message: 'Mailbox deleted' };
  }

  // ── aliases ───────────────────────────────────────────────────────

  async createAlias(userId: string, dto: CreateAliasDto) {
    const domain = await this.assertDomainAccess(userId, dto.domainId, 'DEVELOPER');
    if (!dto.targetMailboxId && !dto.forwardTo) {
      throw new BadRequestException('targetMailboxId or forwardTo required');
    }
    if (dto.targetMailboxId) {
      const target = await this.prisma.mailbox.findFirst({
        where: { id: dto.targetMailboxId, domainId: dto.domainId },
      });
      if (!target) throw new BadRequestException('targetMailboxId must belong to the same domain');
    }
    const address = `${dto.localPart.toLowerCase()}@${domain.domain}`;
    const existing = await this.prisma.emailAlias.findUnique({ where: { address } });
    if (existing) throw new ConflictException(`Alias ${address} already exists`);
    const alias = await this.prisma.emailAlias.create({
      data: {
        address,
        domainId: dto.domainId,
        targetMailboxId: dto.targetMailboxId,
        forwardTo: dto.forwardTo,
      },
    });
    this.mailServer.syncAccounts(dto.domainId).catch(() => {});
    return alias;
  }

  async listAliases(userId: string, domainId: string) {
    await this.assertDomainAccess(userId, domainId, 'VIEWER');
    return this.prisma.emailAlias.findMany({
      where: { domainId },
      include: { mailbox: { select: { id: true, address: true } } },
      orderBy: { address: 'asc' },
    });
  }

  async removeAlias(userId: string, id: string) {
    const alias = await this.prisma.emailAlias.findUnique({ where: { id } });
    if (!alias) throw new NotFoundException('Alias not found');
    await this.assertDomainAccess(userId, alias.domainId, 'ADMIN');
    await this.prisma.emailAlias.delete({ where: { id } });
    this.mailServer.syncAccounts(alias.domainId).catch(() => {});
    return { message: 'Alias deleted' };
  }

  // ── DNS records helper (SPF/DKIM/DMARC config display) ────────────

  async getDnsHints(userId: string, domainId: string) {
    const domain = await this.assertDomainAccess(userId, domainId, 'VIEWER');
    const apex = domain.domain;
    const server = await this.prisma.mailServer.findUnique({ where: { domainId } });
    // mailbox count drives the UI warning shown when the mail server is
    // RUNNING but dovecot can't actually accept logins (docker-mailserver
    // refuses to start dovecot when no account exists in postfix-accounts.cf).
    const mailboxCount = await this.prisma.mailbox.count({
      where: { domainId, status: 'ACTIVE', forwardTo: null },
    });
    const dkimValue = server?.dkimPublicKey
      ? `v=DKIM1; k=rsa; p=${server.dkimPublicKey}`
      : 'v=DKIM1; k=rsa; p=<deploy the mail server first>';
    return {
      mx: [{ host: apex, value: `mail.${apex}`, priority: 10 }],
      spf: { host: apex, type: 'TXT', value: `v=spf1 mx ~all` },
      dmarc: { host: `_dmarc.${apex}`, type: 'TXT', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${apex}` },
      dkim: {
        host: `${server?.dkimSelector || 'kryptalis'}._domainkey.${apex}`,
        type: 'TXT',
        value: dkimValue,
        ready: !!server?.dkimPublicKey,
      },
      autodiscover: { host: `autodiscover.${apex}`, type: 'CNAME', value: `mail.${apex}` },
      mailServer: server
        ? {
            status: server.status,
            ports: {
              smtp: server.smtpPort,
              submission: server.submissionPort,
              smtps: server.smtpsPort,
              imap: server.imapPort,
              imaps: server.imapsPort,
            },
            hostname: server.hostname,
            lastError: server.lastError,
            mailboxCount,
          }
        : null,
    };
  }

  /**
   * One-shot list for the email overview page: every mail-eligible domain
   * the user can see, joined with mail server status + mailbox/alias counts.
   * Powers /dashboard/emails (no per-domain round-trips).
   */
  async overview(userId: string) {
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    if (projectIds.length === 0) return [];
    const domains = await this.prisma.domain.findMany({
      where: { projectId: { in: projectIds } },
      include: {
        project: { select: { id: true, name: true } },
        application: { select: { id: true, name: true, port: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (domains.length === 0) return [];
    const domainIds = domains.map((d) => d.id);
    const [servers, mailboxAgg, aliasAgg, webmails] = await Promise.all([
      this.prisma.mailServer.findMany({
        where: { domainId: { in: domainIds } },
        select: {
          domainId: true, status: true, hostname: true, lastError: true,
          smtpPort: true, submissionPort: true, smtpsPort: true, imapPort: true, imapsPort: true,
        },
      }),
      this.prisma.mailbox.groupBy({
        by: ['domainId'],
        where: { domainId: { in: domainIds }, status: 'ACTIVE', forwardTo: null },
        _count: { _all: true },
      }),
      this.prisma.emailAlias.groupBy({
        by: ['domainId'],
        where: { domainId: { in: domainIds } },
        _count: { _all: true },
      }),
      // webmail apps already linked to one of these domains — used to surface
      // an "Open webmail" deep-link in the overview card.
      this.prisma.application.findMany({
        where: {
          name: { in: ['Roundcube', 'SnappyMail', 'Rainloop'] },
          domains: { some: { id: { in: domainIds } } },
        },
        select: { id: true, name: true, port: true, status: true, domains: { select: { id: true } } },
      }),
    ]);
    const srvBy = new Map(servers.map((s) => [s.domainId, s]));
    const mbBy = new Map(mailboxAgg.map((g) => [g.domainId, g._count._all]));
    const alBy = new Map(aliasAgg.map((g) => [g.domainId, g._count._all]));
    const wmBy = new Map<string, { id: string; name: string; port: number | null; status: string }>();
    for (const w of webmails) {
      for (const d of w.domains) wmBy.set(d.id, { id: w.id, name: w.name, port: w.port, status: w.status });
    }
    return domains.map((d) => ({
      id: d.id,
      domain: d.domain,
      project: d.project,
      application: d.application,
      mailServer: srvBy.get(d.id) || null,
      mailboxCount: mbBy.get(d.id) || 0,
      aliasCount: alBy.get(d.id) || 0,
      webmail: wmBy.get(d.id) || null,
    }));
  }
}
