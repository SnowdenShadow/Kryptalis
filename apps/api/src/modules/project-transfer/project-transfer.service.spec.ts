import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// RBAC is a module-level fn — mock it so OWNER checks pass in the test.
vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn().mockResolvedValue(undefined),
}));

import { ProjectTransferService } from './project-transfer.service';

/**
 * End-to-end-ish service tests WITHOUT Docker: config-only export (includeData
 * false) tars + encrypts a real archive on disk, then parse decrypts + validates
 * it. Exercises the crypto envelope, manifest serialisation, passphrase gating,
 * tamper/wrong-passphrase rejection, and conflict detection — all the logic that
 * doesn't need a container runtime.
 */

const PASS = 'transfer-passphrase-123';

function makePrisma() {
  return {
    project: { findUnique: vi.fn(), findFirst: vi.fn() },
    domain: { findUnique: vi.fn() },
  } as any;
}

function makeEnv() {
  return {
    // Pretend the app has one secret env var; export re-encrypts it.
    decryptEnvVars: vi.fn().mockReturnValue({ SECRET: 'shh', PUBLIC_URL: 'https://x' }),
  } as any;
}

function makeService(prisma: any) {
  return new ProjectTransferService(
    prisma,
    {} as any, // applications
    makeEnv(),
    {} as any, // databases
    {} as any, // projects
    {} as any, // domains
  );
}

const created: string[] = [];
afterEach(() => {
  for (const f of created.splice(0)) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ } }
  vi.clearAllMocks();
});

const sampleProject = {
  id: 'p1',
  name: 'My App',
  description: 'desc',
  applications: [
    { id: 'app1aaaaaaaaaaaa', name: 'web', displayName: null, framework: 'DOCKER', gitUrl: 'https://github.com/me/web.git', gitBranch: 'main', dockerImage: null, dockerComposeFile: null, buildCommand: null, startCommand: null, port: 3000, hostPort: null, containerPort: null, customPort: false, envVars: { __k: 1, v: 'ignored-by-mock' } },
  ],
  databases: [
    { id: 'db1', name: 'maindb', type: 'POSTGRES', username: 'u', password: 'p@ss', port: 5432, autoImported: false },
  ],
  domains: [
    { id: 'dom1', domain: 'app.example.com', applicationId: 'app1aaaaaaaaaaaa' },
  ],
};

describe('ProjectTransferService — export', () => {
  let prisma: any;
  let svc: ProjectTransferService;
  beforeEach(() => { prisma = makePrisma(); svc = makeService(prisma); });

  it('rejects a passphrase shorter than 12 chars', async () => {
    await expect(svc.exportProject('u1', 'p1', { includeData: false, passphrase: 'short' }))
      .rejects.toThrow(/at least 12/i);
  });

  it('exports a config-only archive that parse can decrypt + read back', async () => {
    prisma.project.findUnique.mockResolvedValue(sampleProject);
    const { archivePath, filename } = await svc.exportProject('u1', 'p1', { includeData: false, passphrase: PASS });
    created.push(archivePath);
    expect(filename).toBe('my-app.dctproj');
    expect(fs.existsSync(archivePath)).toBe(true);

    // Now parse it back (fresh prisma: no conflicts).
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);
    const result = await svc.parseImport('u2', archivePath, PASS);
    created.push((svc as any).stagingDir(result.stagedId));

    expect(result.manifest.version).toBe(1);
    expect(result.manifest.project.name).toBe('My App');
    expect(result.manifest.includesData).toBe(false);
    expect(result.manifest.applications).toHaveLength(1);
    expect(result.manifest.applications[0].name).toBe('web');
    expect(result.manifest.applications[0].gitUrl).toBe('https://github.com/me/web.git');
    // Secrets are present but ENCRYPTED (base64 envelope), never plaintext.
    expect(result.manifest.applications[0].envEncrypted).toBeTruthy();
    expect(result.manifest.applications[0].envEncrypted).not.toContain('shh');
    expect(result.manifest.databases[0].passwordEncrypted).not.toContain('p@ss');
    expect(result.manifest.domains[0].domain).toBe('app.example.com');
    expect(result.warnings.some((w) => /configuration only/i.test(w))).toBe(true);
  });
});

