import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
  listAccessibleProjectIds: vi.fn(),
}));

import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { DomainsService } from './domains.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import { TransferDomainDto } from './dto/transfer-domain.dto';

const mockAssert = vi.mocked(assertProjectAccess);
const mockListIds = vi.mocked(listAccessibleProjectIds);

function makeModel() {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };
}

function makeService() {
  const prisma = {
    domain: makeModel(),
    application: makeModel(),
    mailServer: makeModel(),
    user: makeModel(),
  };
  const proxy = { regenerate: vi.fn().mockResolvedValue(undefined) };
  const mailServer = { removeForDomain: vi.fn().mockResolvedValue(undefined) };
  const domainAttach = {
    attach: vi.fn().mockResolvedValue(undefined),
    detachAll: vi.fn().mockResolvedValue(undefined),
  };
  const service = new DomainsService(
    prisma as any,
    proxy as any,
    mailServer as any,
    domainAttach as any,
  );
  return { service, prisma, proxy, mailServer, domainAttach };
}

const DOMAIN = {
  id: 'd1',
  domain: 'example.com',
  projectId: 'p1',
  applicationId: null,
  application: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssert.mockResolvedValue('OWNER' as any);
  mockListIds.mockResolvedValue(['p1']);
});

// ── DTO validation (the controller's ValidationPipe runs these) ──────

describe('CreateDomainDto domain validation', () => {
  async function errorsFor(domain: string) {
    const dto = plainToInstance(CreateDomainDto, { domain, projectId: 'p1' });
    return validate(dto);
  }

  it.each([
    'example.com',
    'app.example.com',
    'deep.sub.example.co.uk',
    'xn--bcher-kva.example', // punycode IDN label is plain LDH — allowed
    'a-1.io',
  ])('accepts %j', async (d) => {
    expect(await errorsFor(d)).toHaveLength(0);
  });

  it.each([
    'https://example.com', // protocol
    'example.com/path', // slash
    'exa mple.com', // whitespace
    'bücher.example', // raw IDN (non-ASCII) — must be punycoded first
    '-leading.example.com', // leading hyphen in label
    'trailing-.example.com', // trailing hyphen in label
    'example', // single label, no TLD
    'example.c0m!', // junk in TLD
    '{caddy}.example.com', // Caddyfile injection attempt
    'a'.repeat(64) + '.com', // label > 63 chars
    ('a.'.repeat(127) + 'com'), // total > 253
  ])('rejects %j', async (d) => {
    expect((await errorsFor(d)).length).toBeGreaterThan(0);
  });

  it('requires projectId', async () => {
    const dto = plainToInstance(CreateDomainDto, { domain: 'example.com' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'projectId')).toBe(true);
  });
});

describe('TransferDomainDto', () => {
  it('rejects empty / overlong targetProjectId', async () => {
    expect(await validate(plainToInstance(TransferDomainDto, { targetProjectId: '' }))).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(TransferDomainDto, { targetProjectId: 'x'.repeat(65) })),
    ).not.toHaveLength(0);
    expect(await validate(plainToInstance(TransferDomainDto, { targetProjectId: 'p2' }))).toHaveLength(0);
  });
});

// ── create ───────────────────────────────────────────────────────────

