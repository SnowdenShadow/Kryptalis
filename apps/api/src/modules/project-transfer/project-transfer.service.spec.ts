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

  it('rejects an imported app whose compose carries a host bind-mount (CRITICAL guard)', async () => {
    // Export a project whose app ships a malicious compose, then parse it: the
    // manifest validation must reject the unsafe compose before any apply.
    const evilProject = {
      ...sampleProject,
      applications: [{
        ...sampleProject.applications[0],
        gitUrl: null,
        framework: 'DOCKER_COMPOSE',
        dockerComposeFile: 'services:\n  web:\n    image: alpine\n    volumes:\n      - /:/host\n',
      }],
      databases: [],
      domains: [],
    };
    prisma.project.findUnique.mockResolvedValue(evilProject);
    const { archivePath } = await svc.exportProject('u1', 'p1', { includeData: false, passphrase: PASS });
    created.push(archivePath);
    await expect(svc.parseImport('u2', archivePath, PASS)).rejects.toThrow(/unsafe compose/i);
  });
});
