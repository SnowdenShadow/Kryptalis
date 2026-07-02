import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import * as dns from 'dns';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { assertPermission } from '../../common/rbac/project-permissions';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { MailServerService } from '../email/mail-server.service';
import { DomainAttachService } from './domain-attach.service';
import { SystemConfigService } from '../system/system-config.service';
import {
  newVerificationToken,
  verificationRecord,
  checkDomainVerification,
} from './domain-verification';

@Injectable()
export class DomainsService {
  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    @Inject(forwardRef(() => MailServerService))
    private mailServer: MailServerService,
    private domainAttach: DomainAttachService,
    private systemConfig: SystemConfigService,
  ) {}

  /** Whether domain-ownership proof is enforced (H-3). Default OFF so existing
   *  single-operator installs are unaffected; multi-tenant operators turn it on
   *  via Admin → Settings (require_domain_verification). */
  private verificationRequired(): boolean {
    return this.systemConfig.getBool('require_domain_verification');
  }

  async create(userId: string, dto: CreateDomainDto) {
    // The PLATFORM domain (system_domain) serves the dashboard itself —
    // creating it as an app domain would put two site blocks for one host
    // in the Caddyfile (the renderer skips the app one, so the attach
    // would silently never route). Refuse with a pointer instead.
    const systemDomain = await this.prisma.systemSetting
      .findUnique({ where: { key: 'system_domain' } })
      .then((r) => (typeof r?.value === 'string' ? r.value : null))
      .catch(() => null);
    if (systemDomain && dto.domain === systemDomain) {
      throw new ConflictException(
        `"${dto.domain}" is the platform domain (it serves this dashboard). Use a subdomain like app.${dto.domain} for apps, or change the platform domain in Admin → Settings first.`,
      );
    }

    const existing = await this.prisma.domain.findUnique({
      where: { domain: dto.domain },
    });
    // Orphaned row (its project was deleted → FK SetNull): invisible in
    // every project-scoped list but still holding the @unique(domain)
    // slot — without this reclaim, re-adding the hostname fails with
    // "already exists" against a row nobody can see or delete. Reclaim =
    // drop the ghost and fall through to a fresh create.
    if (existing && !existing.projectId) {
      await this.prisma.domain.delete({ where: { id: existing.id } });
    } else if (existing) {
      throw new ConflictException('Domain already exists');
    }
    // `port` is routed through DomainAttachService below — it must NOT land
    // in the prisma.domain.create payload (no such column on Domain).
    const { autoSsl, port, ...data } = dto;

    // resolve project: prefer explicit projectId, fall back to app's project
    let projectId = (dto as any).projectId as string | undefined;
    let applicationId = data.applicationId as string | undefined;

    if (applicationId) {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { projectId: true },
      });
      if (!app) throw new NotFoundException('Application not found');
      projectId = projectId || app.projectId;
      if (projectId !== app.projectId) {
        throw new BadRequestException("Application doesn't belong to the given project");
      }
    }

    if (!projectId) {
      throw new BadRequestException(
        'projectId is required — a domain must always belong to a project, even without an app',
      );
    }
    if (port && !applicationId) {
      throw new BadRequestException('port requires applicationId — a port binding always targets an app');
    }
    await assertProjectAccess(this.prisma, userId, projectId, 'DEVELOPER');
    await assertPermission(this.prisma, userId, projectId, 'domains:manage');

    // Port-pinned create: the app is reachable at http://<domain>:<port>
    // (DomainPortBinding) instead of taking the clean-URL :443 slot.
    const usePortBinding = !!port && !!applicationId;
    // H-3: mint a verification token. When verification is NOT required, stamp
    // verifiedAt now so behavior is identical to before. When required, leave
    // it null — the domain is created but won't be rendered into Caddy or host
    // mail until verifyDomain() confirms the TXT record.
    const requireVerification = this.verificationRequired();
    const created = await this.prisma.domain.create({
      data: {
        ...data,
        projectId,
        applicationId: usePortBinding ? null : applicationId || null,
        verificationToken: newVerificationToken(),
        verifiedAt: requireVerification ? null : new Date(),
      },
    });
    if (usePortBinding) {
      await this.domainAttach.attach({
        applicationId: applicationId!,
        domainId: created.id,
        projectId,
        customPort: true,
        port: port!,
      });
    }
    // Only (re)render Caddy when the domain is usable. An unverified domain
    // (verification required, not yet proven) must not reach the Caddyfile.
    if (created.verifiedAt) {
      this.proxy.regenerate().catch(() => {});
    }
    return created;
  }

  /**
   * Return the DNS TXT record the owner must publish to verify this domain
   * (H-3). Available to any project member who can see the domain.
   */
  async getVerificationInstructions(userId: string, id: string) {
    const domain = await this.assertDomainAccess(userId, id, 'VIEWER');
    let token = domain.verificationToken;
    if (!token) {
      // Back-filled/legacy rows may have no token — mint one on demand.
      token = newVerificationToken();
      await this.prisma.domain.update({ where: { id }, data: { verificationToken: token } });
    }
    const record = verificationRecord(domain.domain, token);
    return {
      verified: !!domain.verifiedAt,
      required: this.verificationRequired(),
      record: { type: 'TXT', name: record.name, value: record.value },
    };
  }

  /**
   * Check the published TXT record and, on success, stamp verifiedAt + render
   * Caddy so the domain starts routing (H-3). Idempotent — re-verifying an
   * already-verified domain is a no-op success.
   */
  async verifyDomain(userId: string, id: string) {
    const domain = await this.assertDomainAccess(userId, id, 'DEVELOPER');
    if (domain.verifiedAt) {
      return { verified: true, alreadyVerified: true };
    }
    if (!domain.verificationToken) {
      throw new BadRequestException(
        'No verification token for this domain — fetch the TXT record first.',
      );
    }
    const ok = await checkDomainVerification(domain.domain, domain.verificationToken);
    if (!ok) {
      const record = verificationRecord(domain.domain, domain.verificationToken);
      throw new BadRequestException(
        `TXT record not found yet. Publish: ${record.name} TXT "${record.value}" (DNS can take a few minutes to propagate).`,
      );
    }
    await this.prisma.domain.update({ where: { id }, data: { verifiedAt: new Date() } });
    // Now that it's proven, render it into Caddy (and let cert issuance run).
    this.proxy.regenerate().catch(() => {});
    return { verified: true };
  }

  async findAll(userId: string) {
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    if (projectIds.length === 0) return [];
    const domains = await this.prisma.domain.findMany({
      where: { projectId: { in: projectIds } },
      include: {
        project: { select: { id: true, name: true } },
        application: {
          select: {
            id: true,
            name: true,
            project: { select: { id: true, name: true } },
          },
        },
        // Port-pinned apps (http://<domain>:<port>) — the dashboard shows
        // them in the App cell so a port-bound domain doesn't look orphaned.
        portBindings: {
          select: {
            id: true,
            port: true,
            application: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    // attach mailServer flag — marketplace UI uses it to filter the domain
    // dropdown when installing webmail (Roundcube/SnappyMail/Rainloop) so
    // users can only pick a domain that has a running mail server.
    const mailServers = await this.prisma.mailServer.findMany({
      where: { domainId: { in: domains.map((d) => d.id) } },
      select: { domainId: true, status: true, hostname: true },
    });
    const msByDomain = new Map(mailServers.map((m) => [m.domainId, m]));
    return domains.map((d) => ({
      ...d,
      mailServer: msByDomain.get(d.id) || null,
    }));
  }

  private async assertDomainAccess(
    userId: string,
    id: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'VIEWER',
    permission?: string,
  ) {
    const domain = await this.prisma.domain.findUnique({
      where: { id },
      include: { application: { select: { projectId: true } } },
    });
    if (!domain) throw new NotFoundException('Domain not found');
    const projectId = domain.projectId || domain.application?.projectId;
    if (!projectId) {
      // legacy/orphan: admin-only
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
    if (permission) await assertPermission(this.prisma, userId, projectId, permission);
    return domain;
  }

  async findOne(userId: string, id: string) {
    await this.assertDomainAccess(userId, id, 'VIEWER');
    const domain = await this.prisma.domain.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        application: true,
        dnsRecords: true,
        certificate: true,
      },
    });
    if (!domain) throw new NotFoundException('Domain not found');
    return domain;
  }

  async update(
    userId: string,
    id: string,
    data: { applicationId?: string | null },
  ) {
    await this.assertDomainAccess(userId, id, 'DEVELOPER', 'domains:manage');

    if (data.applicationId !== undefined) {
      if (data.applicationId === null) {
        // Detaching everything: drop the clean-URL slot AND every port
        // binding the previous app had on this domain. Goes through the
        // central service so port bindings actually get cleaned up.
        const cur = await this.prisma.domain.findUnique({
          where: { id },
          select: { applicationId: true },
        });
        if (cur?.applicationId) {
          await this.domainAttach.detachAll(cur.applicationId, id);
        } else {
          await this.prisma.domain.update({ where: { id }, data: { applicationId: null } });
        }
      } else {
        // Attaching: route through DomainAttachService so multi-app rules
        // apply uniformly (same conflict policy as marketplace + git deploy).
        const app = await this.prisma.application.findUnique({
          where: { id: data.applicationId },
          select: { projectId: true, port: true, customPort: true },
        });
        if (!app) throw new NotFoundException('Target application not found');
        await assertProjectAccess(this.prisma, userId, app.projectId, 'DEVELOPER');
        await this.domainAttach.attach({
          applicationId: data.applicationId,
          domainId: id,
          projectId: app.projectId,
          customPort: !!app.customPort,
          port: app.port ?? 80,
        });
        // also re-home the domain under the app's project for visibility
        await this.prisma.domain.update({
          where: { id },
          data: { projectId: app.projectId },
        });
      }
    }

    // NOTE: re-homing a domain to a different project (and orphaning it via
    // projectId:null) is intentionally NOT handled here. It is privileged and
    // only available through the ADMIN-gated transfer() endpoint. The PATCH
    // body DTO (UpdateDomainDto) strips any projectId field, so a DEVELOPER
    // cannot orphan a domain by patching projectId:null.

    this.proxy.regenerate().catch(() => {});
    return this.prisma.domain.findUnique({ where: { id } });
  }

  async remove(userId: string, id: string) {
    await this.assertDomainAccess(userId, id, 'DEVELOPER', 'domains:delete');
    // Tear down mail stack BEFORE deleting the domain row so the mailbox/alias
    // FKs still resolve and the container can be cleanly stopped + removed
    // (frees ports, removes compose dir, drops mail_servers row).
    try { await this.mailServer.removeForDomain(id); } catch {}
    await this.prisma.domain.delete({ where: { id } });
    this.proxy.regenerate().catch(() => {});
    return { message: 'Domain deleted' };
  }

  /**
   * Transfer a domain to a different project. Requires:
   *   - ADMIN on the source project
   *   - DEVELOPER on the target project
   * If the domain was linked to an app, the link is broken (the new project
   * likely doesn't have the same apps).
   */
  async transfer(userId: string, id: string, targetProjectId: string) {
    await this.assertDomainAccess(userId, id, 'ADMIN');
    await assertProjectAccess(this.prisma, userId, targetProjectId, 'DEVELOPER');
    // Re-home the domain AND its domain-scoped resources in one transaction.
    // Mailboxes carry their own projectId (RBAC is checked against it), so
    // leaving them on the old project would let the source project's members
    // keep reading mail on a domain they no longer own. Move every mailbox on
    // this domain to the target project atomically with the domain itself.
    const [updated] = await this.prisma.$transaction([
      this.prisma.domain.update({
        where: { id },
        data: { projectId: targetProjectId, applicationId: null },
        include: {
          project: { select: { id: true, name: true } },
        },
      }),
      this.prisma.mailbox.updateMany({
        where: { domainId: id },
        data: { projectId: targetProjectId },
      }),
    ]);
    this.proxy.regenerate().catch(() => {});
    return updated;
  }

  /**
   * Live DNS health check for any domain (web or mail). Queries public DNS
   * resolvers and compares against the expected record set:
   *
   *   - A (or AAAA): must point to the server's public IP. Subdomains may
   *     use a CNAME to the apex — we follow it.
   *   - CNAME (subdomains only): allowed alternative to A. Must ultimately
   *     resolve to the server.
   *   - MX (if domain has a mail server): see EmailService.getDnsHealth
   *     for the deep check — we just say "use the mail tab" here.
   *
   * Returns per-record verdicts so the UI can show each line as OK / WARN
   * / FAIL with the exact value seen, AND a `recommendedRecords` array the
   * dashboard can copy-paste into the user's registrar.
   */
  async getDnsHealth(userId: string, id: string) {
    const domain = await this.assertDomainAccess(userId, id, 'VIEWER');
    const host = domain.domain;
    const isSubdomain = host.split('.').length > 2;
    const apex = isSubdomain ? host.split('.').slice(-2).join('.') : host;

    const resolver = new dns.promises.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    const safe = async <T>(p: Promise<T>): Promise<T | null> => {
      try { return await p; } catch { return null; }
    };

    let expectedIp = '';
    try {
      const url = process.env.PUBLIC_API_URL || '';
      const m = url.match(/^https?:\/\/([^:/]+)/);
      if (m && /^\d+\.\d+\.\d+\.\d+$/.test(m[1])) expectedIp = m[1];
    } catch {}

    const ips = await safe(resolver.resolve4(host));
    const cname = await safe(resolver.resolveCname(host));
    const actualIp = ips?.[0] || null;
    const matchIp = expectedIp && actualIp === expectedIp;

    const mailServer = await this.prisma.mailServer.findUnique({ where: { domainId: id } });
    const hasMail = !!mailServer;

    // MX check — only when mail server exists.
    let mxCheck: { status: 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN'; message: string } | null = null;
    if (hasMail) {
      const mxRecords = await safe(resolver.resolveMx(host));
      const expectedMx = `mail.${apex}`;
      const mxStrings = (mxRecords || []).map((r) => r.exchange.replace(/\.$/, '').toLowerCase());
      const hasOurs = mxStrings.includes(expectedMx.toLowerCase());
      const foreign = mxStrings.filter((m) => m !== expectedMx.toLowerCase());
      mxCheck = !mxRecords || mxRecords.length === 0
        ? { status: 'FAIL', message: `No MX record. Add: MX ${host} 10 mail.${apex}` }
        : !hasOurs
        ? { status: 'FAIL', message: `MX does not include mail.${apex}. Found: ${mxStrings.join(', ')}` }
        : foreign.length > 0
        ? { status: 'WARN', message: `Foreign MX present (mail will be split): ${foreign.join(', ')}.` }
        : { status: 'OK', message: `MX → mail.${apex}` };
    }

    const checks: Record<string, { status: 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN'; message: string }> = {
      a: !actualIp
        ? { status: 'FAIL', message: `No A record for ${host}. Add: A ${host} → ${expectedIp || '<server IP>'}` }
        : !expectedIp
        ? { status: 'WARN', message: `Resolves to ${actualIp}, but server's expected IP isn't configured.` }
        : matchIp
        ? { status: 'OK', message: `A → ${actualIp}` }
        : { status: 'FAIL', message: `Points to ${actualIp}, expected ${expectedIp}. Fix at your DNS provider.` },

      cname: cname && cname.length > 0
        ? { status: 'OK', message: `CNAME → ${cname[0]}` }
        : isSubdomain
        ? { status: 'WARN', message: `Subdomain uses A directly. CNAME → ${apex} would simplify maintenance.` }
        : { status: 'OK', message: `Apex uses A (CNAMEs forbidden on apex by RFC).` },
    };
    if (mxCheck) checks.mx = mxCheck;

    // Recommended record set the user should add at their registrar — gives
    // them the exact "host / type / value" trio to paste.
    const recommendedRecords: { type: 'A' | 'CNAME' | 'MX' | 'TXT'; host: string; value: string; priority?: number; note?: string }[] = [];
    if (isSubdomain) {
      recommendedRecords.push({
        type: 'CNAME',
        host,
        value: apex,
        note: 'Subdomain → apex. Cleaner than A: if you ever move servers, only the apex needs updating.',
      });
    } else {
      recommendedRecords.push({
        type: 'A',
        host,
        value: expectedIp || 'YOUR-SERVER-IP',
        note: 'Apex domain → server IP. CNAME is not allowed on apex by DNS spec.',
      });
    }
    if (hasMail) {
      recommendedRecords.push({
        type: 'MX',
        host,
        value: `mail.${apex}`,
        priority: 10,
        note: 'Routes incoming email to the mail server container.',
      });
      // mail.<apex> A record (needed because MX targets it)
      recommendedRecords.push({
        type: 'A',
        host: `mail.${apex}`,
        value: expectedIp || 'YOUR-SERVER-IP',
        note: 'A record that MX target resolves to. Required.',
      });
    }

    return {
      domain: host,
      isSubdomain,
      apex,
      expectedIp: expectedIp || null,
      actualIp,
      hasMail,
      checks,
      recommendedRecords,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Full DNS record dump — every record type the dashboard cares about
   * (A, AAAA, CNAME, MX, TXT, NS) for the domain, plus a reconciliation
   * pass: for each *expected* record we mark whether it's present, missing
   * or wrong. Powers the "Records" tab.
   */
  async getDnsRecords(userId: string, id: string) {
    const domain = await this.assertDomainAccess(userId, id, 'VIEWER');
    const host = domain.domain;
    const isSubdomain = host.split('.').length > 2;
    const apex = isSubdomain ? host.split('.').slice(-2).join('.') : host;

    const resolver = new dns.promises.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    const safe = async <T>(p: Promise<T>): Promise<T | null> => {
      try { return await p; } catch { return null; }
    };

    let expectedIp = '';
    try {
      const url = process.env.PUBLIC_API_URL || '';
      const m = url.match(/^https?:\/\/([^:/]+)/);
      if (m && /^\d+\.\d+\.\d+\.\d+$/.test(m[1])) expectedIp = m[1];
    } catch {}

    const [a, aaaa, cname, mx, txt, ns] = await Promise.all([
      safe(resolver.resolve4(host)),
      safe(resolver.resolve6(host)),
      safe(resolver.resolveCname(host)),
      safe(resolver.resolveMx(host)),
      safe(resolver.resolveTxt(host)),
      safe(resolver.resolveNs(apex)),
    ]);

    const actual = {
      A: (a || []).map((v) => ({ value: v })),
      AAAA: (aaaa || []).map((v) => ({ value: v })),
      CNAME: (cname || []).map((v) => ({ value: v.replace(/\.$/, '') })),
      MX: (mx || []).map((v) => ({ value: v.exchange.replace(/\.$/, ''), priority: v.priority })),
      TXT: (txt || []).map((v) => ({ value: v.join('') })),
      NS: (ns || []).map((v) => ({ value: v.replace(/\.$/, '') })),
    };

    const mailServer = await this.prisma.mailServer.findUnique({ where: { domainId: id } });
    const hasMail = !!mailServer;

    type Expected = {
      type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';
      host: string;
      value: string;
      priority?: number;
      reason: string;
      status: 'OK' | 'MISSING' | 'WRONG';
      actualValue?: string;
    };

    const expected: Expected[] = [];

    const pushExpected = (e: Omit<Expected, 'status' | 'actualValue'>) => {
      const list = (actual as any)[e.type] as { value: string; priority?: number }[];
      const found = list.find((r) => r.value.toLowerCase() === e.value.toLowerCase());
      if (found) {
        if (e.type === 'MX' && e.priority !== undefined && found.priority !== e.priority) {
          expected.push({ ...e, status: 'WRONG', actualValue: `${found.value} (prio ${found.priority})` });
          return;
        }
        expected.push({ ...e, status: 'OK', actualValue: found.value });
        return;
      }
      const anyForType = list.length > 0 ? list[0].value : undefined;
      expected.push({ ...e, status: anyForType ? 'WRONG' : 'MISSING', actualValue: anyForType });
    };

    if (isSubdomain) {
      if (actual.CNAME.length > 0) {
        pushExpected({ type: 'CNAME', host, value: apex, reason: 'Subdomain → apex (recommended).' });
      } else {
        pushExpected({ type: 'A', host, value: expectedIp || 'YOUR-SERVER-IP', reason: 'Subdomain A record → server.' });
      }
    } else {
      pushExpected({ type: 'A', host, value: expectedIp || 'YOUR-SERVER-IP', reason: 'Apex A record → server.' });
    }

    if (hasMail) {
      pushExpected({ type: 'MX', host, value: `mail.${apex}`, priority: 10, reason: 'Inbound mail routing.' });
      pushExpected({ type: 'A', host: `mail.${apex}`, value: expectedIp || 'YOUR-SERVER-IP', reason: 'MX target A record.' });
      pushExpected({ type: 'TXT', host, value: `v=spf1 mx ~all`, reason: 'SPF: authorize MX hosts to send mail.' });
    }

    return {
      domain: host,
      apex,
      isSubdomain,
      expectedIp: expectedIp || null,
      hasMail,
      actual,
      expected,
      checkedAt: new Date().toISOString(),
    };
  }
}