describe('create', () => {
  it('409s on a duplicate domain', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    await expect(
      service.create('u1', { domain: 'example.com', projectId: 'p1' } as any),
    ).rejects.toThrow(ConflictException);
  });

  it('requires a projectId when no app is linked', async () => {
    const { service } = makeService();
    await expect(service.create('u1', { domain: 'example.com' } as any)).rejects.toThrow(
      /projectId is required/,
    );
  });

  it('derives the project from the linked application', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p-app' });
    prisma.domain.create.mockResolvedValue({ id: 'd1' });

    await service.create('u1', { domain: 'example.com', applicationId: 'a1' } as any);

    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p-app', 'DEVELOPER');
    expect(prisma.domain.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: 'p-app', applicationId: 'a1' }),
    });
  });

  it('rejects a projectId that contradicts the app project', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue({ projectId: 'p-app' });
    await expect(
      service.create('u1', {
        domain: 'example.com', applicationId: 'a1', projectId: 'p-other',
      } as any),
    ).rejects.toThrow("Application doesn't belong to the given project");
  });

  it('404s on an unknown application', async () => {
    const { service, prisma } = makeService();
    prisma.application.findUnique.mockResolvedValue(null);
    await expect(
      service.create('u1', { domain: 'example.com', applicationId: 'ghost' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('strips autoSsl from the persisted data and triggers Caddy regen', async () => {
    const { service, prisma, proxy } = makeService();
    prisma.domain.create.mockResolvedValue({ id: 'd1' });

    await service.create('u1', {
      domain: 'example.com', projectId: 'p1', autoSsl: true,
    } as any);

    const data = prisma.domain.create.mock.calls[0][0].data;
    expect(data.autoSsl).toBeUndefined();
    expect(data).toMatchObject({ domain: 'example.com', projectId: 'p1', applicationId: null });
    expect(proxy.regenerate).toHaveBeenCalledTimes(1);
  });

  it('RBAC failure propagates and nothing is created', async () => {
    const { service, prisma } = makeService();
    mockAssert.mockRejectedValue(new ForbiddenException('nope'));
    await expect(
      service.create('u1', { domain: 'example.com', projectId: 'p1' } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.domain.create).not.toHaveBeenCalled();
  });
});

// ── reads ────────────────────────────────────────────────────────────

describe('findAll / findOne', () => {
  it('findAll returns [] without querying when no project is accessible', async () => {
    const { service, prisma } = makeService();
    mockListIds.mockResolvedValue([]);
    expect(await service.findAll('u1')).toEqual([]);
    expect(prisma.domain.findMany).not.toHaveBeenCalled();
  });

  it('findAll scopes to accessible projects and attaches the mailServer flag', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findMany.mockResolvedValue([
      { id: 'd1', domain: 'a.com' },
      { id: 'd2', domain: 'b.com' },
    ]);
    prisma.mailServer.findMany.mockResolvedValue([
      { domainId: 'd1', status: 'RUNNING', hostname: 'mail.a.com' },
    ]);

    const res = await service.findAll('u1');
    expect(prisma.domain.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: { in: ['p1'] } } }),
    );
    expect(res[0].mailServer).toMatchObject({ status: 'RUNNING' });
    expect(res[1].mailServer).toBeNull();
  });

  it('findOne 404s on a missing domain', async () => {
    const { service } = makeService();
    await expect(service.findOne('u1', 'ghost')).rejects.toThrow(NotFoundException);
  });

  it('orphan domain (no project): regular users are refused, platform ADMIN passes', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue({ ...DOMAIN, projectId: null, application: null });
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    await expect(service.findOne('u1', 'd1')).rejects.toThrow('Domain has no project');

    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    await expect(service.findOne('u1', 'd1')).resolves.toBeDefined();
    expect(mockAssert).not.toHaveBeenCalled();
  });
});

// ── update: attach / detach ──────────────────────────────────────────

