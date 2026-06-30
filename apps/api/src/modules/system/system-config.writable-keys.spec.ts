import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';

/**
 * M-4: the admin config surface must only write keys on the allowlist. We test
 * the static gate AND the instance write path (setMany), which is what the
 * admin bulk-config endpoint calls.
 */
describe('SystemConfigService writable-key allowlist (M-4)', () => {
  it('isWritableKey accepts known keys and rejects unknown ones', () => {
    for (const k of ['smtp_host', 's3_endpoint', 'system_domain', 'backup_encryption_key']) {
      expect(SystemConfigService.isWritableKey(k), k).toBe(true);
    }
    for (const k of ['evil_key', 'deployment_mode_x', 'onboarding_completed_u1', 'bootstrapped', '__proto__']) {
      expect(SystemConfigService.isWritableKey(k), k).toBe(false);
    }
  });

  function makeService() {
    const prisma = {
      systemSetting: {
        upsert: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(async (ops: any) => Promise.all(ops)),
    };
    const encryption = { encrypt: (s: string) => `v1.${s}`, decrypt: (s: string) => s };
    const svc = new SystemConfigService(prisma as any, encryption as any);
    return { svc, prisma };
  }

  it('setMany rejects a write to an unknown key (no persistence)', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setMany({ evil_key: 'x' } as any, 'admin1')).rejects.toThrow(BadRequestException);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('setMany allows a batch of known keys', async () => {
    const { svc, prisma } = makeService();
    await svc.setMany({ smtp_host: 'mail.example.com', smtp_port: '587' } as any, 'admin1');
    expect(prisma.systemSetting.upsert).toHaveBeenCalled();
  });

  it('set rejects an unknown single key', async () => {
    const { svc } = makeService();
    await expect(svc.set('evil_key', 'x', 'admin1')).rejects.toThrow(/Unknown config key/);
  });
});
