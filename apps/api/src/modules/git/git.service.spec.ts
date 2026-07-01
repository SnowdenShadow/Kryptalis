import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { GitService } from './git.service';

/**
 * GitService is a thin static-catalogue provider. The test guards the
 * contract the dashboard's provider picker relies on: the well-known hosted
 * providers are present with their canonical clone URLs, and the self-hosted
 * ones (Forgejo/Gitea) are advertised with an empty url (user supplies the host).
 */
describe('GitService.getProviders', () => {
  const service = new GitService({} as any);

  it('lists the five supported providers', () => {
    const ids = service.getProviders().map((p) => p.id);
    expect(ids).toEqual(['github', 'gitlab', 'bitbucket', 'forgejo', 'gitea']);
  });

  it('hosted providers carry their canonical https url', () => {
    const byId = Object.fromEntries(service.getProviders().map((p) => [p.id, p]));
    expect(byId.github.url).toBe('https://github.com');
    expect(byId.gitlab.url).toBe('https://gitlab.com');
    expect(byId.bitbucket.url).toBe('https://bitbucket.org');
  });

  it('self-hosted providers advertise an empty url (host is user-supplied)', () => {
    const byId = Object.fromEntries(service.getProviders().map((p) => [p.id, p]));
    expect(byId.forgejo.url).toBe('');
    expect(byId.gitea.url).toBe('');
  });

  it('every provider has a human-readable name', () => {
    for (const p of service.getProviders()) {
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
    }
  });
});
