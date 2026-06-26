import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

// Pin the data dir BEFORE the service module computes its constants.
// fs is fully mocked, so the path never touches the real disk.
vi.hoisted(() => {
  process.env.DOCKCONTROL_DATA_DIR = '/virt/dockcontrol';
  delete process.env.DOCKCONTROL_HOST_DATA_DIR;
  delete process.env.CADDY_DATA_VOLUME;
});

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

// In-memory fs (same approach as application-deploy.service.spec).
vi.mock('fs', () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const norm = (p: any) => String(p).replace(/\\/g, '/');
  const fsMock: any = {
    __files: files,
    __dirs: dirs,
    existsSync: vi.fn((p: any) => files.has(norm(p)) || dirs.has(norm(p))),
    mkdirSync: vi.fn((p: any) => {
      dirs.add(norm(p));
    }),
    writeFileSync: vi.fn((p: any, c: any) => {
      files.set(norm(p), String(c));
    }),
    readFileSync: vi.fn((p: any) => {
      const v = files.get(norm(p));
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    }),
    rmSync: vi.fn((p: any) => {
      const pre = norm(p);
      for (const k of [...files.keys()]) if (k === pre || k.startsWith(pre + '/')) files.delete(k);
      for (const k of [...dirs]) if (k === pre || k.startsWith(pre + '/')) dirs.delete(k);
    }),
    chmodSync: vi.fn(),
    promises: {},
    constants: {},
  };
  return { ...fsMock, default: fsMock };
});

vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn(),
}));

import * as fs from 'fs';
import { execFile } from 'child_process';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { MailServerService } from './mail-server.service';

const vfs = fs as unknown as {
  __files: Map<string, string>;
  __dirs: Set<string>;
};
const mockAssert = vi.mocked(assertProjectAccess);

const MAIL_DIR = '/virt/dockcontrol/mail';

// ── execFile driver ──────────────────────────────────────────────────
// promisify(execFile) calls the node-style callback. Handlers match on
// (cmd, argv); first non-undefined wins. Defaults: `nc` host-port probes
// FAIL (ports free), everything else succeeds with empty stdout.
const mockExecFile = vi.mocked(execFile) as any;
type ExecRes = { stdout?: string; stderr?: string };
type Handler = (cmd: string, args: string[]) => ExecRes | Error | undefined;
let handlers: Handler[] = [];

function installExecDefaults() {
  handlers = [];
  mockExecFile.mockImplementation((...a: any[]) => {
    const cmd = a[0] as string;
    const args = (Array.isArray(a[1]) ? a[1] : []) as string[];
    const cb = a[a.length - 1] as (err: any, res?: any) => void;
    let res: ExecRes | Error | undefined;
    for (const h of handlers) {
      res = h(cmd, args);
      if (res !== undefined) break;
    }
    if (res === undefined && cmd === 'docker' && args.includes('nc')) {
      res = new Error('connection refused'); // port free
    }
    if (res instanceof Error) {
      process.nextTick(() => cb(res));
      return {} as any;
    }
    process.nextTick(() => cb(null, { stdout: res?.stdout ?? '', stderr: res?.stderr ?? '' }));
    return {} as any;
  });
}

type ExecCall = { cmd: string; args: string[]; opts: any };
const execCalls = (): ExecCall[] =>
  mockExecFile.mock.calls.map((c: any[]) => ({
    cmd: c[0] as string,
    args: (Array.isArray(c[1]) ? c[1] : []) as string[],
    opts: (typeof c[2] === 'object' ? c[2] : {}) as any,
  }));
const findExec = (pred: (c: { cmd: string; args: string[]; opts: any }) => boolean) =>
  execCalls().find(pred);

// ── service factory ──────────────────────────────────────────────────

function makeModel() {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
  };
}

function makeService() {
  const prisma = {
    mailServer: makeModel(),
    domain: makeModel(),
    user: makeModel(),
    mailbox: makeModel(),
    emailAlias: makeModel(),
    application: makeModel(),
  };
  const proxy = {
    regenerate: vi.fn().mockResolvedValue(undefined),
    setMailReloadHook: vi.fn(),
    // Default: cert NOT yet issued (degraded-start path). Tests that exercise
    // the TLS path override this per-case.
    certExists: vi.fn().mockResolvedValue(false),
  };
  const encryption = {
    encrypt: vi.fn((s: string) => `enc:${s}`),
    decrypt: vi.fn((s: string) => (s.startsWith('enc:') ? s.slice(4) : s)),
  };
  const marketplace = {
    install: vi.fn().mockResolvedValue({ id: 'webmail-app-1' }),
  };
  const service = new MailServerService(prisma as any, proxy as any, encryption as any, marketplace as any);
  return { service, prisma, proxy, encryption, marketplace };
}

const DOMAIN = { id: 'dom1', domain: 'example.com', projectId: 'p1', application: null };
const CONTAINER = 'dockcontrol-mail-example-com';

beforeEach(() => {
  vi.clearAllMocks();
  vfs.__files.clear();
  vfs.__dirs.clear();
  installExecDefaults();
  mockAssert.mockResolvedValue('OWNER' as any);
});

afterEach(() => {
  delete process.env.CADDY_DATA_VOLUME;
});

// ── access control (assertDomainAccess via getStatus) ───────────────