describe('update (attach/detach app)', () => {
  function setup() {
    const ctx = makeService();
    ctx.prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    return ctx;
  }

  it('attach routes through DomainAttachService and re-homes the domain', async () => {
    const { service, prisma, domainAttach, proxy } = setup();
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'p2', port: 8080, customPort: true,
    });

    await service.update('u1', 'd1', { applicationId: 'a2' });

    expect(domainAttach.attach).toHaveBeenCalledWith({
      applicationId: 'a2',
      domainId: 'd1',
      projectId: 'p2',
      customPort: true,
      port: 8080,
    });
    expect(prisma.domain.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { projectId: 'p2' },
    });
    // RBAC on BOTH the domain and the target app's project
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'DEVELOPER');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p2', 'DEVELOPER');
    expect(proxy.regenerate).toHaveBeenCalled();
  });

  it('attach defaults the port to 80 when the app has none', async () => {
    const { service, prisma, domainAttach } = setup();
    prisma.application.findUnique.mockResolvedValue({
      projectId: 'p2', port: null, customPort: null,
    });
    await service.update('u1', 'd1', { applicationId: 'a2' });
    expect(domainAttach.attach).toHaveBeenCalledWith(
      expect.objectContaining({ port: 80, customPort: false }),
    );
  });

  it('attach 404s on an unknown target app', async () => {
    const { service, prisma } = setup();
    prisma.application.findUnique.mockResolvedValue(null);
    await expect(service.update('u1', 'd1', { applicationId: 'ghost' })).rejects.toThrow(
      'Target application not found',
    );
  });

  it('detach (applicationId: null) goes through detachAll when an app was linked', async () => {
    const { service, prisma, domainAttach } = setup();
    prisma.domain.findUnique
      .mockResolvedValueOnce(DOMAIN) // assertDomainAccess
      .mockResolvedValueOnce({ applicationId: 'a-old' }); // current link

    await service.update('u1', 'd1', { applicationId: null });
    expect(domainAttach.detachAll).toHaveBeenCalledWith('a-old', 'd1');
  });

  it('detach with no prior link just nulls the column', async () => {
    const { service, prisma, domainAttach } = setup();
    prisma.domain.findUnique
      .mockResolvedValueOnce(DOMAIN)
      .mockResolvedValueOnce({ applicationId: null });

    await service.update('u1', 'd1', { applicationId: null });
    expect(domainAttach.detachAll).not.toHaveBeenCalled();
    expect(prisma.domain.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { applicationId: null },
    });
  });

  it('projectId-only update requires DEVELOPER on the target project', async () => {
    const { service, prisma } = setup();
    await service.update('u1', 'd1', { projectId: 'p3' });
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p3', 'DEVELOPER');
    expect(prisma.domain.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { projectId: 'p3' },
    });
  });
});

// ── remove ───────────────────────────────────────────────────────────

describe('remove', () => {
  it('requires ADMIN, tears down mail FIRST, then deletes + regen', async () => {
    const { service, prisma, mailServer, proxy } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    const order: string[] = [];
    mailServer.removeForDomain.mockImplementation(async () => { order.push('mail'); });
    prisma.domain.delete.mockImplementation(async () => { order.push('delete'); return {}; });

    const res = await service.remove('u1', 'd1');
    expect(res).toEqual({ message: 'Domain deleted' });
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'ADMIN');
    expect(order).toEqual(['mail', 'delete']);
    expect(proxy.regenerate).toHaveBeenCalled();
  });

  it('a mail-teardown failure does not block the domain deletion', async () => {
    const { service, prisma, mailServer } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    mailServer.removeForDomain.mockRejectedValue(new Error('docker down'));

    await expect(service.remove('u1', 'd1')).resolves.toEqual({ message: 'Domain deleted' });
    expect(prisma.domain.delete).toHaveBeenCalledWith({ where: { id: 'd1' } });
  });
});

// ── transfer ─────────────────────────────────────────────────────────

describe('transfer (inter-project)', () => {
  it('requires ADMIN on source and DEVELOPER on target', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.domain.update.mockResolvedValue({ id: 'd1', projectId: 'p2' });

    await service.transfer('u1', 'd1', 'p2');
    expect(mockAssert).toHaveBeenNthCalledWith(1, expect.anything(), 'u1', 'p1', 'ADMIN');
    expect(mockAssert).toHaveBeenNthCalledWith(2, expect.anything(), 'u1', 'p2', 'DEVELOPER');
  });

  it('moves the domain, breaks the app link, regenerates Caddy', async () => {
    const { service, prisma, proxy } = makeService();
    prisma.domain.findUnique.mockResolvedValue({ ...DOMAIN, applicationId: 'a1' });
    prisma.domain.update.mockResolvedValue({ id: 'd1', projectId: 'p2', applicationId: null });

    const res: any = await service.transfer('u1', 'd1', 'p2');
    expect(prisma.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1' },
        data: { projectId: 'p2', applicationId: null },
      }),
    );
    expect(res.projectId).toBe('p2');
    expect(proxy.regenerate).toHaveBeenCalled();
  });

  it('refuses when the caller lacks DEVELOPER on the target', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    mockAssert.mockImplementation(async (_p: any, _u: any, pid: any) => {
      if (pid === 'p2') throw new ForbiddenException('not a member of target');
      return 'OWNER' as any;
    });

    await expect(service.transfer('u1', 'd1', 'p2')).rejects.toThrow('not a member of target');
    expect(prisma.domain.update).not.toHaveBeenCalled();
  });
});
