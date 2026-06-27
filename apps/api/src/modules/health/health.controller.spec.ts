import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

function makeController(queryRaw: () => Promise<unknown>) {
  const prisma = { $queryRaw: vi.fn(queryRaw) } as any;
  return { controller: new HealthController(prisma), prisma };
}

describe('HealthController', () => {
  it('liveness (ping) returns ok WITHOUT touching the DB', () => {
    const { controller, prisma } = makeController(async () => [{ 1: 1 }]);
    const res = controller.ping();
    expect(res.ok).toBe(true);
    // Liveness must never hit the DB — a DB outage must not crash-loop the API.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('readiness returns ok + db:up when SELECT 1 succeeds', async () => {
    const { controller, prisma } = makeController(async () => [{ 1: 1 }]);
    const res = await controller.ready();
    expect(res).toMatchObject({ ok: true, db: 'up' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('readiness throws 503 (ServiceUnavailable) when the DB is unreachable', async () => {
    const { controller } = makeController(async () => {
      throw new Error('ECONNREFUSED postgres:5432');
    });
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness 503 body does NOT leak the raw DB error', async () => {
    const { controller } = makeController(async () => {
      throw new Error('ECONNREFUSED secret-db-host:5432');
    });
    try {
      await controller.ready();
      throw new Error('should have thrown');
    } catch (e: any) {
      const body = e?.getResponse?.() ?? {};
      expect(JSON.stringify(body)).not.toContain('secret-db-host');
      expect(body).toMatchObject({ ok: false, db: 'down' });
    }
  });
});