describe('domain access', () => {
  it('404s on an unknown domain', async () => {
    const { service } = makeService();
    await expect(service.getStatus('u1', 'nope')).rejects.toThrow(NotFoundException);
  });

  it('orphan domain (no project anywhere): forbidden for regular users', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue({ ...DOMAIN, projectId: null, application: null });
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });

    await expect(service.getStatus('u1', 'dom1')).rejects.toThrow(ForbiddenException);
    expect(mockAssert).not.toHaveBeenCalled();
  });

  it('orphan domain: platform ADMIN is allowed through', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue({ ...DOMAIN, projectId: null, application: null });
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.mailServer.findUnique.mockResolvedValue(null);

    expect(await service.getStatus('u1', 'dom1')).toBeNull();
  });

  it('project-scoped domain goes through assertProjectAccess with the right minRole', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue(null);

    await service.getStatus('u1', 'dom1');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'VIEWER');
  });

  it('falls back to the linked application project when domain.projectId is null', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue({
      ...DOMAIN,
      projectId: null,
      application: { projectId: 'p-app' },
    });
    prisma.mailServer.findUnique.mockResolvedValue(null);

    await service.getStatus('u1', 'dom1');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p-app', 'VIEWER');
  });
});

// ── getStatus live probe ─────────────────────────────────────────────

describe('getStatus', () => {
  function setup() {
    const ctx = makeService();
    ctx.prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    return ctx;
  }

  it('probes docker with the exact container name and syncs STOPPED→RUNNING', async () => {
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue({
      id: 'srv1', status: 'STOPPED', domain: { domain: 'example.com' },
    });
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'inspect' ? { stdout: 'running\n' } : undefined,
    );

    const res = await service.getStatus('u1', 'dom1');
    expect(res!.status).toBe('RUNNING');
    expect(findExec((c) =>
      c.cmd === 'docker' &&
      c.args[0] === 'inspect' &&
      c.args[1] === '--format' &&
      c.args[2] === '{{.State.Status}}' &&
      c.args[3] === CONTAINER,
    )).toBeDefined();
    expect(prisma.mailServer.update).toHaveBeenCalledWith({
      where: { id: 'srv1' },
      data: { status: 'RUNNING' },
    });
  });

  it('marks the row STOPPED when docker inspect fails and DB says RUNNING', async () => {
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue({
      id: 'srv1', status: 'RUNNING', domain: { domain: 'example.com' },
    });
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'inspect' ? new Error('no such container') : undefined,
    );

    const res = await service.getStatus('u1', 'dom1');
    expect(res!.status).toBe('STOPPED');
    expect(prisma.mailServer.update).toHaveBeenCalledWith({
      where: { id: 'srv1' },
      data: { status: 'STOPPED' },
    });
  });
});

// ── deploy ───────────────────────────────────────────────────────────