describe('ProjectTransferService — parse / import safety', () => {
  let prisma: any;
  let svc: ProjectTransferService;
  beforeEach(() => { prisma = makePrisma(); svc = makeService(prisma); });

  async function exportArchive(passphrase = PASS) {
    prisma.project.findUnique.mockResolvedValue(sampleProject);
    const { archivePath } = await svc.exportProject('u1', 'p1', { includeData: false, passphrase });
    created.push(archivePath);
    return archivePath;
  }

  it('rejects the WRONG passphrase at parse (fail-closed decrypt)', async () => {
    const archive = await exportArchive();
    await expect(svc.parseImport('u2', archive, 'totally-wrong-pass')).rejects.toThrow(/wrong passphrase or corrupted/i);
  });

  it('rejects a TAMPERED archive', async () => {
    const archive = await exportArchive();
    const buf = fs.readFileSync(archive);
    buf[buf.length - 20] = buf[buf.length - 20] ^ 0xff; // corrupt near the tag/body
    fs.writeFileSync(archive, buf);
    await expect(svc.parseImport('u2', archive, PASS)).rejects.toThrow(/wrong passphrase or corrupted/i);
  });

  it('detects a domain conflict against the importing install', async () => {
    const archive = await exportArchive();
    prisma.domain.findUnique.mockResolvedValue({ id: 'existing', domain: 'app.example.com' });
    prisma.project.findFirst.mockResolvedValue({ id: 'existing-proj' });
    const result = await svc.parseImport('u2', archive, PASS);
    created.push((svc as any).stagingDir(result.stagedId));
    expect(result.conflicts.domains).toContain('app.example.com');
    expect(result.conflicts.projectNameTaken).toBe(true);
  });

  it('rejects a parse with a short passphrase before reading the file', async () => {
    await expect(svc.parseImport('u2', '/nonexistent', 'short')).rejects.toThrow(/at least 12/i);
  });

  it('binds the staged session to the uploading user — another user cannot apply it', async () => {
    const archive = await exportArchive();
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);
    const result = await svc.parseImport('alice', archive, PASS);
    created.push((svc as any).stagingDir(result.stagedId));
    // Bob guesses/obtains the stagedId and tries to apply Alice's import.
    await expect(
      svc.applyImport('bob', result.stagedId, { passphrase: PASS }),
    ).rejects.toThrow(/expired or not found/i);
  });

  it('uses an unguessable CSPRNG staged id (hex, not timestamp+Math.random)', async () => {
    const archive = await exportArchive();
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);
    const result = await svc.parseImport('alice', archive, PASS);
    created.push((svc as any).stagingDir(result.stagedId));
    expect(result.stagedId).toMatch(/^xfer_[a-f0-9]{36}$/);
  });

  it('flags a host-bind-mount app requiresHostAccess and warns (does NOT fail the whole import)', async () => {
    // An app whose compose mounts the host (e.g. docker.sock / "/:/host") is a
    // legitimate-but-non-portable app, not an attack. parse must NOT reject the
    // archive — it flags the app so apply skips it with a warning, while the
    // rest of the project still imports.
    const hostApp = {
      ...sampleProject,
      applications: [{
        ...sampleProject.applications[0],
        name: 'portainer',
        gitUrl: null,
        framework: 'DOCKER_COMPOSE',
        dockerComposeFile: 'services:\n  web:\n    image: portainer/portainer-ce\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n',
      }],
      databases: [],
      domains: [],
    };
    prisma.project.findUnique.mockResolvedValue(hostApp);
    const { archivePath } = await svc.exportProject('u1', 'p1', { includeData: false, passphrase: PASS });
    created.push(archivePath);
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);
    // parse SUCCEEDS (no throw) and the app is flagged + warned about.
    const result = await svc.parseImport('u2', archivePath, PASS);
    created.push((svc as any).stagingDir(result.stagedId));
    expect(result.manifest.applications[0].requiresHostAccess).toBe(true);
    expect(result.warnings.some((w) => /host access|docker socket/i.test(w))).toBe(true);
  });

  it('imports a host-access app ONLY with explicit consent (allowHostAccess)', async () => {
    const hostApp = {
      ...sampleProject,
      applications: [{
        ...sampleProject.applications[0],
        name: 'portainer',
        gitUrl: null,
        framework: 'DOCKER_COMPOSE',
        dockerComposeFile: 'services:\n  web:\n    image: portainer/portainer-ce\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n',
      }],
      databases: [],
      domains: [],
    };
    prisma.project.findUnique.mockResolvedValue(hostApp);
    const { archivePath } = await svc.exportProject('u1', 'p1', { includeData: false, passphrase: PASS });
    created.push(archivePath);
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);

    // Wire the create paths the apply step calls.
    const appsCreate = vi.fn().mockResolvedValue({ id: 'newapp1' });
    const projCreate = vi.fn().mockResolvedValue({ id: 'newproj1' });
    (svc as any).applications = { create: appsCreate };
    (svc as any).projects = { create: projCreate };
    (svc as any).databases = { create: vi.fn() };
    (svc as any).domains = { create: vi.fn() };

    // Without consent → app is skipped, applications.create NOT called.
    const parsed1 = await svc.parseImport('u2', archivePath, PASS);
    const r1 = await svc.applyImport('u2', parsed1.stagedId, { passphrase: PASS });
    expect(appsCreate).not.toHaveBeenCalled();
    expect(r1.warnings.some((w) => /SKIPPED/i.test(w))).toBe(true);

    // With consent → app IS created (host-access carried through).
    const parsed2 = await svc.parseImport('u2', archivePath, PASS);
    await svc.applyImport('u2', parsed2.stagedId, { passphrase: PASS, allowHostAccess: true });
    expect(appsCreate).toHaveBeenCalledTimes(1);
    expect(appsCreate.mock.calls[0][1].composeContent).toContain('docker.sock');
  });

  it('wires a chosen git provider for a git app (and clones anonymously without one)', async () => {
    // sampleProject's "web" app is a git app (gitUrl set).
    prisma.project.findUnique.mockResolvedValue(sampleProject);
    const { archivePath } = await svc.exportProject('u1', 'p1', { includeData: false, passphrase: PASS });
    created.push(archivePath);
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);

    const appsCreate = vi.fn().mockResolvedValue({ id: 'a1' });
    (svc as any).applications = { create: appsCreate };
    (svc as any).projects = { create: vi.fn().mockResolvedValue({ id: 'proj1' }) };
    (svc as any).databases = { create: vi.fn().mockResolvedValue({ id: 'd1' }) };
    (svc as any).domains = { create: vi.fn() };

    // WITH a provider chosen for "web" → dto.gitProviderId is set.
    const p1 = await svc.parseImport('u2', archivePath, PASS);
    await svc.applyImport('u2', p1.stagedId, { passphrase: PASS, gitProviderMap: { web: 'prov-123' } });
    const gitCall = appsCreate.mock.calls.find((c) => c[1].gitUrl);
    expect(gitCall).toBeDefined();
    expect(gitCall![1].gitProviderId).toBe('prov-123');

    // WITHOUT a provider → no gitProviderId (anonymous public clone).
    appsCreate.mockClear();
    const p2 = await svc.parseImport('u2', archivePath, PASS);
    await svc.applyImport('u2', p2.stagedId, { passphrase: PASS });
    const gitCall2 = appsCreate.mock.calls.find((c) => c[1].gitUrl);
    expect(gitCall2).toBeDefined();
    expect(gitCall2![1].gitProviderId).toBeUndefined();
  });

  it('carries a safe compose app (named volume, no host mount) as portable', async () => {
    const safeApp = {
      ...sampleProject,
      applications: [{
        ...sampleProject.applications[0],
        name: 'ghost',
        gitUrl: null,
        framework: 'DOCKER_COMPOSE',
        dockerComposeFile: 'services:\n  web:\n    image: ghost:5\n    volumes:\n      - content:/var/lib/ghost/content\n',
      }],
      databases: [],
      domains: [],
    };
    prisma.project.findUnique.mockResolvedValue(safeApp);
    const { archivePath } = await svc.exportProject('u1', 'p1', { includeData: false, passphrase: PASS });
    created.push(archivePath);
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);
    const result = await svc.parseImport('u2', archivePath, PASS);
    created.push((svc as any).stagingDir(result.stagedId));
    expect(result.manifest.applications[0].requiresHostAccess).toBeFalsy();
    expect(result.manifest.applications[0].dockerComposeFile).toContain('ghost:5');
  });
});

