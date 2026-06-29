import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as dns from 'dns';
import * as net from 'net';
import { promisify } from 'util';
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

    // The mailbox must live under the SAME project that owns the domain.
    // Without this, a caller with access to two projects could stamp a mailbox
    // on project A's domain under project B's id — mis-scoping RBAC and letting
    // project B's members read mail on a domain they don't own.
    const domainProjectId = domain.projectId || domain.application?.projectId;
    if (domainProjectId && domainProjectId !== dto.projectId) {
      throw new BadRequestException(
        "Mailbox projectId must match the domain's project.",
      );
    }

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
    // Kick any live IMAP/POP sessions for the deleted address — otherwise
    // a webmail tab that was already open keeps reading mail until idle
    // timeout (potentially hours). Best-effort.
    this.mailServer.kickMailboxSessions(mb.domainId, mb.address).catch(() => {});
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
      // include mx AND the A record of mail.<apex> — many resolvers cache MX
      // separately and SPF "mx" can lag while "a:mail.<apex>" stays consistent.
      spf: { host: apex, type: 'TXT', value: `v=spf1 mx a:mail.${apex} ~all` },
      dmarc: { host: `_dmarc.${apex}`, type: 'TXT', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${apex}; adkim=r; aspf=r; pct=100` },
      dkim: {
        host: `${server?.dkimSelector || 'dockcontrol'}._domainkey.${apex}`,
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
   * Live DNS health check — queries public DNS (Cloudflare 1.1.1.1) and compares
   * against expected records. Tells the operator EXACTLY what's wrong so they
   * can stop guessing in mail-tester.com.
   *
   * Checks (in order of how badly they hurt deliverability):
   *  - A     mail.<apex>          → must resolve to server IP
   *  - MX    <apex>               → must point to mail.<apex>, nothing else
   *  - PTR   serverIp             → must = mail.<apex> (rDNS / FCrDNS)
   *  - SPF   <apex> TXT           → present + matches expected
   *  - DKIM  dockcontrol._domainkey → present + matches stored public key
   *  - DMARC _dmarc.<apex>        → present + has p= policy
   */
  async getDnsHealth(userId: string, domainId: string) {
    const domain = await this.assertDomainAccess(userId, domainId, 'VIEWER');
    const apex = domain.domain;
    const server = await this.prisma.mailServer.findUnique({ where: { domainId } });

    const resolver = new dns.promises.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);

    const safe = async <T>(p: Promise<T>): Promise<T | null> => {
      try { return await p; } catch { return null; }
    };
    const flat = (recs: string[][] | null) =>
      recs ? recs.map((r) => r.join('')) : [];

    // 1. Server IP — what mail.<apex> resolves to AND what we should compare PTR against.
    const aRecords = await safe(resolver.resolve4(`mail.${apex}`));
    const apexARecords = await safe(resolver.resolve4(apex));
    const serverIp = aRecords?.[0] || null;

    // 2. MX
    const mxRecords = await safe(resolver.resolveMx(apex));
    const expectedMx = `mail.${apex}`;
    const mxStrings = (mxRecords || []).map((r) => r.exchange.replace(/\.$/, ''));
    const mxHasOurs = mxStrings.some((m) => m.toLowerCase() === expectedMx.toLowerCase());
    const mxForeign = mxStrings.filter((m) => m.toLowerCase() !== expectedMx.toLowerCase());

    // 3. PTR (rDNS) — only checkable if A record resolved
    let ptrHostnames: string[] = [];
    let ptrMatches = false;
    if (serverIp) {
      const ptr = await safe(resolver.reverse(serverIp));
      ptrHostnames = ptr || [];
      ptrMatches = ptrHostnames.some(
        (h) => h.replace(/\.$/, '').toLowerCase() === expectedMx.toLowerCase(),
      );
    }

    // 4. SPF
    const apexTxts = flat(await safe(resolver.resolveTxt(apex)));
    const spfRaw = apexTxts.find((t) => /^v=spf1\b/i.test(t)) || null;
    const spfHasMx = !!spfRaw && /\bmx\b/i.test(spfRaw);
    const spfHasA = !!spfRaw && new RegExp(`a:mail\\.${apex.replace(/\./g, '\\.')}`, 'i').test(spfRaw);
    const spfTooSoft = !!spfRaw && /\+all\b/i.test(spfRaw);
    const spfMultiple = apexTxts.filter((t) => /^v=spf1\b/i.test(t)).length > 1;

    // 5. DKIM
    const selector = server?.dkimSelector || 'dockcontrol';
    const dkimHost = `${selector}._domainkey.${apex}`;
    const dkimTxts = flat(await safe(resolver.resolveTxt(dkimHost)));
    const dkimRaw = dkimTxts.find((t) => /v=DKIM1/i.test(t)) || null;
    const dkimPubInDns = dkimRaw?.match(/p=([A-Za-z0-9+/=]+)/)?.[1] || null;
    const dkimMatches = !!dkimPubInDns && !!server?.dkimPublicKey
      && dkimPubInDns.replace(/\s+/g, '') === server.dkimPublicKey.replace(/\s+/g, '');

    // 6. DMARC
    const dmarcTxts = flat(await safe(resolver.resolveTxt(`_dmarc.${apex}`)));
    const dmarcRaw = dmarcTxts.find((t) => /^v=DMARC1\b/i.test(t)) || null;
    const dmarcPolicy = dmarcRaw?.match(/\bp=(none|quarantine|reject)\b/i)?.[1]?.toLowerCase() || null;

    // 7. Autodiscover (informational only — not a deliverability blocker)
    const autoCname = await safe(resolver.resolveCname(`autodiscover.${apex}`));
    const autoHas = !!autoCname && autoCname.some(
      (c) => c.replace(/\.$/, '').toLowerCase() === expectedMx.toLowerCase(),
    );

    // ── Verdicts: each check is one of OK / WARN / FAIL / UNKNOWN ────
    const checks = {
      a: serverIp
        ? { status: 'OK' as const, message: `mail.${apex} → ${serverIp}` }
        : { status: 'FAIL' as const, message: `mail.${apex} has no A record. Add: A mail ${apex.split('.').join('.')} → <server IP>` },

      mx: mxRecords && mxRecords.length === 0
        ? { status: 'FAIL' as const, message: `No MX record for ${apex}. Add: MX ${apex} 10 mail.${apex}` }
        : !mxHasOurs
        ? { status: 'FAIL' as const, message: `MX does not point to mail.${apex}. Found: ${mxStrings.join(', ') || '(none)'}` }
        : mxForeign.length > 0
        ? { status: 'WARN' as const, message: `Foreign MX records also present (mail will be split): ${mxForeign.join(', ')}. Remove them.` }
        : { status: 'OK' as const, message: `MX → mail.${apex}` },

      ptr: !serverIp
        ? { status: 'UNKNOWN' as const, message: `Cannot check PTR until mail.${apex} resolves.` }
        : ptrMatches
        ? { status: 'OK' as const, message: `PTR ${serverIp} → mail.${apex}` }
        : ptrHostnames.length > 0
        ? { status: 'FAIL' as const, message: `PTR for ${serverIp} is "${ptrHostnames[0]}", expected "mail.${apex}". Set rDNS at your VPS host (OVH/Hetzner/AWS).` }
        : { status: 'FAIL' as const, message: `No PTR record for ${serverIp}. Set rDNS to "mail.${apex}" at your VPS host.` },

      spf: !spfRaw
        ? { status: 'FAIL' as const, message: `No SPF record. Add TXT ${apex}: v=spf1 mx a:mail.${apex} ~all` }
        : spfMultiple
        ? { status: 'FAIL' as const, message: `Multiple SPF records on ${apex} — RFC says only one. Merge them.` }
        : spfTooSoft
        ? { status: 'WARN' as const, message: `SPF uses +all (allows anyone). Change to ~all or -all.` }
        : !spfHasMx && !spfHasA
        ? { status: 'WARN' as const, message: `SPF found but doesn't include mx or a:mail.${apex}. Current: ${spfRaw}` }
        : { status: 'OK' as const, message: spfRaw },

      dkim: !server?.dkimPublicKey
        ? { status: 'UNKNOWN' as const, message: `Deploy the mail server first to generate a DKIM key.` }
        : !dkimRaw
        ? { status: 'FAIL' as const, message: `No DKIM record at ${dkimHost}. Copy the DKIM value from the table below.` }
        : !dkimMatches
        ? { status: 'FAIL' as const, message: `DKIM key in DNS does not match the key on this server — DNS is stale or wrong. Re-paste the value below.` }
        : { status: 'OK' as const, message: `DKIM record matches server key.` },

      dmarc: !dmarcRaw
        ? { status: 'FAIL' as const, message: `No DMARC record. Add TXT _dmarc.${apex}: v=DMARC1; p=quarantine; rua=mailto:postmaster@${apex}` }
        : !dmarcPolicy
        ? { status: 'WARN' as const, message: `DMARC record found but no p= policy. Current: ${dmarcRaw}` }
        : dmarcPolicy === 'none'
        ? { status: 'WARN' as const, message: `DMARC policy is p=none (monitoring only). Move to p=quarantine when DKIM/SPF pass.` }
        : { status: 'OK' as const, message: `DMARC p=${dmarcPolicy}` },

      autodiscover: autoHas
        ? { status: 'OK' as const, message: `autodiscover.${apex} → mail.${apex}` }
        : { status: 'WARN' as const, message: `Autodiscover CNAME missing — clients won't auto-configure. Add CNAME autodiscover.${apex} → mail.${apex}` },

      apexA: apexARecords && apexARecords.length > 0
        ? { status: 'OK' as const, message: `${apex} A → ${apexARecords.join(', ')}` }
        : { status: 'WARN' as const, message: `${apex} has no A record (only matters if you also host a website on the apex).` },

      // Outbound :25 connectivity. Many VPS providers (AWS/GCP/Azure/Oracle,
      // Hetzner trial accounts, OVH cheapest plans, …) block egress on tcp/25
      // by default. Postfix will queue forever, no bounce, no DSN — the user
      // just sees "mail sent" with no delivery. We probe Gmail's public MX
      // on tcp/25 with a 4s timeout; if we can't connect, mail will silently
      // fail.
      outboundSmtp: await (async () => {
        const probe = (host: string, port: number, timeoutMs = 4000): Promise<boolean> =>
          new Promise<boolean>((resolve) => {
            const socket = new net.Socket();
            let done = false;
            const finish = (ok: boolean) => { if (done) return; done = true; try { socket.destroy(); } catch {} resolve(ok); };
            socket.setTimeout(timeoutMs);
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
            socket.once('timeout', () => finish(false));
            try { socket.connect(port, host); } catch { finish(false); }
          });
        // gmail-smtp-in is the canonical "public Internet :25 reachable" probe.
        const ok = await probe('gmail-smtp-in.l.google.com', 25);
        return ok
          ? { status: 'OK' as const, message: 'Outbound tcp/25 to public MX servers works.' }
          : { status: 'FAIL' as const, message: 'Outbound tcp/25 is blocked on this host. Mail will silently fail to deliver. Most cloud providers block port 25 by default — request unblocking (or use an SMTP relay like Postmark, Mailgun, AWS SES).' };
      })(),
    };

    const counts = {
      ok: Object.values(checks).filter((c) => c.status === 'OK').length,
      warn: Object.values(checks).filter((c) => c.status === 'WARN').length,
      fail: Object.values(checks).filter((c) => c.status === 'FAIL').length,
      unknown: Object.values(checks).filter((c) => c.status === 'UNKNOWN').length,
    };
    // Overall verdict: any FAIL → bad; only WARN/UNKNOWN → partial; all OK → ready
    const overall =
      counts.fail > 0 ? 'FAIL' :
      counts.warn > 0 || counts.unknown > 0 ? 'PARTIAL' : 'OK';

    return {
      domain: apex,
      serverIp,
      ptrHostnames,
      mxRecords: mxStrings,
      checks,
      counts,
      overall,
      checkedAt: new Date().toISOString(),
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
    const allDomains = await this.prisma.domain.findMany({
      where: { projectId: { in: projectIds } },
      include: {
        project: { select: { id: true, name: true } },
        application: { select: { id: true, name: true, port: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Mail servers live on apex domains only — user@apex is what people
    // actually want, not user@sub.apex. Subdomains can still serve web
    // traffic / SSL; they just don't get their own mail server card here.
    // We DO carry them along as "siblings" of their apex so the UI can
    // show "this apex covers 3 subdomains" without polluting the list.
    const isApex = (d: { domain: string }) => d.domain.split('.').filter(Boolean).length <= 2;
    const apexOf = (host: string) => host.split('.').filter(Boolean).slice(-2).join('.');
    const domains = allDomains.filter(isApex);
    const subsByApex = new Map<string, { id: string; domain: string }[]>();
    for (const d of allDomains) {
      if (isApex(d)) continue;
      const apex = apexOf(d.domain);
      const arr = subsByApex.get(apex) || [];
      arr.push({ id: d.id, domain: d.domain });
      subsByApex.set(apex, arr);
    }
    if (domains.length === 0) return [];
    const domainIds = domains.map((d) => d.id);
    const [servers, mailboxAgg, aliasAgg, webmails] = await Promise.all([
      this.prisma.mailServer.findMany({
        where: { domainId: { in: domainIds } },
        select: {
          domainId: true, status: true, hostname: true, lastError: true,
          smtpPort: true, submissionPort: true, smtpsPort: true, imapPort: true, imapsPort: true,
          serverId: true,
          server: { select: { id: true, name: true, host: true } },
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
    // Host the platform primary runs on, for displaying SMTP/IMAP + IP:port
    // coordinates of a mail server that lives on the PRIMARY host (serverId
    // null). Derived from PUBLIC_API_URL; null when it's a local/dev hostname.
    const primaryHost = this.resolvePrimaryHost();

    return domains.map((d) => {
      const ms = srvBy.get(d.id) || null;
      // Only one mail server on a host can bind tcp/25, which is the only
      // port public-Internet senders ever connect to. Servers offset to
      // 2525+ can SEND but cannot RECEIVE inbound mail from Gmail/Yahoo.
      // Surface that distinction so the dashboard can warn clearly.
      const inboundCapable = ms ? ms.smtpPort === 25 : null;
      // The reachable address of the host this mail server runs on: the remote
      // server's host when remote, else the platform primary host. Lets the
      // dashboard show a REAL IP:port instead of window.location.hostname.
      const serverHost = ms ? (ms.server?.host ?? primaryHost) : null;
      return {
        id: d.id,
        domain: d.domain,
        project: d.project,
        application: d.application,
        mailServer: ms ? { ...ms, inboundCapable, serverHost } : null,
        mailboxCount: mbBy.get(d.id) || 0,
        aliasCount: alBy.get(d.id) || 0,
        webmail: wmBy.get(d.id) || null,
        subdomains: subsByApex.get(d.domain) || [],
      };
    });
  }

  /** Public host of the platform primary, derived from PUBLIC_API_URL. */
  private resolvePrimaryHost(): string | null {
    try {
      const raw = process.env.PUBLIC_API_URL;
      if (!raw) return null;
      const host = new URL(raw).hostname;
      if (!host || host === 'localhost' || /^127\.|^0\.0\.0\.0$/.test(host)) return null;
      return host;
    } catch {
      return null;
    }
  }
}