describe('deploy', () => {
  function setup(domain = DOMAIN) {
    const ctx = makeService();
    ctx.prisma.domain.findUnique.mockResolvedValue(domain);
    ctx.prisma.mailServer.upsert.mockResolvedValue({ id: 'srv1', domainId: domain.id });
    // never run the real compose pipeline in deploy() tests
    const runDeploy = vi
      .spyOn(ctx.service as any, 'runDeploy')
      .mockResolvedValue(undefined);
    return { ...ctx, runDeploy };
  }

  it('refuses a subdomain on first deploy, pointing at the apex', async () => {
    const { service, prisma } = setup({ ...DOMAIN, domain: 'shop.example.com' });
    prisma.mailServer.findUnique.mockResolvedValue(null);

    await expect(service.deploy('u1', 'dom1')).rejects.toThrow(
      /"shop\.example\.com" is a subdomain.*"example\.com"/,
    );
  });

  it('allows re-deploying an already-provisioned subdomain', async () => {
    const { service, prisma } = setup({ ...DOMAIN, domain: 'shop.example.com' });
    prisma.mailServer.findUnique.mockResolvedValue({
      id: 'srv1',
      dkimPrivateKey: 'enc:KEY',
      dkimPublicKey: 'PUB',
      smtpPort: 2525, submissionPort: 2526, smtpsPort: 2527, imapPort: 2528, imapsPort: 2529,
    });

    await expect(service.deploy('u1', 'dom1')).resolves.toBeDefined();
  });

  it('requires project ADMIN', async () => {
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue(null);

    await service.deploy('u1', 'dom1');
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'ADMIN');
  });

  it('generates a 2048-bit DKIM keypair on first deploy and encrypts the private key at rest', async () => {
    const { service, prisma, encryption } = setup();
    prisma.mailServer.findUnique.mockResolvedValue(null);

    await service.deploy('u1', 'dom1');

    expect(encryption.encrypt).toHaveBeenCalledWith(
      expect.stringContaining('BEGIN PRIVATE KEY'),
    );
    const upsert = prisma.mailServer.upsert.mock.calls[0][0];
    expect(upsert.create.dkimPrivateKey).toMatch(/^enc:/);
    // public key stored header-less, single-line base64 (DNS TXT form)
    expect(upsert.create.dkimPublicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(upsert.create.dkimSelector).toBe('dockcontrol');
    expect(upsert.create.hostname).toBe('mail.example.com');
  });

  it('takes the canonical 25/587/465/143/993 port set when free', async () => {
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue(null);

    await service.deploy('u1', 'dom1');
    const { create } = prisma.mailServer.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      smtpPort: 25, submissionPort: 587, smtpsPort: 465, imapPort: 143, imapsPort: 993,
    });
  });

  it('offsets to 2525+ when another mail server already owns the standard set', async () => {
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue(null);
    prisma.mailServer.findMany.mockResolvedValue([
      { smtpPort: 25, submissionPort: 587, smtpsPort: 465, imapPort: 143, imapsPort: 993 },
    ]);

    await service.deploy('u1', 'dom1');
    const { create } = prisma.mailServer.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      smtpPort: 2525, submissionPort: 2526, smtpsPort: 2527, imapPort: 2528, imapsPort: 2529,
    });
  });

  it('also skips ports currently bound by running docker containers (orphan guard)', async () => {
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue(null);
    prisma.mailServer.findMany.mockResolvedValue([
      { smtpPort: 25, submissionPort: 587, smtpsPort: 465, imapPort: 143, imapsPort: 993 },
    ]);
    handlers.push((cmd, args) =>
      cmd === 'docker' && args[0] === 'ps'
        ? { stdout: '0.0.0.0:2525->25/tcp, [::]:2525->25/tcp\n' }
        : undefined,
    );

    await service.deploy('u1', 'dom1');
    const { create } = prisma.mailServer.upsert.mock.calls[0][0];
    expect(create.smtpPort).toBe(2535); // 2525 block skipped
  });

  it('preflights host ports and 400s with the postfix remediation when tcp/25 is held', async () => {
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue(null);
    handlers.push((cmd, args) =>
      cmd === 'docker' && args.includes('nc') && args[args.length - 1] === '25'
        ? { stdout: '' } // nc exit 0 → occupied
        : undefined,
    );

    await expect(service.deploy('u1', 'dom1')).rejects.toThrow(
      /SMTP \(25\)[\s\S]*systemctl stop postfix/,
    );
    expect(prisma.mailServer.upsert).not.toHaveBeenCalled();
  });

  it('re-deploying a RUNNING mail server skips the port preflight (its own container holds the ports)', async () => {
    // Regression: allocatePorts() returns the existing server's ports and the
    // old preflight nc-probed them — the running container itself held them,
    // so a redeploy without a manual stop always 400'd. The preflight is now
    // first-deploy only; runDeploy force-removes the container before
    // `compose up`, which releases the ports mid-pipeline.
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue({
      id: 'srv1', dkimPrivateKey: 'enc:KEY', dkimPublicKey: 'PUB',
      smtpPort: 25, submissionPort: 587, smtpsPort: 465, imapPort: 143, imapsPort: 993,
    });
    handlers.push((cmd, args) =>
      cmd === 'docker' && args.includes('nc') ? { stdout: '' } : undefined,
    );

    await expect(service.deploy('u1', 'dom1')).resolves.toBeDefined();
    expect(prisma.mailServer.upsert).toHaveBeenCalled();
  });

  it('regenerates the reverse proxy so the mail.<apex> cert exists before dovecot starts', async () => {
    const { service, prisma, proxy, runDeploy } = setup();
    prisma.mailServer.findUnique.mockResolvedValue(null);

    await service.deploy('u1', 'dom1');
    expect(proxy.regenerate).toHaveBeenCalled();
    expect(runDeploy).toHaveBeenCalledWith(
      'srv1',
      'example.com',
      expect.objectContaining({ smtp: 25 }),
      expect.stringContaining('BEGIN PRIVATE KEY'),
    );
  });
});

// ── runDeploy: compose rendering + docker pipeline ───────────────────

