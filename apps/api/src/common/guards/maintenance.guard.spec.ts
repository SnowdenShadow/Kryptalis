import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ExecutionContext } from '@nestjs/common';
import { isMaintenanceExempt, MaintenanceGuard } from './maintenance.guard';

describe('isMaintenanceExempt (maintenance_mode gate)', () => {
  it('never blocks read verbs', () => {
    expect(isMaintenanceExempt('GET', '/api/projects')).toBe(true);
    expect(isMaintenanceExempt('get', '/api/projects')).toBe(true);
    expect(isMaintenanceExempt('HEAD', '/api/projects')).toBe(true);
    expect(isMaintenanceExempt('OPTIONS', '/api/projects')).toBe(true);
  });

  it('exempts auth, health, agent and webhook routes for writes', () => {
    expect(isMaintenanceExempt('POST', '/api/auth/login')).toBe(true);
    expect(isMaintenanceExempt('POST', '/api/auth/forgot-password')).toBe(true);
    expect(isMaintenanceExempt('POST', '/api/health')).toBe(true);
    expect(isMaintenanceExempt('POST', '/api/agent/report')).toBe(true);
    expect(isMaintenanceExempt('POST', '/api/webhooks/applications/abc')).toBe(true);
  });

  it('blocks ordinary write routes', () => {
    expect(isMaintenanceExempt('POST', '/api/projects')).toBe(false);
    expect(isMaintenanceExempt('PATCH', '/api/admin/users/1/status')).toBe(false);
    expect(isMaintenanceExempt('PUT', '/api/files/x')).toBe(false);
    expect(isMaintenanceExempt('DELETE', '/api/applications/1')).toBe(false);
  });

  it('does not let prefix-lookalike paths sneak through', () => {
    expect(isMaintenanceExempt('POST', '/api/authentic-data')).toBe(false);
    expect(isMaintenanceExempt('POST', '/api/agents')).toBe(false);
    expect(isMaintenanceExempt('POST', '/api/healthcheck')).toBe(false);
  });

  it('ignores query strings when matching', () => {
    expect(isMaintenanceExempt('POST', '/api/auth/login?x=1')).toBe(true);
    expect(isMaintenanceExempt('POST', '/api/projects?force=1')).toBe(false);
  });
});

// ── admin bypass: live DB re-read (not the token's role claim) ────────

describe('MaintenanceGuard.canActivate (admin bypass)', () => {
  const JWT_SECRET = 'maintenance-test-secret-0123456789';
  const jwt = new JwtService({ secret: JWT_SECRET });

  const configStub = {
    get: (key: string) => (key === 'JWT_SECRET' ? JWT_SECRET : undefined),
  } as any;
  const systemConfigStub = { getBool: vi.fn(), onChange: vi.fn(() => () => {}) } as any;
  const findUnique = vi.fn();
  const prismaStub = { user: { findUnique } } as any;

  function makeGuard(): MaintenanceGuard {
    const guard = new MaintenanceGuard(systemConfigStub, configStub, prismaStub);
    // maintenance_mode ON.
    systemConfigStub.getBool.mockReturnValue(true);
    guard.onModuleInit();
    return guard;
  }

  function ctx(method: string, path: string, token?: string): ExecutionContext {
    const req = {
      method,
      path,
      url: path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets a LIVE active admin through (role re-read from DB, not the claim)', async () => {
    const guard = makeGuard();
    // Token claims USER, but the DB says this account is now an ADMIN —
    // the live value wins.
    const token = jwt.sign({ sub: 'u1', role: 'USER' });
    findUnique.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE' });

    await expect(guard.canActivate(ctx('POST', '/api/projects', token))).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { role: true, status: true },
    });
  });

  it('a demoted admin (token says ADMIN, DB says USER) is BLOCKED', async () => {
    const guard = makeGuard();
    const token = jwt.sign({ sub: 'u1', role: 'ADMIN' });
    findUnique.mockResolvedValue({ role: 'USER', status: 'ACTIVE' });

    await expect(guard.canActivate(ctx('POST', '/api/projects', token))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('a SUSPENDED admin (token says ADMIN, DB status SUSPENDED) is BLOCKED', async () => {
    const guard = makeGuard();
    const token = jwt.sign({ sub: 'u1', role: 'ADMIN' });
    findUnique.mockResolvedValue({ role: 'ADMIN', status: 'SUSPENDED' });

    await expect(guard.canActivate(ctx('POST', '/api/projects', token))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('no token on a blocked write → 503 without a DB read', async () => {
    const guard = makeGuard();
    await expect(guard.canActivate(ctx('POST', '/api/projects'))).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('exempt prefixes still pass without a DB read', async () => {
    const guard = makeGuard();
    await expect(guard.canActivate(ctx('POST', '/api/auth/login'))).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('maintenance OFF → everything passes', async () => {
    systemConfigStub.getBool.mockReturnValue(false);
    const guard = new MaintenanceGuard(systemConfigStub, configStub, prismaStub);
    guard.onModuleInit();
    await expect(guard.canActivate(ctx('POST', '/api/projects'))).resolves.toBe(true);
  });
});
