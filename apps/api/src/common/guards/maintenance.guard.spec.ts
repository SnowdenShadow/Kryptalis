import { describe, it, expect } from 'vitest';
import { isMaintenanceExempt } from './maintenance.guard';

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