/**
 * Data round-trip (PrestaShop-style): export marks a bundled DB dataInVolume +
 * carries the app's volume tar with a remappable key; import skips the bundled
 * DB's standalone create, threads the volume seed into the app deploy, and
 * replays a STANDALONE DB dump. Docker-touching internals are stubbed so the
 * test stays runtime-free.
 */
describe('ProjectTransferService — data restore (includeData)', () => {
  let prisma: any;
  let svc: ProjectTransferService;
  beforeEach(() => { prisma = makePrisma(); svc = makeService(prisma); });

  // A compose app with a bundled MariaDB sidecar (PrestaShop shape) + a
  // separate standalone Postgres in the same project.
  const prestaProject = {
    id: 'p1', name: 'Shop', description: null,
    applications: [{
      id: 'presta00aaaa', name: 'prestashop', displayName: null, framework: 'DOCKER_COMPOSE',
      gitUrl: null, gitBranch: null, dockerImage: null,
      dockerComposeFile: 'services:\n  prestashop:\n    image: prestashop/prestashop\n    volumes:\n      - data:/var/www/html\n',
      buildCommand: null, startCommand: null, port: 8090, hostPort: 8090, containerPort: 80,
      customPort: false, envVars: null,
    }],
    databases: [
      { id: 'bundled1', name: 'prestashop', type: 'MARIADB', username: 'ps', password: 'x', port: 3306, autoImported: true, host: 'dockcontrol-prestashop-db-presta00aaaa' },
      { id: 'standalone1', name: 'analytics', type: 'POSTGRESQL', username: 'a', password: 'y', port: 5432, autoImported: false, host: '' },
    ],
    domains: [],
  };

  function stubExportDocker(volKeys: string[]) {
    // exportLocalAppVolumes lists volumes then tars each. Stub both so no
    // docker runs; produce real (empty) tar files on disk so the archive packs.
    vi.spyOn(svc as any, 'dumpLocalDatabase').mockImplementation(async (db: any, dir: string) => {
      const rel = `databases/${db.name}.sql.gz`;
      fs.writeFileSync(`${dir}/${rel}`, 'SQLDUMP'); // dir/databases exists (mkdir at export start)
      return rel;
    });
    vi.spyOn(svc as any, 'exportLocalAppVolumes').mockImplementation(async (app: any, dir: string, entry: any) => {
      entry.volumes = entry.volumes || [];
      for (const key of volKeys) {
        const rel = `volumes/prestashop-presta00aaaa_${key}.tar.gz`;
        fs.writeFileSync(`${dir}/volumes/prestashop-presta00aaaa_${key}.tar.gz`, 'TAR');
        entry.volumeFiles.push(rel);
        entry.volumes.push({ file: rel, key });
      }
    });
  }

  it('export: bundled DB → dataInVolume (no SQL dump); standalone DB → dumpFile; app carries volume keys', async () => {
    prisma.project.findUnique.mockResolvedValue(prestaProject);
    stubExportDocker(['data']);
    const { archivePath } = await svc.exportProject('u1', 'p1', { includeData: true, passphrase: PASS });
    created.push(archivePath);
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);
    const { manifest, stagedId } = await svc.parseImport('u2', archivePath, PASS);
    created.push((svc as any).stagingDir(stagedId));

    const bundled = manifest.databases.find((d) => d.name === 'prestashop')!;
    const standalone = manifest.databases.find((d) => d.name === 'analytics')!;
    expect(bundled.dataInVolume).toBe(true);
    expect(bundled.dumpFile).toBeUndefined();
    expect(standalone.dataInVolume).toBeFalsy();
    expect(standalone.dumpFile).toBe('databases/analytics.sql.gz');
    expect(manifest.applications[0].volumes).toEqual([
      { file: 'volumes/prestashop-presta00aaaa_data.tar.gz', key: 'data' },
    ]);
  });

  it('import: skips the bundled DB create, threads volume seed into the app deploy, replays the standalone dump', async () => {
    prisma.project.findUnique.mockResolvedValue(prestaProject);
    stubExportDocker(['data']);
    const { archivePath } = await svc.exportProject('u1', 'p1', { includeData: true, passphrase: PASS });
    created.push(archivePath);
    prisma.domain.findUnique.mockResolvedValue(null);
    prisma.project.findFirst.mockResolvedValue(null);

    const appsCreate = vi.fn().mockResolvedValue({ id: 'newapp' });
    const dbCreate = vi.fn().mockResolvedValue({ id: 'newdb' });
    const restoreDbDump = vi.fn().mockResolvedValue(undefined);
    (svc as any).applications = { create: appsCreate };
    (svc as any).projects = { create: vi.fn().mockResolvedValue({ id: 'np' }) };
    (svc as any).databases = { create: dbCreate, restoreDbDump };
    (svc as any).domains = { create: vi.fn() };

    const parsed = await svc.parseImport('u2', archivePath, PASS);
    created.push((svc as any).stagingDir(parsed.stagedId));
    created.push(`${(svc as any).stagingDir(parsed.stagedId)}-restore`);
    await svc.applyImport('u2', parsed.stagedId, { passphrase: PASS });

    // Bundled DB is NOT created standalone (only the analytics one is).
    expect(dbCreate).toHaveBeenCalledTimes(1);
    expect(dbCreate.mock.calls[0][1].name).toBe('analytics');

    // App deploy receives the volume seed with the remappable key + a parked
    // tar path (outside the staging dir, since staging is wiped in finally).
    const dto = appsCreate.mock.calls[0][1];
    expect(dto.restoreVolumes).toHaveLength(1);
    expect(dto.restoreVolumes[0].key).toBe('data');
    expect(dto.restoreVolumes[0].tarPath).toMatch(/-restore[\\/].*_data\.tar\.gz$/);

    // Standalone dump is replayed against the freshly-created DB id.
    expect(restoreDbDump).toHaveBeenCalledTimes(1);
    expect(restoreDbDump.mock.calls[0][0]).toBe('newdb');
  });
});
