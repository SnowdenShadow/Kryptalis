import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';

// RBAC is a module-level fn — mock so access checks pass.
vi.mock('../../common/rbac/project-access', () => ({
  assertProjectAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../common/rbac/project-permissions', () => ({
  assertPermission: vi.fn(),
}));

import { SftpService } from './sftp.service';

function makePrisma() {
  return {
    sftpAccount: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    application: { findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
  } as any;
}

function makeService(prisma: any) {
  const encryption = { encrypt: vi.fn(), decrypt: vi.fn() };
  const agent = { enqueueAndWait: vi.fn(), enqueueTask: vi.fn() };
  const svc = new SftpService(prisma as any, encryption as any, agent as any);
  return { svc, prisma };
}

beforeEach(() => vi.clearAllMocks());

describe('SftpService.deprovisionForApplication', () => {
  it('removes each local account from the container AND deletes its row', async () => {
    const { svc, prisma } = makeService(makePrisma());
    prisma.sftpAccount.findMany.mockResolvedValue([
      { id: 'a1', username: 'site_user1' },
      { id: 'a2', username: 'site_user2' },
    ]);
    // Local app (no remote server) + stub the container removal.
    const resolveRemote = vi.spyOn(svc as any, 'resolveRemoteSftpServer').mockResolvedValue(null);
    const removeFromContainer = vi.spyOn(svc as any, 'removeAccountFromContainer').mockResolvedValue(undefined);

    await svc.deprovisionForApplication('app1');

    expect(resolveRemote).toHaveBeenCalledWith('app', 'app1');
    expect(removeFromContainer).toHaveBeenCalledWith('site_user1');
    expect(removeFromContainer).toHaveBeenCalledWith('site_user2');
    expect(prisma.sftpAccount.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
    expect(prisma.sftpAccount.delete).toHaveBeenCalledWith({ where: { id: 'a2' } });
  });

  it('no accounts → no-op (no container calls)', async () => {
    const { svc } = makeService(makePrisma());
    const removeFromContainer = vi.spyOn(svc as any, 'removeAccountFromContainer').mockResolvedValue(undefined);
    await svc.deprovisionForApplication('app1');
    expect(removeFromContainer).not.toHaveBeenCalled();
  });

  it('remote app → syncs the agent after deleting rows (no local container removal)', async () => {
    const { svc, prisma } = makeService(makePrisma());
    prisma.sftpAccount.findMany.mockResolvedValue([{ id: 'a1', username: 'remote_user' }]);
    vi.spyOn(svc as any, 'resolveRemoteSftpServer').mockResolvedValue({ id: 'srvR', host: '203.0.113.5' });
    const removeFromContainer = vi.spyOn(svc as any, 'removeAccountFromContainer').mockResolvedValue(undefined);
    const sync = vi.spyOn(svc as any, 'syncRemoteSftpAccounts').mockResolvedValue(undefined);

    await svc.deprovisionForApplication('app1');

    expect(removeFromContainer).not.toHaveBeenCalled(); // remote: not a local docker exec
    expect(prisma.sftpAccount.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
    expect(sync).toHaveBeenCalledWith('srvR');
  });

  it('never throws — a container-removal failure does not block app deletion', async () => {
    const { svc, prisma } = makeService(makePrisma());
    prisma.sftpAccount.findMany.mockResolvedValue([{ id: 'a1', username: 'u1' }]);
    vi.spyOn(svc as any, 'resolveRemoteSftpServer').mockResolvedValue(null);
    vi.spyOn(svc as any, 'removeAccountFromContainer').mockRejectedValue(new Error('docker down'));
    await expect(svc.deprovisionForApplication('app1')).resolves.toBeUndefined();
  });
});

describe('SftpService — PHP_SITE pre-deploy guard (resolveChrootBinds)', () => {
  it('refuses an SFTP account on a PHP site that was never deployed (no containerName)', async () => {
    const { svc, prisma } = makeService(makePrisma());
    prisma.application.findUnique.mockResolvedValue({
      id: 'app1', name: 'Teste', dockerImage: null, containerName: null, framework: 'PHP_SITE',
    });
    await expect((svc as any).resolveChrootBinds('app', 'app1')).rejects.toThrow(/Deploy this PHP site/i);
  });

  it('allows it once the PHP site has been deployed (containerName set)', async () => {
    const { svc, prisma } = makeService(makePrisma());
    prisma.application.findUnique.mockResolvedValue({
      id: 'app1', name: 'Teste', dockerImage: null, containerName: 'dockcontrol-teste', framework: 'PHP_SITE',
    });
    const binds = await (svc as any).resolveChrootBinds('app', 'app1');
    expect(binds).toHaveLength(1);
    expect(binds[0].dir).toBe('app');
    // PHP_SITE drops the user into the public/ docroot.
    expect(binds[0].source).toMatch(/\/public$/);
  });

  it('does not gate a non-PHP app with no containerName (git apps land on host-fs)', async () => {
    const { svc, prisma } = makeService(makePrisma());
    prisma.application.findUnique.mockResolvedValue({
      id: 'app1', name: 'web', dockerImage: null, containerName: null, framework: 'NEXTJS',
    });
    const binds = await (svc as any).resolveChrootBinds('app', 'app1');
    expect(binds).toHaveLength(1);
    expect(binds[0].source).not.toMatch(/\/public$/);
  });
});
