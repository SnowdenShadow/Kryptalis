import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

/**
 * AdminService owns the privilege-escalation ceiling, the self-modification
 * guards, and the "never delete the last SUPERADMIN" invariant — a regression
 * here is privilege escalation or platform lockout. These tests exercise the
 * write paths directly (Prisma mocked).
 */
function makeService() {
  const prisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: 't1' }),
      delete: vi.fn().mockResolvedValue({ id: 't1' }),
      count: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'new' }),
    },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const service = new AdminService(
    prisma as any,
    {} as any, // systemConfig
    {} as any, // notifications
    {} as any, // proxy
  );
  return { service, prisma };
}

const SUPERADMIN = { id: 'sa', role: 'SUPERADMIN' as const };
const ADMIN = { id: 'ad', role: 'ADMIN' as const };

beforeEach(() => vi.clearAllMocks());

describe('AdminService — role-grant ceiling (updateUserRole)', () => {
  it('an ADMIN cannot grant ADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    await expect(service.updateUserRole(ADMIN, 'u2', 'ADMIN' as any)).rejects.toThrow(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('an ADMIN cannot grant SUPERADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    await expect(service.updateUserRole(ADMIN, 'u2', 'SUPERADMIN' as any)).rejects.toThrow(ForbiddenException);
  });

  it('an ADMIN cannot modify another ADMIN (even to demote them)', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(service.updateUserRole(ADMIN, 'u2', 'USER' as any)).rejects.toThrow(ForbiddenException);
  });

  it('an ADMIN CAN grant USER/VIEWER to a regular user', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    await expect(service.updateUserRole(ADMIN, 'u2', 'VIEWER' as any)).resolves.toBeDefined();
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('a SUPERADMIN can grant anything', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(service.updateUserRole(SUPERADMIN, 'u2', 'SUPERADMIN' as any)).resolves.toBeDefined();
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('nobody can change their OWN role', async () => {
    const { service, prisma } = makeService();
    await expect(service.updateUserRole(SUPERADMIN, SUPERADMIN.id, 'USER' as any)).rejects.toThrow(
      /your own role/i,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('404s on an unknown target', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.updateUserRole(SUPERADMIN, 'ghost', 'USER' as any)).rejects.toThrow(NotFoundException);
  });
});

describe('AdminService — self-modification guards', () => {
  it('cannot suspend/ban yourself', async () => {
    const { service } = makeService();
    await expect(service.updateUserStatus(ADMIN, ADMIN.id, 'BANNED' as any)).rejects.toThrow(
      /yourself/i,
    );
  });

  it('an ADMIN cannot ban another ADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(service.updateUserStatus(ADMIN, 'u2', 'BANNED' as any)).rejects.toThrow(ForbiddenException);
  });

  it('cannot delete your own account here', async () => {
    const { service } = makeService();
    await expect(service.deleteUser(ADMIN, ADMIN.id)).rejects.toThrow(/your own account/i);
  });
});

describe('AdminService — last-SUPERADMIN protection (deleteUser)', () => {
  it('refuses to delete the LAST superadmin', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    prisma.user.count.mockResolvedValue(1);
    await expect(service.deleteUser(SUPERADMIN, 'other-sa')).rejects.toThrow(/last SUPERADMIN/i);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('allows deleting a superadmin when others remain', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    prisma.user.count.mockResolvedValue(2);
    await expect(service.deleteUser(SUPERADMIN, 'other-sa')).resolves.toBeDefined();
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'other-sa' } });
  });

  it('an ADMIN cannot delete an ADMIN/SUPERADMIN target', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(service.deleteUser(ADMIN, 'u2')).rejects.toThrow(ForbiddenException);
  });
});

describe('AdminService — last-SUPERADMIN protection on demote/ban (platform lockout)', () => {
  it('refuses to DEMOTE the last superadmin away from SUPERADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    prisma.user.count.mockResolvedValue(1);
    await expect(service.updateUserRole(SUPERADMIN, 'other-sa', 'USER' as any)).rejects.toThrow(
      /last SUPERADMIN/i,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('allows demoting a superadmin when others remain', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    prisma.user.count.mockResolvedValue(2);
    await expect(service.updateUserRole(SUPERADMIN, 'other-sa', 'ADMIN' as any)).resolves.toBeDefined();
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('refuses to BAN/suspend the last superadmin', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    prisma.user.count.mockResolvedValue(1);
    await expect(service.updateUserStatus(SUPERADMIN, 'other-sa', 'BANNED' as any)).rejects.toThrow(
      /last SUPERADMIN/i,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('keeping a superadmin ACTIVE (no lockout risk) does not trigger the count check', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ role: 'SUPERADMIN' });
    await expect(service.updateUserStatus(SUPERADMIN, 'other-sa', 'ACTIVE' as any)).resolves.toBeDefined();
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});

describe('AdminService — createUser grant ceiling', () => {
  it('an ADMIN cannot create a SUPERADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null); // email free
    await expect(
      service.createUser(ADMIN, { name: 'X', email: 'x@y.z', password: 'pw', role: 'SUPERADMIN' as any }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
