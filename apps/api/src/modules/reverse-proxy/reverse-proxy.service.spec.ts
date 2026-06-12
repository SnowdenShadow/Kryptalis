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

const { execFileAsyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
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
          containerName: 'kryptalis-portainer-abc123def456',
          containerPort: 9443,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy https://kryptalis-portainer-abc123def456:9443');
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
          containerName: 'kryptalis-portainer-fff000fff000',
          containerPort: 9443,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy https://kryptalis-portainer-fff000fff000:9443');
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
          containerName: 'kryptalis-custom-abc123def456',
          containerPort: 9443,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy https://kryptalis-custom-abc123def456:9443');
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
          containerName: 'kryptalis-portainer-abc123def456',
          containerPort: 9000,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy kryptalis-portainer-abc123def456:9000');
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
          containerName: 'kryptalis-wordpress-abc123def456',
          containerPort: 80,
          project: { server: { host: '203.0.113.7' } },
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy 203.0.113.7:8080');
    expect(caddyfile).not.toContain('kryptalis-wordpress-abc123def456:80');
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
              containerName: 'kryptalis-grafana-abc123def456',
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
              containerName: 'kryptalis-grafana-abc123def456',
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
    expect(caddyfile).toContain('reverse_proxy kryptalis-api:4000');
    expect(caddyfile).toContain('reverse_proxy kryptalis-dashboard:3000');
  });

  it('system_domain with an unsafe value is ignored (no Caddy block)', async () => {
    const { service, prisma } = makeService([]);
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'system_domain', value: 'evil{injection}.com' });
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).not.toContain('evil{injection}.com');
    expect(caddyfile).not.toContain('kryptalis-dashboard:3000');
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
          containerName: 'kryptalis-grafana-abc123def456',
          containerPort: 3000,
        },
      }),
    ]);
    const { caddyfile } = await service.regenerate();
    expect(caddyfile).toContain('reverse_proxy kryptalis-grafana-abc123def456:3000');
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
      ['exec', 'kryptalis-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
      expect.anything(),
    );
  });
});