describe('runDeploy', () => {
  const PORTS = { smtp: 25, submission: 587, smtps: 465, imap: 143, imaps: 993 };
  const DIR = `${MAIL_DIR}/srv1`;

  it('renders the compose with named container, host-path volumes and published ports', async () => {
    process.env.CADDY_DATA_VOLUME = 'dockcontrol_caddy_data';
    const { service } = makeService();

    await (service as any).runDeploy('srv1', 'example.com', PORTS, 'PRIVKEY');

    const compose = vfs.__files.get(`${DIR}/docker-compose.yml`)!;
    expect(compose).toContain(`container_name: ${CONTAINER}`);
    expect(compose).toContain('hostname: mail.example.com');
    expect(compose).toContain('"25:25"');
    expect(compose).toContain('"587:587"');
    expect(compose).toContain('"993:993"');
    // bind mounts use the HOST path, posix-joined
    expect(compose).toContain(`- ${DIR}/data:/var/mail`);
    expect(compose).toContain(`- ${DIR}/config:/tmp/docker-mailserver`);
    expect(compose).toContain('ENABLE_OPENDKIM: 1');
  });

  it('production domain WITH issued cert: manual SSL against the Caddy cert volume', async () => {
    process.env.CADDY_DATA_VOLUME = 'mycustom_caddy_data';
    const { service, proxy } = makeService();
    proxy.certExists.mockResolvedValue(true); // cert already issued

    await (service as any).runDeploy('srv1', 'example.com', PORTS, 'PRIVKEY');

    const compose = vfs.__files.get(`${DIR}/docker-compose.yml`)!;
    expect(compose).toContain('SSL_TYPE: manual');
    expect(compose).toContain('mail.example.com/mail.example.com.crt');
    expect(compose).toContain('name: mycustom_caddy_data');
    expect(compose).toContain('- dockcontrol_caddy_data:/caddy-certs:ro');
  });

  it('production domain WITHOUT a cert yet: starts WITHOUT TLS (no crash-loop), still mounts the cert volume', async () => {
    const { service, proxy } = makeService();
    proxy.certExists.mockResolvedValue(false); // cert not issued yet

    await (service as any).runDeploy('srv1', 'example.com', PORTS, 'PRIVKEY');

    const compose = vfs.__files.get(`${DIR}/docker-compose.yml`)!;
    expect(compose).not.toContain('SSL_TYPE: manual'); // degraded start, no crash
    expect(compose).toContain("waiting for Let's Encrypt cert for mail.example.com");
    // Volume is still mounted so a later reload/redeploy finds the cert.
    expect(compose).toContain('- dockcontrol_caddy_data:/caddy-certs:ro');
  });

  it('local dev domain (.test): TLS left unconfigured, no caddy volume', async () => {
    const { service } = makeService();

    await (service as any).runDeploy('srv1', 'demo.test', PORTS, 'PRIVKEY');

    const compose = vfs.__files.get(`${DIR}/docker-compose.yml`)!;
    expect(compose).not.toContain('SSL_TYPE');
    expect(compose).not.toContain('caddy-certs');
  });

  it('ships the full OpenDKIM config: key file, KeyTable, SigningTable, TrustedHosts', async () => {
    process.env.CADDY_DATA_VOLUME = 'v';
    const { service } = makeService();

    await (service as any).runDeploy('srv1', 'example.com', PORTS, 'PRIVKEY');

    const odk = `${DIR}/config/opendkim`;
    expect(vfs.__files.get(`${odk}/keys/example.com/dockcontrol.private`)).toBe('PRIVKEY\n');
    expect(vfs.__files.get(`${odk}/KeyTable`)).toBe(
      'dockcontrol._domainkey.example.com example.com:dockcontrol:/etc/opendkim/keys/example.com/dockcontrol.private\n',
    );
    expect(vfs.__files.get(`${odk}/SigningTable`)).toBe(
      '*@example.com dockcontrol._domainkey.example.com\n',
    );
    expect(vfs.__files.get(`${odk}/TrustedHosts`)).toContain('172.16.0.0/12');
    // version stamp for the boot reconciler
    expect(vfs.__files.get(`${DIR}/.stack-version`)).toBe('2\n');
  });

  it('runs rm -f <stale container> → compose pull → compose up -d, all cwd-scoped', async () => {
    process.env.CADDY_DATA_VOLUME = 'v';
    const { service } = makeService();

    await (service as any).runDeploy('srv1', 'example.com', PORTS, 'PRIVKEY');

    const calls = execCalls().filter((c) => c.cmd === 'docker');
    const rm = calls.find((c) => c.args[0] === 'rm');
    expect(rm!.args).toEqual(['rm', '-f', CONTAINER]);
    const pull = calls.find((c) => c.args[0] === 'compose' && c.args[1] === 'pull');
    expect(String(pull!.opts.cwd).replace(/\\/g, '/')).toBe(DIR);
    const up = calls.find((c) => c.args[0] === 'compose' && c.args[1] === 'up');
    expect(up!.args).toEqual(['compose', 'up', '-d']);
    expect(String(up!.opts.cwd).replace(/\\/g, '/')).toBe(DIR);
  });

  it('records ERROR + stderr excerpt when compose up fails', async () => {
    process.env.CADDY_DATA_VOLUME = 'v';
    const { service, prisma } = makeService();
    handlers.push((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'compose' && args[1] === 'up') {
        const e: any = new Error('compose up failed');
        e.stderr = 'Bind for 0.0.0.0:25 failed: port is already allocated';
        return e;
      }
      return undefined;
    });

    await (service as any).runDeploy('srv1', 'example.com', PORTS, 'PRIVKEY');

    expect(prisma.mailServer.update).toHaveBeenCalledWith({
      where: { id: 'srv1' },
      data: {
        status: 'ERROR',
        lastError: expect.stringContaining('port is already allocated'),
      },
    });
  });
});

// ── stop / remove / removeForDomain ──────────────────────────────────

describe('stop', () => {
  it('404s when no mail server is provisioned', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue(null);

    await expect(service.stop('u1', 'dom1')).rejects.toThrow(NotFoundException);
  });

  it('compose-stops the stack in its dir and persists STOPPED', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1' });
    vfs.__dirs.add(`${MAIL_DIR}/srv1`);

    await service.stop('u1', 'dom1');

    const stop = findExec((c) => c.cmd === 'docker' && c.args[1] === 'stop');
    expect(stop!.args).toEqual(['compose', 'stop']);
    expect(String(stop!.opts.cwd).replace(/\\/g, '/')).toBe(`${MAIL_DIR}/srv1`);
    expect(prisma.mailServer.update).toHaveBeenCalledWith({
      where: { id: 'srv1' },
      data: { status: 'STOPPED' },
    });
  });
});

