import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * RolesGuard is the server-side enforcement point for @Roles(...) — the
 * dashboard's role gating is cosmetic, so this guard is the real trust
 * boundary. These tests pin: no @Roles → open; @Roles present → the request's
 * (live, from JwtStrategy) role must be in the allow-list.
 */
function ctxWith(user: unknown): any {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
}

function makeGuard(required: string[] | undefined) {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(required),
  } as unknown as Reflector;
  return { guard: new RolesGuard(reflector), reflector };
}

describe('RolesGuard', () => {
  it('allows when no @Roles metadata is set, but the SAME input is denied when metadata requires ADMIN (isolates the open-route branch)', () => {
    const user = { role: 'USER' };
    // No metadata → open. Same request, ADMIN required → denied. Proves the
    // "true" comes from the missing-metadata branch, not an unconditional pass.
    expect(makeGuard(undefined).guard.canActivate(ctxWith(user))).toBe(true);
    expect(makeGuard(['ADMIN']).guard.canActivate(ctxWith(user))).toBe(false);
  });

  it('allows when the user role is in the required set', () => {
    const { guard } = makeGuard(['ADMIN', 'SUPERADMIN']);
    expect(guard.canActivate(ctxWith({ role: 'ADMIN' }))).toBe(true);
    expect(guard.canActivate(ctxWith({ role: 'SUPERADMIN' }))).toBe(true);
  });

  it('DENIES when the user role is not in the required set', () => {
    const { guard } = makeGuard(['ADMIN', 'SUPERADMIN']);
    expect(guard.canActivate(ctxWith({ role: 'USER' }))).toBe(false);
    expect(guard.canActivate(ctxWith({ role: 'VIEWER' }))).toBe(false);
  });

  it('reads metadata from BOTH handler and class (getAllAndOverride contract)', () => {
    const { guard, reflector } = makeGuard(['ADMIN']);
    guard.canActivate(ctxWith({ role: 'ADMIN' }));
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      ROLES_KEY,
      expect.arrayContaining([expect.anything(), expect.anything()]),
    );
  });

  it('a demoted ADMIN (role now USER on the request) is rejected — the guard trusts request.user.role', () => {
    // JwtStrategy re-reads the live role from the DB on every request, so a
    // freshly-demoted admin arrives here as USER and must be denied.
    const { guard } = makeGuard(['ADMIN', 'SUPERADMIN']);
    expect(guard.canActivate(ctxWith({ role: 'USER' }))).toBe(false);
  });
});
