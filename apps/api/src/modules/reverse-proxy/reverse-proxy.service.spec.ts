import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ReverseProxyService Caddyfile rendering tests — same recipe as the other
 * service specs: plain vi.fn() prisma, no DB, no docker.
 *
 * child_process.execFile is mocked (promisify.custom) so `caddy reload`
 * resolves instantly; fs is fully stubbed so no Caddyfile/override file
 * ever lands on disk. regenerate() returns the rendered Caddyfile, which
 * is what every assertion below reads.
 */

const { execFileAsyncMock, writeFileSyncMock, renameSyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  renameSyncMock: vi.fn(),
}));

vi.mock('child_process', async () => {
  const util = await import('util');
  const execFile: any = vi.fn();
  execFile[util.promisify.custom] = (...args: unknown[]) => execFileAsyncMock(...args);
  const exec: any = vi.fn();
  exec[util.promisify.custom] = vi.fn();
  return { exec, execFile, spawn: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...real,
    existsSync: vi.fn().mockReturnValue(true), // PROXY_DIR "exists" → no mkdir
    mkdirSync: vi.fn(),
    writeFileSync: writeFileSyncMock,
    // Atomic Caddyfile publish writes Caddyfile.tmp then renames over the
    // target — stub the rename so no real file ops happen on disk.
    renameSync: renameSyncMock,
    readFileSync: vi.fn().mockReturnValue(''), // compose override read
  };
  return { ...mocked, default: mocked };
});

import { ReverseProxyService } from './reverse-proxy.service';