describe('removeForDomain', () => {
  it('full teardown: compose down -v, dir wipe, DB delete, then force-rm by name', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1' });
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    vfs.__dirs.add(`${MAIL_DIR}/srv1`);

    await service.removeForDomain('dom1');

    const down = findExec((c) => c.cmd === 'docker' && c.args[1] === 'down');
    expect(down!.args).toEqual(['compose', 'down', '-v', '--remove-orphans']);
    expect(String(down!.opts.cwd).replace(/\\/g, '/')).toBe(`${MAIL_DIR}/srv1`);
    expect(vfs.__dirs.has(`${MAIL_DIR}/srv1`)).toBe(false);
    expect(prisma.mailServer.delete).toHaveBeenCalledWith({ where: { id: 'srv1' } });
    const rm = findExec((c) => c.cmd === 'docker' && c.args[0] === 'rm');
    expect(rm!.args).toEqual(['rm', '-f', CONTAINER]);
  });

  it('orphan container with no DB row: still force-removes by derived name', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findUnique.mockResolvedValue(null);
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);

    await service.removeForDomain('dom1');

    expect(prisma.mailServer.delete).not.toHaveBeenCalled();
    const rm = findExec((c) => c.cmd === 'docker' && c.args[0] === 'rm');
    expect(rm!.args).toEqual(['rm', '-f', CONTAINER]);
  });

  it('survives a dead docker daemon — DB row and dir are still wiped', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1' });
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    vfs.__dirs.add(`${MAIL_DIR}/srv1`);
    handlers.push(() => new Error('docker daemon unreachable'));

    await service.removeForDomain('dom1');

    expect(prisma.mailServer.delete).toHaveBeenCalledWith({ where: { id: 'srv1' } });
    expect(vfs.__dirs.has(`${MAIL_DIR}/srv1`)).toBe(false);
  });

  it('no domain row: server cleanup proceeds, no container rm (name unknown)', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1' });
    prisma.domain.findUnique.mockResolvedValue(null);

    await service.removeForDomain('dom1');

    expect(prisma.mailServer.delete).toHaveBeenCalled();
    expect(findExec((c) => c.args[0] === 'rm')).toBeUndefined();
  });
});

describe('remove (user-facing)', () => {
  it('requires project ADMIN and delegates to removeForDomain', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue(null);

    const res = await service.remove('u1', 'dom1');
    expect(res).toEqual({ message: 'Mail server removed' });
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'ADMIN');
  });
});

// ── account sync ─────────────────────────────────────────────────────

describe('syncAccounts', () => {
  const DIR = `${MAIL_DIR}/srv1`;

  function setup() {
    const ctx = makeService();
    ctx.prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1', domainId: 'dom1' });
    ctx.prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    vfs.__dirs.add(DIR);
    ctx.prisma.mailbox.findMany.mockImplementation(async (q: any) =>
      q?.where?.NOT
        ? [{ address: 'fwd@example.com', forwardTo: 'dest@elsewhere.io' }]
        : [{ address: 'alice@example.com', passwordHash: '$2a$10$hashhash' }],
    );
    ctx.prisma.emailAlias.findMany.mockResolvedValue([
      { address: 'sales@example.com', mailbox: { address: 'alice@example.com' }, forwardTo: null },
      { address: 'noreply@example.com', mailbox: null, forwardTo: 'ext@other.io' },
    ]);
    return ctx;
  }

  it('writes accounts with the {BLF-CRYPT} scheme and normalizes $2a$→$2y$', async () => {
    const { service } = setup();
    await service.syncAccounts('dom1');
    expect(vfs.__files.get(`${DIR}/config/postfix-accounts.cf`)).toBe(
      'alice@example.com|{BLF-CRYPT}$2y$10$hashhash\n',
    );
  });

  it('writes virtual maps for forwards and aliases (mailbox or external dest)', async () => {
    const { service } = setup();
    await service.syncAccounts('dom1');
    expect(vfs.__files.get(`${DIR}/config/postfix-virtual.cf`)).toBe(
      'fwd@example.com  dest@elsewhere.io\n' +
        'sales@example.com  alice@example.com\n' +
        'noreply@example.com  ext@other.io\n',
    );
  });

  it('emits a catch-all "@domain target" line when a mailbox is flagged catchAll', async () => {
    const { service, prisma } = setup();
    // alice is the catch-all box; she receives any unmatched @example.com mail.
    prisma.mailbox.findMany.mockImplementation(async (q: any) =>
      q?.where?.NOT
        ? [{ address: 'fwd@example.com', forwardTo: 'dest@elsewhere.io', catchAll: false }]
        : [{ address: 'alice@example.com', passwordHash: '$2a$10$hashhash', catchAll: true }],
    );
    await service.syncAccounts('dom1');
    expect(vfs.__files.get(`${DIR}/config/postfix-virtual.cf`)).toBe(
      'fwd@example.com  dest@elsewhere.io\n' +
        'sales@example.com  alice@example.com\n' +
        'noreply@example.com  ext@other.io\n' +
        '@example.com  alice@example.com\n',
    );
  });

  it('reloads postfix + dovecot + flushes the auth cache after a change', async () => {
    const { service } = setup();
    await service.syncAccounts('dom1');
    const execs = execCalls().filter((c) => c.args[0] === 'exec');
    expect(execs.map((c) => c.args)).toEqual([
      ['exec', CONTAINER, 'postfix', 'reload'],
      ['exec', CONTAINER, 'doveadm', 'reload'],
      ['exec', CONTAINER, 'doveadm', 'auth', 'cache', 'flush'],
    ]);
  });

  it('is a no-op (no reload) when on-disk content already matches', async () => {
    const { service } = setup();
    vfs.__files.set(
      `${DIR}/config/postfix-accounts.cf`,
      'alice@example.com|{BLF-CRYPT}$2y$10$hashhash\n',
    );
    vfs.__files.set(
      `${DIR}/config/postfix-virtual.cf`,
      'fwd@example.com  dest@elsewhere.io\n' +
        'sales@example.com  alice@example.com\n' +
        'noreply@example.com  ext@other.io\n',
    );

    await service.syncAccounts('dom1');
    expect(execCalls().filter((c) => c.args[0] === 'exec')).toHaveLength(0);
  });

  it('returns silently when no mail server / compose dir exists', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findUnique.mockResolvedValue(null);
    await service.syncAccounts('dom1');
    expect(execCalls()).toHaveLength(0);
  });
});

