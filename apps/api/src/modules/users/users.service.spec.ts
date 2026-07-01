import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { UsersService } from './users.service';

/**
 * Pure service-level tests: plain vi.fn() prisma, no DB. Focus is the
 * role-hierarchy guard (ADMIN can't touch ADMIN/SUPERADMIN) and the
 * notificationPrefs whitelist sanitiser.
 */
function makePrisma() {
  return {
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: 'u1' }),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeService() {
  const prisma = makePrisma();
  const service = new UsersService(prisma as any);
  return { service, prisma };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findOne / update / remove', () => {
  it('findOne 404s on missing user', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.findOne('uX')).rejects.toThrow(NotFoundException);
  });

  it('update 404s (via findOne) before writing when the user is gone', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.update('uX', { name: 'x' } as any)).rejects.toThrow(NotFoundException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('remove 404s when the user is gone, else deletes', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.remove('uX')).rejects.toThrow(NotFoundException);

    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    const res = await service.remove('u1');
    expect(res).toEqual({ message: 'User deleted' });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });
});

describe('updateAsAdmin — role hierarchy', () => {
  it('a self-edit skips the hierarchy check entirely', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'ADMIN' });
    await service.updateAsAdmin('u1', 'u1', { name: 'Me' } as any);
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('SUPERADMIN can modify anyone', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'super' ? { role: 'SUPERADMIN' } : { role: 'ADMIN', id: 'target' },
    );
    await service.updateAsAdmin('super', 'target', { name: 'x' } as any);
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('ADMIN CANNOT modify another ADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'actor' ? { role: 'ADMIN' } : { role: 'ADMIN' },
    );
    await expect(service.updateAsAdmin('actor', 'target', { name: 'x' } as any)).rejects.toThrow(
      /Only SUPERADMIN/,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('ADMIN CANNOT modify a SUPERADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'actor' ? { role: 'ADMIN' } : { role: 'SUPERADMIN' },
    );
    await expect(service.updateAsAdmin('actor', 'target', {} as any)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('ADMIN CAN modify a regular USER', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'actor' ? { role: 'ADMIN' } : { role: 'USER', id: 'target' },
    );
    await service.updateAsAdmin('actor', 'target', { name: 'x' } as any);
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('a plain USER cannot modify anyone else', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'actor' ? { role: 'USER' } : { role: 'USER' },
    );
    await expect(service.updateAsAdmin('actor', 'target', {} as any)).rejects.toThrow(
      /do not have permission/,
    );
  });

  it('404s when the actor row is missing', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'actor' ? null : { role: 'USER' },
    );
    await expect(service.updateAsAdmin('actor', 'target', {} as any)).rejects.toThrow(
      /Actor user not found/,
    );
  });
});

describe('removeAsAdmin', () => {
  it('applies the same hierarchy guard, then deletes', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'actor' ? { role: 'ADMIN' } : { role: 'USER', id: 'target' },
    );
    const res = await service.removeAsAdmin('actor', 'target');
    expect(res).toEqual({ message: 'User deleted' });
  });

  it('refuses an ADMIN deleting another ADMIN', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'actor' ? { role: 'ADMIN' } : { role: 'ADMIN' },
    );
    await expect(service.removeAsAdmin('actor', 'target')).rejects.toThrow(ForbiddenException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});

describe('notification preferences', () => {
  it('getNotificationPrefs 404s on missing user and defaults to {}', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.getNotificationPrefs('uX')).rejects.toThrow(NotFoundException);

    prisma.user.findUnique.mockResolvedValue({ notificationPrefs: null });
    expect(await service.getNotificationPrefs('u1')).toEqual({ prefs: {} });
  });

  it('sanitises to the event/channel whitelist and drops unknown keys + non-booleans', async () => {
    const { service, prisma } = makeService();
    prisma.user.update.mockImplementation(async ({ data }: any) => ({
      notificationPrefs: data.notificationPrefs,
    }));

    const res = await service.updateNotificationPrefs('u1', {
      deployOk: { email: true, discord: true as any }, // discord not whitelisted → dropped
      bogusEvent: { email: true }, // unknown event → dropped
      deployFail: { email: 'yes' as any }, // non-boolean → dropped, empty row omitted
      serverOff: { email: false },
    } as any);

    expect(res.prefs).toEqual({
      deployOk: { email: true },
      serverOff: { email: false },
    });
    // The persisted payload equals the sanitised object (no bogus keys reach the DB).
    expect(prisma.user.update.mock.calls[0][0].data.notificationPrefs).toEqual({
      deployOk: { email: true },
      serverOff: { email: false },
    });
  });
});