function makePrisma(domains: any[] = []) {
  return {
    domain: {
      findMany: vi.fn().mockResolvedValue(domains),
      update: vi.fn().mockResolvedValue({}),
    },
    mailServer: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // system_domain platform-domain block — null = no platform domain set.
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

function makeService(domains: any[] = []) {
  const prisma = makePrisma(domains);
  const service = new ReverseProxyService(prisma as any);
  return { service, prisma };
}

/** A Domain row as regenerate()'s findMany include shape returns it. */
function domainRow(overrides: Partial<any> = {}): any {
  return {
    id: 'd1',
    domain: 'athexis.xyz',
    applicationId: null,
    application: null,
    portBindings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('regenerate — HTTPS-only upstreams (Portainer)', () => {
  it('marketplace Portainer (containerName prefix) → https upstream + tls_insecure_skip_verify', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: 'a1',
        application: {
          id: 'a1',
          name: 'Portainer',
          port: 9443,
          customPort: false,
          containerName: 'dockcontrol-portainer-abc123def456',
          containerPort: 9443,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy https://dockcontrol-portainer-abc123def456:9443');
    expect(caddyfile).toContain('tls_insecure_skip_verify');
  });

  it('lowercase auto-name "portainer" (unified deploy dialog) still matches', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: 'a1',
        application: {
          id: 'a1',
          name: 'portainer',
          port: 12000, // user-remapped host port — port hint alone would miss
          customPort: true,
          containerName: null, // legacy install without container target
          containerPort: null,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy https://host.docker.internal:12000');
    expect(caddyfile).toContain('tls_insecure_skip_verify');
  });

  it('multi-install suffix "Portainer 2" matches too', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: 'a1',
        application: {
          id: 'a1',
          name: 'Portainer 2',
          port: 9453,
          customPort: false,
          containerName: 'dockcontrol-portainer-fff000fff000',
          containerPort: 9443,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy https://dockcontrol-portainer-fff000fff000:9443');
  });

  it('9443 container port alone (no recognizable name) flags the upstream as TLS', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: 'a1',
        application: {
          id: 'a1',
          name: 'My Admin UI',
          port: 18000,
          customPort: false,
          containerName: 'dockcontrol-custom-abc123def456',
          containerPort: 9443,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy https://dockcontrol-custom-abc123def456:9443');
    expect(caddyfile).toContain('tls_insecure_skip_verify');
  });

  it('new Portainer install (HTTP listener 9000) stays plain http despite the name', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: 'a1',
        application: {
          id: 'a1',
          name: 'Portainer',
          port: 9090,
          customPort: false,
          containerName: 'dockcontrol-portainer-abc123def456',
          containerPort: 9000,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy dockcontrol-portainer-abc123def456:9000');
    expect(caddyfile).not.toContain('tls_insecure_skip_verify');
  });

  it('remote-server app → Caddy proxies to <server-host>:<hostPort>, not the container name', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: 'a1',
        application: {
          id: 'a1',
          name: 'WordPress',
          port: 8080,
          customPort: false,
          containerName: 'dockcontrol-wordpress-abc123def456',
          containerPort: 80,
          project: { server: { host: '203.0.113.7' } },
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy 203.0.113.7:8080');
    expect(caddyfile).not.toContain('dockcontrol-wordpress-abc123def456:80');
  });

  it('remote port-bound app → https://domain proxies through instead of redirecting to a dead local port', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: null,
        application: null,
        portBindings: [
          {
            id: 'b1',
            port: 12000,
            application: {
              id: 'a1',
              name: 'Grafana',
              containerName: 'dockcontrol-grafana-abc123def456',
              containerPort: 3000,
              port: 12000,
              project: { server: { host: '203.0.113.7' } },
            },
          },
        ],
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy 203.0.113.7:12000');
    expect(caddyfile).not.toContain('redir http://athexis.xyz:12000');
  });

  it('local port-bound app keeps the 308 redirect to http://domain:port', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: null,
        application: null,
        portBindings: [
          {
            id: 'b1',
            port: 12000,
            application: {
              id: 'a1',
              name: 'Grafana',
              containerName: 'dockcontrol-grafana-abc123def456',
              containerPort: 3000,
              port: 12000,
              project: { server: { host: 'localhost' } },
            },
          },
        ],
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('redir http://athexis.xyz:12000{uri} 308');
  });

  it('system_domain set → Caddy serves the dashboard + proxies /api/* on that host', async () => {
    const { service, prisma } = makeService([]);
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'system_domain', value: 'panel.acme.com' });
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('panel.acme.com {');
    expect(caddyfile).toContain('reverse_proxy dockcontrol-api:4000');
    expect(caddyfile).toContain('reverse_proxy dockcontrol-dashboard:3000');
  });

  it('a Domain row colliding with system_domain is SKIPPED (one site block per host or Caddy refuses the whole config)', async () => {
    const { service, prisma } = makeService([
      domainRow({
        domain: 'panel.acme.com',
        applicationId: 'a1',
        application: {
          id: 'a1',
          name: 'Grafana',
          port: 3001,
          customPort: false,
          containerName: 'dockcontrol-grafana-abc123def456',
          containerPort: 3000,
        },
      }),
    ]);
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'system_domain', value: 'panel.acme.com' });
    const { caddyfile } = await service.regenerate();
    // Exactly ONE site block for the host — the platform one.
    expect(caddyfile.match(/^panel\.acme\.com \{/gm)?.length).toBe(1);
    expect(caddyfile).toContain('reverse_proxy dockcontrol-dashboard:3000');
    expect(caddyfile).not.toContain('dockcontrol-grafana-abc123def456');
  });

  it('system_domain with an unsafe value is ignored (no Caddy block)', async () => {
    const { service, prisma } = makeService([]);
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'system_domain', value: 'evil{injection}.com' });
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).not.toContain('evil{injection}.com');
    expect(caddyfile).not.toContain('dockcontrol-dashboard:3000');
  });

  it('plain HTTP app (grafana) keeps an http upstream without TLS transport', async () => {
    const { service } = makeService([
      domainRow({
        applicationId: 'a1',
        application: {
          id: 'a1',
          name: 'Grafana',
          port: 3001,
          customPort: false,
          containerName: 'dockcontrol-grafana-abc123def456',
          containerPort: 3000,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy dockcontrol-grafana-abc123def456:3000');
    expect(caddyfile).not.toContain('tls_insecure_skip_verify');
  });
});

describe('regenerate — domain port bindings', () => {
  it('port-bound app without a main app → 308 redirect to http://<host>:<port> (not https)', async () => {
    const { service } = makeService([
      domainRow({
        portBindings: [
          {
            id: 'b1',
            port: 8443,
            applicationId: 'a2',
            application: { id: 'a2', name: 'Ghost', containerName: null, containerPort: null },
          },
        ],
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('redir http://athexis.xyz:8443{uri} 308');
    expect(caddyfile).not.toContain('redir https://athexis.xyz:8443');
    // The binding is documented as a direct container publish.
    expect(caddyfile).toContain('# http://athexis.xyz:8443 → app Ghost');
  });

  it('port-bound domain counts as ACTIVE, bare domain stays PENDING', async () => {
    const { service, prisma } = makeService([
      domainRow({
        id: 'd-bound',
        domain: 'bound.example.com',
        portBindings: [
          {
            id: 'b1',
            port: 9000,
            applicationId: 'a2',
            application: { id: 'a2', name: 'MinIO', containerName: null, containerPort: null },
          },
        ],
      }),
      domainRow({ id: 'd-bare', domain: 'bare.example.com' }),
    ]);
    await service.regenerate();
    expect(prisma.domain.update).toHaveBeenCalledWith({
      where: { id: 'd-bound' },
      data: { status: 'ACTIVE' },
    });
    expect(prisma.domain.update).toHaveBeenCalledWith({
      where: { id: 'd-bare' },
      data: { status: 'PENDING' },
    });
  });
});

describe('regenerate — safety rails', () => {
  it('skips unsafe domains that would break the Caddyfile', async () => {
    const { service } = makeService([
      domainRow({ id: 'd-evil', domain: 'evil{caddy}.example.com' }),
      domainRow({ id: 'd-ok', domain: 'good.example.com' }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).not.toContain('evil');
    expect(caddyfile).toContain('good.example.com');
  });

  it('reloads caddy via docker exec after writing the Caddyfile', async () => {
    const { service } = makeService([domainRow()]);
    await service.regenerate();
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('Caddyfile'),
      expect.stringContaining('athexis.xyz'),
    );
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'docker',
      ['exec', 'dockcontrol-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
      expect.anything(),
    );
  });

  it('writes the Caddyfile IN PLACE (single-file bind mount — never tmp+rename)', async () => {
    const { service } = makeService([domainRow()]);
    await service.regenerate();
    // The rendered config is written directly to the real Caddyfile path so
    // the single-file bind mount (bound by inode) sees it. A tmp+rename would
    // swap the inode and leave the Caddy container reading the old seed file.
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/Caddyfile$/),
      expect.stringContaining('athexis.xyz'),
    );
    // Must NOT rename a .tmp over the Caddyfile (that breaks the bind mount).
    expect(renameSyncMock).not.toHaveBeenCalled();
    // And must NOT write a .tmp sibling at all for the Caddyfile.
    expect(writeFileSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Caddyfile.tmp'),
      expect.anything(),
    );
  });
});

describe('regenerate — upstream host injection (remote Server.host)', () => {
  function remoteAppDomain(host: string): any {
    return domainRow({
      applicationId: 'a1',
      application: {
        id: 'a1',
        name: 'WordPress',
        port: 8080,
        customPort: false,
        containerName: 'dockcontrol-wordpress-abc123def456',
        containerPort: 80,
        project: { server: { host } },
      },
    });
  }

  it('a bare IPv4 remote host is rendered as a normal upstream', async () => {
    const { service } = makeService([remoteAppDomain('203.0.113.7')]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy 203.0.113.7:8080');
  });

  it('a valid hostname remote host is rendered as a normal upstream', async () => {
    const { service } = makeService([remoteAppDomain('node1.example.com')]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy node1.example.com:8080');
  });

  it('a Server.host carrying a Caddy directive injection is SKIPPED (fail closed)', async () => {
    const { service } = makeService([
      remoteAppDomain('evil.com}\n:80 {\n  respond "pwned" 200\n}\n#'),
    ]);
    const { caddyfile } = await service.regenerate();
    // No reverse_proxy to the poisoned host, no injected respond block.
    expect(caddyfile).not.toContain('reverse_proxy evil.com');
    expect(caddyfile).not.toContain('respond "pwned"');
    // Fail-closed fallback keeps the site block valid.
    expect(caddyfile).toContain('respond "Upstream unavailable." 502');
  });

  it('a Server.host with whitespace/extra directive tokens is SKIPPED', async () => {
    const { service } = makeService([remoteAppDomain('1.2.3.4 { tls internal }')]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).not.toContain('reverse_proxy 1.2.3.4 {');
    expect(caddyfile).toContain('respond "Upstream unavailable." 502');
  });
});