// ── test email (validation paths only — no real SMTP) ────────────────

describe('sendTestEmail', () => {
  it('404s when no mail server is deployed', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue(null);
    await expect(service.sendTestEmail('u1', 'dom1', 'mb1', 'a@b.co')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('404s on a mailbox not belonging to this domain', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1' });
    prisma.mailbox.findFirst.mockResolvedValue(null);
    await expect(service.sendTestEmail('u1', 'dom1', 'mb1', 'a@b.co')).rejects.toThrow(
      'Mailbox not found on this domain',
    );
  });

  it('rejects a malformed recipient before touching the network', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1' });
    prisma.mailbox.findFirst.mockResolvedValue({ id: 'mb1', localPart: 'alice' });
    await expect(
      service.sendTestEmail('u1', 'dom1', 'mb1', 'not-an-email'),
    ).rejects.toThrow(BadRequestException);
  });
});

// ── fail2ban / logs / session kick ───────────────────────────────────

describe('unbanIp', () => {
  function setup() {
    const ctx = makeService();
    ctx.prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    return ctx;
  }

  it.each(['1.2.3.4; rm -rf /', '$(reboot)', '1.2.3.4 --flag', '`id`'])(
    'rejects hostile input %j (argv injection impossible)',
    async (ip) => {
      const { service } = setup();
      await expect(service.unbanIp('u1', 'dom1', ip)).rejects.toThrow('Invalid IP.');
      expect(execCalls()).toHaveLength(0);
    },
  );

  it('unbans a well-formed IP with the exact fail2ban argv', async () => {
    const { service } = setup();
    const res = await service.unbanIp('u1', 'dom1', '203.0.113.7');
    expect(res).toEqual({ unbanned: '203.0.113.7' });
    const call = findExec((c) => c.args.includes('unban'));
    expect(call!.args).toEqual(['exec', CONTAINER, 'fail2ban-client', 'unban', '203.0.113.7']);
    expect(mockAssert).toHaveBeenCalledWith(expect.anything(), 'u1', 'p1', 'ADMIN');
  });

  it('maps a docker failure to NotFound instead of leaking the raw error', async () => {
    const { service } = setup();
    handlers.push((cmd, args) => (args.includes('unban') ? new Error('container down') : undefined));
    await expect(service.unbanIp('u1', 'dom1', '203.0.113.7')).rejects.toThrow(NotFoundException);
  });
});

describe('getLogs', () => {
  function setup() {
    const ctx = makeService();
    ctx.prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    return ctx;
  }

  it('reads via `docker logs` (always available) and clamps the line count to [10, 5000]', async () => {
    const { service } = setup();
    await service.getLogs('u1', 'dom1', { lines: 999_999 });
    expect(findExec((c) => c.args[0] === 'logs')!.args).toEqual([
      'logs', '--tail', '5000', '--timestamps', CONTAINER,
    ]);
  });

  it('service-scoped logs FILTER docker logs (no fragile tail on a maybe-missing file)', async () => {
    const { service } = setup();
    // docker logs returns mixed lines; the rspamd filter keeps only its lines.
    handlers.push((cmd, args) =>
      args[0] === 'logs'
        ? { stdout: 'x postfix/smtpd: hi\ny rspamd: spam check ok\nz dovecot: login\n' }
        : undefined,
    );
    const res = await service.getLogs('u1', 'dom1', { service: 'rspamd' });
    expect(res.logs).toContain('rspamd: spam check ok');
    expect(res.logs).not.toContain('dovecot: login');
    // It reads `docker logs`, NOT `tail` on a file.
    expect(findExec((c) => c.args[0] === 'exec' && c.args.includes('tail'))).toBeUndefined();
  });

  it('reports cleanly when a service has no lines in the window', async () => {
    const { service } = setup();
    handlers.push((cmd, args) => (args[0] === 'logs' ? { stdout: 'only postfix here\n' } : undefined));
    const res = await service.getLogs('u1', 'dom1', { service: 'fail2ban' });
    expect(res.logs).toContain('no fail2ban log lines');
  });

  it('never throws on docker failure — returns the error inline', async () => {
    const { service } = setup();
    handlers.push(() => new Error('no such container'));
    const res = await service.getLogs('u1', 'dom1');
    expect(res.logs).toContain('failed to read logs');
  });
});

describe('kickMailboxSessions', () => {
  it('kicks live IMAP sessions via doveadm with the exact argv', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    await service.kickMailboxSessions('dom1', 'alice@example.com');
    const call = findExec((c) => c.args.includes('kick'));
    expect(call!.args).toEqual(['exec', CONTAINER, 'doveadm', 'kick', 'alice@example.com']);
  });

  it('is silent when the domain row is gone or the container is down', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(null);
    await service.kickMailboxSessions('dom1', 'a@b.co');
    expect(execCalls()).toHaveLength(0);

    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    handlers.push(() => new Error('container down'));
    await expect(service.kickMailboxSessions('dom1', 'a@b.co')).resolves.toBeUndefined();
  });
});

describe('deployWebmail (1-click Roundcube)', () => {
  function setup() {
    const ctx = makeService();
    ctx.prisma.domain.findUnique.mockResolvedValue(DOMAIN); // assertDomainAccess
    ctx.prisma.mailServer.findUnique.mockResolvedValue({
      id: 'ms1', domainId: 'dom1', imapsPort: 993, submissionPort: 587,
    });
    return ctx;
  }

  it('default (newDomain): installs Roundcube on a dedicated subdomain webmail.<apex>, preconfigured', async () => {
    const { service, prisma, marketplace } = setup();
    prisma.application.findFirst.mockResolvedValue(null); // none yet

    const res = await service.deployWebmail('u1', 'dom1', { access: 'newDomain' });
    expect(res.alreadyInstalled).toBe(false);
    expect(res.applicationId).toBe('webmail-app-1');

    const [data, userId] = marketplace.install.mock.calls[0];
    expect(userId).toBe('u1');
    expect(data.appSlug).toBe('roundcube');
    expect(data.projectId).toBe('p1');
    // Dedicated subdomain — NOT the mail apex (no more silent takeover).
    expect(data.newDomain).toBe('webmail.example.com');
    expect(data.domainId).toBeUndefined();
    // Env points at the INTERNAL mail container over the docker network
    // (STARTTLS on 143/587) — NOT the public mail.<domain>:993 (which would
    // need the Let's Encrypt cert). So the webmail works without DNS/cert.
    expect(data.envVars.ROUNDCUBEMAIL_DEFAULT_HOST).toBe('tls://dockcontrol-mail-example-com');
    expect(data.envVars.ROUNDCUBEMAIL_DEFAULT_PORT).toBe('143');
    expect(data.envVars.ROUNDCUBEMAIL_SMTP_SERVER).toBe('tls://dockcontrol-mail-example-com');
    expect(data.envVars.ROUNDCUBEMAIL_SMTP_PORT).toBe('587');
  });

  it('newDomain honours a custom subdomain', async () => {
    const { service, prisma, marketplace } = setup();
    prisma.application.findFirst.mockResolvedValue(null);
    await service.deployWebmail('u1', 'dom1', { access: 'newDomain', newDomain: 'Mail.Example.COM' });
    expect(marketplace.install.mock.calls[0][0].newDomain).toBe('mail.example.com');
  });

  it('port access: passes hostPort, no domain', async () => {
    const { service, prisma, marketplace } = setup();
    prisma.application.findFirst.mockResolvedValue(null);
    await service.deployWebmail('u1', 'dom1', { access: 'port', hostPort: 8085 });
    const data = marketplace.install.mock.calls[0][0];
    expect(data.hostPort).toBe(8085);
    expect(data.domainId).toBeUndefined();
    expect(data.newDomain).toBeUndefined();
  });

  it('port access without a port → 400', async () => {
    const { service, prisma } = setup();
    prisma.application.findFirst.mockResolvedValue(null);
    await expect(service.deployWebmail('u1', 'dom1', { access: 'port' })).rejects.toThrow(/host port is required/);
  });

  it('existingDomain access: attaches to the chosen domain', async () => {
    const { service, prisma, marketplace } = setup();
    prisma.application.findFirst.mockResolvedValue(null);
    await service.deployWebmail('u1', 'dom1', { access: 'existingDomain', targetDomainId: 'dom-other' });
    expect(marketplace.install.mock.calls[0][0].domainId).toBe('dom-other');
  });

  it('existingDomain without a target → 400', async () => {
    const { service, prisma } = setup();
    prisma.application.findFirst.mockResolvedValue(null);
    await expect(service.deployWebmail('u1', 'dom1', { access: 'existingDomain' })).rejects.toThrow(/Choose a domain/);
  });

  it('is idempotent — reuses an existing linked webmail (no second install)', async () => {
    const { service, prisma, marketplace } = setup();
    prisma.application.findFirst.mockResolvedValue({ id: 'existing-wm' });

    const res = await service.deployWebmail('u1', 'dom1', { access: 'port', hostPort: 8085 });
    expect(res).toEqual({ applicationId: 'existing-wm', alreadyInstalled: true });
    expect(marketplace.install).not.toHaveBeenCalled();
  });

  it('refuses when the mail server is not deployed yet', async () => {
    const { service, prisma } = setup();
    prisma.mailServer.findUnique.mockResolvedValue(null);
    await expect(service.deployWebmail('u1', 'dom1', { access: 'newDomain' })).rejects.toThrow(/mail server first/);
  });
});

describe('antispam config', () => {
  const PORTS = { smtp: 25, submission: 587, smtps: 465, imap: 143, imaps: 993 };
  const DIR = `${MAIL_DIR}/srv1`;

  it('applyPreset expands maximum to greylisting + antivirus + low threshold + reject', () => {
    const { service } = makeService();
    const base = (service as any).antispamFromRow(null);
    expect((service as any).applyPreset('maximum', base)).toMatchObject({
      greylisting: true, antivirus: true, spamAction: 'reject', spamThreshold: 4,
    });
    expect((service as any).applyPreset('standard', base)).toMatchObject({
      greylisting: false, antivirus: false, spamAction: 'add_header', spamThreshold: 6,
    });
  });

  it('runDeploy reflects the config in env toggles + writes rspamd actions', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findUnique.mockResolvedValue({
      id: 'srv1', greylisting: true, antivirus: true, spamAction: 'reject', spamThreshold: 4,
      whitelist: 'friend@good.com', blacklist: 'spammer.biz',
    });
    await (service as any).runDeploy('srv1', 'example.com', PORTS, 'PRIVKEY');

    const compose = vfs.__files.get(`${DIR}/docker-compose.yml`)!;
    expect(compose).toContain('ENABLE_POSTGREY: 1');
    expect(compose).toContain('ENABLE_CLAMAV: 1');

    const actions = vfs.__files.get(`${DIR}/config/rspamd/override.d/actions.conf`)!;
    expect(actions).toContain('reject = 4');
    // DMS already wraps this file in `actions { … }` — we must NOT re-wrap it,
    // else rspamd sees `actions { actions { … } }` and crash-loops.
    expect(actions).not.toContain('actions {');

    // Maps written + referenced only when the lists are non-empty.
    expect(vfs.__files.get(`${DIR}/config/rspamd/whitelist.map`)).toContain('friend@good.com');
    expect(vfs.__files.get(`${DIR}/config/rspamd/blacklist.map`)).toContain('spammer.biz');
    const multimap = vfs.__files.get(`${DIR}/config/rspamd/override.d/multimap.conf`)!;
    expect(multimap).toContain('DOCKCONTROL_WHITELIST');
    expect(multimap).toContain('DOCKCONTROL_BLACKLIST');
  });

  it('runDeploy with add_header action pushes reject out of reach (mark only)', async () => {
    const { service, prisma } = makeService();
    prisma.mailServer.findUnique.mockResolvedValue({
      id: 'srv1', greylisting: false, antivirus: false, spamAction: 'add_header', spamThreshold: 6,
    });
    await (service as any).runDeploy('srv1', 'example.com', PORTS, 'PRIVKEY');
    const compose = vfs.__files.get(`${DIR}/docker-compose.yml`)!;
    expect(compose).toContain('ENABLE_POSTGREY: 0');
    expect(compose).toContain('ENABLE_CLAMAV: 0');
    const actions = vfs.__files.get(`${DIR}/config/rspamd/override.d/actions.conf`)!;
    expect(actions).toContain('reject = 999'); // never bounce, just flag
  });

  it('setAntispam (preset) persists the expanded settings + redeploys', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN); // assertDomainAccess (deploy too)
    prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1', domainId: 'dom1', spamPreset: 'standard' });
    // deploy() reads the domain + upserts; keep it from throwing by stubbing runDeploy.
    vi.spyOn(service as any, 'deploy').mockResolvedValue({});

    const res = await service.setAntispam('u1', 'dom1', { preset: 'strict' });
    const saved = prisma.mailServer.update.mock.calls[0][0].data;
    expect(saved).toMatchObject({ spamPreset: 'strict', greylisting: true, spamAction: 'reject', spamThreshold: 5 });
    expect(res.redeploying).toBe(true);
  });

  it('setAntispam refuses when no mail server exists', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue(null);
    await expect(service.setAntispam('u1', 'dom1', { preset: 'strict' })).rejects.toThrow(/Deploy the mail server first/);
  });

  it('setAntispam is gated to project ADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    mockAssert.mockRejectedValueOnce(new Error('forbidden'));
    await expect(service.setAntispam('u1', 'dom1', { preset: 'maximum' })).rejects.toThrow();
  });
});

describe('reloadMailServer — TLS bootstrap', () => {
  const DIR = `${MAIL_DIR}/srv1`;

  it('redeploys with TLS when the cert appears and the compose had no SSL_TYPE', async () => {
    const { service, prisma, proxy } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue({
      id: 'srv1', domainId: 'dom1', smtpPort: 25, submissionPort: 587, smtpsPort: 465,
      imapPort: 143, imapsPort: 993, dkimPrivateKey: null,
    });
    // Existing compose was generated WITHOUT TLS (degraded start).
    vfs.__files.set(`${DIR}/docker-compose.yml`, 'services:\n  mailserver:\n    # no TLS yet');
    proxy.certExists.mockResolvedValue(true); // cert now present
    const runSpy = vi.spyOn(service as any, 'runDeploy').mockResolvedValue(undefined);

    await service.reloadMailServer('dom1');
    expect(runSpy).toHaveBeenCalledWith('srv1', 'example.com', expect.objectContaining({ imaps: 993 }), '');
  });

  it('just reloads (no redeploy) when TLS is already configured', async () => {
    const { service, prisma, proxy } = makeService();
    prisma.domain.findUnique.mockResolvedValue(DOMAIN);
    prisma.mailServer.findUnique.mockResolvedValue({ id: 'srv1', domainId: 'dom1' });
    vfs.__files.set(`${DIR}/docker-compose.yml`, 'services:\n  mailserver:\n    environment:\n      SSL_TYPE: manual');
    proxy.certExists.mockResolvedValue(true);
    const runSpy = vi.spyOn(service as any, 'runDeploy').mockResolvedValue(undefined);

    await service.reloadMailServer('dom1');
    expect(runSpy).not.toHaveBeenCalled();
    // falls through to postfix/doveadm reload
    expect(findExec((c) => c.args.includes('postfix'))).toBeTruthy();
  });
});
