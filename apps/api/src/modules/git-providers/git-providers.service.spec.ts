import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { GitProvidersService, repoFullNameFromUrl } from './git-providers.service';
import { GitOAuthService } from './git-oauth.service';

// ── fetch mock — no network ever ─────────────────────────────────────
// Route handlers match on URL substring; first hit wins. Anything
// unmatched fails loudly so a new code path can't silently hit GitHub.
type Route = { match: (url: string, init?: any) => boolean; res: () => any };
let routes: Route[] = [];
const fetchMock = vi.fn(async (url: any, init?: any) => {
  const u = String(url);
  for (const r of routes) {
    if (r.match(u, init)) return r.res();
  }
  throw new Error(`unmocked fetch: ${u}`);
});
vi.stubGlobal('fetch', fetchMock);

const json = (body: any, ok = true, status = ok ? 200 : 400) => ({
  ok,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const onUrl = (substr: string, body: any, ok = true) =>
  routes.push({ match: (u) => u.includes(substr), res: () => json(body, ok) });

// ── factories ────────────────────────────────────────────────────────

function makePrisma() {
  return {
    gitProvider: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeEncryption() {
  return {
    encrypt: vi.fn((s: string) => `enc:${s}`),
    decrypt: vi.fn((s: string) => (s.startsWith('enc:') ? s.slice(4) : s)),
  };
}

function makeProvidersService() {
  const prisma = makePrisma();
  const encryption = makeEncryption();
  const service = new GitProvidersService(prisma as any, encryption as any);
  return { service, prisma, encryption };
}

function makeOAuthService() {
  const prisma = makePrisma();
  const encryption = makeEncryption();
  const service = new GitOAuthService(prisma as any, encryption as any);
  return { service, prisma, encryption };
}

beforeEach(() => {
  vi.clearAllMocks();
  routes = [];
  process.env.GITHUB_OAUTH_CLIENT_ID = 'Iv1.testclient';
});

afterEach(() => {
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
});

// ── GitOAuthService: configuration gate ──────────────────────────────

describe('GitOAuthService configuration', () => {
  it('GITHUB is always configured: the official client_id is baked in, no env needed', () => {
    const { service } = makeOAuthService();
    expect(service.isConfigured('GITHUB')).toBe(true);
    // No env var → falls back to the committed default (device flow uses
    // no client secret, so shipping the public client_id is safe).
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    expect(service.isConfigured('GITHUB')).toBe(true);
  });

  it('GITHUB_OAUTH_CLIENT_ID env var overrides the baked-in default in the device-code request', async () => {
    const { service } = makeOAuthService(); // beforeEach sets Iv1.testclient
    onUrl('github.com/login/device/code', {
      user_code: 'X',
      device_code: 'dc',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    });
    await service.startGithubDeviceFlow();
    const call = fetchMock.mock.calls.find(([u]: any[]) => String(u).includes('login/device/code'))!;
    expect(JSON.parse((call[1] as any).body).client_id).toBe('Iv1.testclient');
  });

  it('without the env override, the baked-in default client_id is sent', async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    const { service } = makeOAuthService();
    onUrl('github.com/login/device/code', {
      user_code: 'X',
      device_code: 'dc',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    });
    await service.startGithubDeviceFlow();
    const call = fetchMock.mock.calls.find(([u]: any[]) => String(u).includes('login/device/code'))!;
    expect(JSON.parse((call[1] as any).body).client_id).toBe('Ov23liGhrCZJ2hB4ILtX');
  });

  it('pollGithubDeviceFlow requires a device_code', async () => {
    const { service } = makeOAuthService();
    await expect(service.pollGithubDeviceFlow('u1', '')).rejects.toThrow(
      'device_code is required',
    );
  });
});

// ── GitOAuthService: device flow ─────────────────────────────────────

describe('startGithubDeviceFlow', () => {
  it('maps the GitHub response, floors the poll interval at 5s', async () => {
    const { service } = makeOAuthService();
    onUrl('github.com/login/device/code', {
      user_code: 'ABCD-1234',
      device_code: 'dc-1',
      verification_uri: 'https://github.com/login/device',
      verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
      expires_in: 900,
      interval: 1, // GitHub never goes below 5 — service must clamp
    });

    const res = await service.startGithubDeviceFlow();
    expect(res).toEqual({
      userCode: 'ABCD-1234',
      deviceCode: 'dc-1',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: 'https://github.com/login/device?user_code=ABCD-1234',
      expiresIn: 900,
      interval: 5,
    });
    // sends client_id + tight scope list
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ client_id: 'Iv1.testclient', scope: 'repo read:user user:email' });
  });

  it('surfaces GitHub error_description on failure', async () => {
    const { service } = makeOAuthService();
    onUrl('github.com/login/device/code', {
      error: 'unauthorized_client',
      error_description: 'The client is not authorized',
    }, false);

    await expect(service.startGithubDeviceFlow()).rejects.toThrow(
      'The client is not authorized',
    );
  });
});

describe('pollGithubDeviceFlow', () => {
  it.each([
    ['authorization_pending', 'pending'],
    ['slow_down', 'slow_down'],
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
    ['incorrect_device_code', 'error'],
  ])('maps GitHub error %j to state %j', async (ghError, state) => {
    const { service } = makeOAuthService();
    onUrl('login/oauth/access_token', { error: ghError });
    const res = await service.pollGithubDeviceFlow('u1', 'dc-1');
    expect(res.state).toBe(state);
  });

  it('errors when the token response has no access_token', async () => {
    const { service } = makeOAuthService();
    onUrl('login/oauth/access_token', {});
    const res = await service.pollGithubDeviceFlow('u1', 'dc-1');
    expect(res).toEqual({ state: 'error', message: 'Token response missing access_token' });
  });

  it('on success: creates an OAUTH provider row with the token encrypted at rest', async () => {
    const { service, prisma, encryption } = makeOAuthService();
    onUrl('login/oauth/access_token', {
      access_token: 'gho_secret',
      refresh_token: 'ghr_refresh',
      expires_in: 28800,
      scope: 'repo,read:user',
    });
    onUrl('api.github.com/user', { login: 'octocat', avatar_url: 'https://a/octo.png' });

    const res = await service.pollGithubDeviceFlow('u1', 'dc-1');
    expect(res).toEqual({ state: 'authorized' });

    expect(encryption.encrypt).toHaveBeenCalledWith('gho_secret');
    expect(encryption.encrypt).toHaveBeenCalledWith('ghr_refresh');
    const created = prisma.gitProvider.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      userId: 'u1',
      provider: 'GITHUB',
      authMode: 'OAUTH',
      token: 'enc:gho_secret',
      refreshToken: 'enc:ghr_refresh',
      username: 'octocat',
      scopes: 'repo,read:user',
    });
    // the raw token never lands in the row
    expect(JSON.stringify(created)).not.toContain('"gho_secret"');
    expect(created.expiresAt).toBeInstanceOf(Date);
  });

  it('re-authorizing the same GitHub account updates the existing row (keeps its name)', async () => {
    const { service, prisma } = makeOAuthService();
    prisma.gitProvider.findFirst.mockResolvedValue({ id: 'gp1', name: 'My custom name' });
    onUrl('login/oauth/access_token', { access_token: 'gho_new' });
    onUrl('api.github.com/user', { login: 'octocat', avatar_url: '' });

    await service.pollGithubDeviceFlow('u1', 'dc-1');
    expect(prisma.gitProvider.create).not.toHaveBeenCalled();
    expect(prisma.gitProvider.update).toHaveBeenCalledWith({
      where: { id: 'gp1' },
      data: expect.objectContaining({ name: 'My custom name', token: 'enc:gho_new' }),
    });
  });

  it('400s when the user-info fetch fails after a valid token', async () => {
    const { service, prisma } = makeOAuthService();
    onUrl('login/oauth/access_token', { access_token: 'gho_x' });
    onUrl('api.github.com/user', { message: 'bad credentials' }, false);

    await expect(service.pollGithubDeviceFlow('u1', 'dc-1')).rejects.toThrow(
      'Could not fetch GitHub user info',
    );
    expect(prisma.gitProvider.create).not.toHaveBeenCalled();
  });
});

describe('getGithubAccessToken', () => {
  it('decrypts the newest OAUTH token for the user (no refresh when not stale)', async () => {
    const { service, prisma } = makeOAuthService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1',
      token: 'enc:gho_secret',
      refreshToken: 'enc:ghr_refresh',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h out → fresh
    });
    expect(await service.getGithubAccessToken('u1')).toBe('gho_secret');
    expect(prisma.gitProvider.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', provider: 'GITHUB', authMode: 'OAUTH' },
      orderBy: { createdAt: 'desc' },
    });
    // fresh token → no refresh grant, no write
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.gitProvider.updateMany).not.toHaveBeenCalled();
  });

  it('400s with guidance when no OAuth connection exists', async () => {
    const { service } = makeOAuthService();
    await expect(service.getGithubAccessToken('u1')).rejects.toThrow(
      /No GitHub OAuth connection found/,
    );
  });
});

describe('refreshGithubToken', () => {
  const staleRow = () => ({
    id: 'gp1',
    token: 'enc:old_access',
    refreshToken: 'enc:ghr_old',
    expiresAt: new Date(Date.now() - 1000), // already past → stale
  });

  it('exchanges the refresh token and persists the re-encrypted access + refresh + expiry', async () => {
    const { service, prisma, encryption } = makeOAuthService();
    onUrl('login/oauth/access_token', {
      access_token: 'gho_new',
      refresh_token: 'ghr_new',
      expires_in: 28800,
    });

    const { token } = await service.refreshGithubToken(staleRow());
    expect(token).toBe('enc:gho_new');

    // the single-use refresh token was decrypted and sent with a refresh grant
    const body = JSON.parse(
      fetchMock.mock.calls.find(([u]: any[]) =>
        String(u).includes('login/oauth/access_token'),
      )![1].body,
    );
    expect(body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
      client_id: 'Iv1.testclient',
    });
    // public device-flow client → no client_secret unless env provides one
    expect(body.client_secret).toBeUndefined();

    expect(encryption.encrypt).toHaveBeenCalledWith('gho_new');
    expect(encryption.encrypt).toHaveBeenCalledWith('ghr_new');
    // guarded write pinned to the expiresAt we read
    const upd = prisma.gitProvider.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({ id: 'gp1' });
    expect(upd.where.expiresAt).toBeInstanceOf(Date);
    expect(upd.data).toMatchObject({ token: 'enc:gho_new', refreshToken: 'enc:ghr_new' });
    expect(upd.data.expiresAt).toBeInstanceOf(Date);
  });

  it('sends client_secret when configured (confidential / web-flow app)', async () => {
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'shhh';
    try {
      const { service } = makeOAuthService();
      onUrl('login/oauth/access_token', { access_token: 'gho_new', expires_in: 28800 });
      await service.refreshGithubToken(staleRow());
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.client_secret).toBe('shhh');
    } finally {
      delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    }
  });

  it('no-ops for non-refresh OAuth / PAT rows (no refreshToken) — returns the token as-is', async () => {
    const { service, prisma } = makeOAuthService();
    const { token } = await service.refreshGithubToken({
      id: 'gp1',
      token: 'enc:pat',
      refreshToken: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(token).toBe('enc:pat');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.gitProvider.updateMany).not.toHaveBeenCalled();
  });

  it('loses the concurrent-refresh race → re-reads the row the winner wrote', async () => {
    const { service, prisma } = makeOAuthService();
    onUrl('login/oauth/access_token', { access_token: 'gho_mine', expires_in: 28800 });
    // precondition matched zero rows → another deploy already refreshed
    prisma.gitProvider.updateMany.mockResolvedValue({ count: 0 });
    prisma.gitProvider.findUnique.mockResolvedValue({ token: 'enc:gho_winner' });

    const { token } = await service.refreshGithubToken(staleRow());
    expect(token).toBe('enc:gho_winner');
    expect(prisma.gitProvider.findUnique).toHaveBeenCalledWith({ where: { id: 'gp1' } });
  });

  it('keeps the existing token when GitHub rejects the refresh grant', async () => {
    const { service, prisma } = makeOAuthService();
    onUrl('login/oauth/access_token', { error: 'bad_refresh_token' });
    const { token } = await service.refreshGithubToken(staleRow());
    expect(token).toBe('enc:old_access');
    expect(prisma.gitProvider.updateMany).not.toHaveBeenCalled();
  });
});

// ── GitProvidersService: CRUD + token-at-rest ────────────────────────

describe('GitProvidersService.create (PAT flow)', () => {
  it('validates the token against the provider API and stores it encrypted', async () => {
    const { service, prisma, encryption } = makeProvidersService();
    onUrl('api.github.com/user', { login: 'octocat', avatar_url: 'https://a/o.png' });

    await service.create('u1', {
      provider: 'GITHUB', name: 'work', token: 'ghp_raw',
    } as any);

    expect(encryption.encrypt).toHaveBeenCalledWith('ghp_raw');
    const call = prisma.gitProvider.create.mock.calls[0][0];
    expect(call.data).toMatchObject({
      userId: 'u1', provider: 'GITHUB', token: 'enc:ghp_raw', username: 'octocat',
    });
    // the API response shape never includes the token column
    expect(call.select.token).toBeUndefined();
    expect(call.select).toMatchObject({ id: true, provider: true, username: true });
  });

  it('400s on an invalid token without touching the DB', async () => {
    const { service, prisma } = makeProvidersService();
    onUrl('api.github.com/user', { message: 'Bad credentials' }, false);

    await expect(
      service.create('u1', { provider: 'GITHUB', name: 'x', token: 'bad' } as any),
    ).rejects.toThrow('Invalid token or unable to fetch user info');
    expect(prisma.gitProvider.create).not.toHaveBeenCalled();
  });

  it('GITLAB tokens are validated with the PRIVATE-TOKEN header', async () => {
    const { service } = makeProvidersService();
    onUrl('gitlab.com/api/v4/user', { username: 'gl-user', avatar_url: '' });

    await service.create('u1', { provider: 'GITLAB', name: 'gl', token: 'glpat' } as any);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['PRIVATE-TOKEN']).toBe('glpat');
  });
});

describe('GitProvidersService reads / delete — user scoping', () => {
  it('findAll filters by userId and never selects the token', async () => {
    const { service, prisma } = makeProvidersService();
    await service.findAll('u1');
    const q = prisma.gitProvider.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ userId: 'u1' });
    expect(q.select.token).toBeUndefined();
  });

  it("remove 404s on another user's provider", async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue(null);
    await expect(service.remove('gp1', 'u1')).rejects.toThrow(NotFoundException);
    expect(prisma.gitProvider.findFirst).toHaveBeenCalledWith({
      where: { id: 'gp1', userId: 'u1' },
    });
    expect(prisma.gitProvider.delete).not.toHaveBeenCalled();
  });

  it('remove deletes an owned provider', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({ id: 'gp1' });
    expect(await service.remove('gp1', 'u1')).toEqual({ message: 'Provider disconnected' });
    expect(prisma.gitProvider.delete).toHaveBeenCalledWith({ where: { id: 'gp1' } });
  });

  it("listRepos 404s on another user's provider before any network call", async () => {
    const { service } = makeProvidersService();
    await expect(service.listRepos('gp1', 'u2')).rejects.toThrow(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listRepos', () => {
  it('decrypts the stored token and sends it as a Bearer header', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:ghp_tok',
    });
    onUrl('api.github.com/user/repos', [
      {
        name: 'repo', full_name: 'octocat/repo', clone_url: 'https://github.com/octocat/repo.git',
        private: true, default_branch: 'main', updated_at: '2026-01-01', description: 'd', language: 'TS',
      },
    ]);

    const repos = await service.listRepos('gp1', 'u1');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer ghp_tok');
    expect(repos).toEqual([
      expect.objectContaining({
        fullName: 'octocat/repo', private: true, defaultBranch: 'main',
      }),
    ]);
  });

  it('wraps an upstream failure in a 400 with the status code', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    onUrl('api.github.com/user/repos', {}, false);

    await expect(service.listRepos('gp1', 'u1')).rejects.toThrow(BadRequestException);
    await expect(
      service.listRepos('gp1', 'u1').catch((e) => Promise.reject(new Error(e.message))),
    ).rejects.toThrow(/GitHub API: 400/);
  });
});

describe('detectRepo', () => {
  it('detects DOCKER_COMPOSE ahead of Dockerfile/package.json', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    routes.push({
      match: (u) => u.includes('/contents/'),
      res: () => json({}, false, 404),
    });
    routes.unshift({
      match: (u) => u.includes('/contents/docker-compose.yml'),
      res: () => json({ name: 'docker-compose.yml' }),
    });

    const res = await service.detectRepo('gp1', 'u1', 'me/app', 'main');
    expect(res.framework).toBe('DOCKER_COMPOSE');
    expect(res.hasCompose).toBe(true);
  });

  it('detects NEXTJS from package.json deps with build/start commands', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    const pkg = { dependencies: { next: '15.0.0', react: '19' } };
    routes.push({
      match: (u) => u.includes('/contents/package.json'),
      res: () => json({ content: Buffer.from(JSON.stringify(pkg)).toString('base64') }),
    });
    routes.push({ match: (u) => u.includes('/contents/'), res: () => json({}, false, 404) });

    const res = await service.detectRepo('gp1', 'u1', 'me/app', 'main');
    expect(res).toMatchObject({
      framework: 'NEXTJS',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      hasPackageJson: true,
    });
  });
});

describe('fetchFile', () => {
  it('decodes GitHub base64 content', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    onUrl('/contents/', { content: Buffer.from('FROM node:20').toString('base64') });

    const res = await service.fetchFile('gp1', 'u1', 'me/app', 'main', 'Dockerfile');
    expect(res).toEqual({ content: 'FROM node:20', exists: true });
  });

  it('returns exists:false on 404 instead of throwing', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    onUrl('/contents/', {}, false);

    const res = await service.fetchFile('gp1', 'u1', 'me/app', 'main', 'Dockerfile');
    expect(res).toEqual({ content: '', exists: false });
  });
});

// ── repoFullNameFromUrl ──────────────────────────────────────────────

describe('repoFullNameFromUrl', () => {
  it.each([
    ['https://github.com/acme/site.git', 'acme/site'],
    ['https://github.com/acme/site', 'acme/site'],
    ['https://gitlab.com/group/sub/repo.git', 'group/sub/repo'],
    ['https://bitbucket.org/workspace/repo', 'workspace/repo'],
    ['https://github.com/acme/site/', 'acme/site'],
    // Regression: trailing slash AFTER .git (common copy-paste shape) must still
    // strip both, not yield `acme/site.git`.
    ['https://github.com/acme/site.git/', 'acme/site'],
    ['https://gitlab.com/group/sub/repo.git/', 'group/sub/repo'],
  ])('parses %s → %s', (url, expected) => {
    expect(repoFullNameFromUrl(url)).toBe(expected);
  });

  it('throws on a missing URL', () => {
    expect(() => repoFullNameFromUrl(null)).toThrow(BadRequestException);
  });

  it('throws when no owner/repo can be derived', () => {
    expect(() => repoFullNameFromUrl('https://github.com/justowner')).toThrow(
      BadRequestException,
    );
  });

  it('throws on a non-URL string', () => {
    expect(() => repoFullNameFromUrl('not a url')).toThrow(BadRequestException);
  });
});

// ── listBranches ─────────────────────────────────────────────────────

describe('listBranches', () => {
  it("404s on another user's provider before any network call", async () => {
    const { service } = makeProvidersService();
    await expect(service.listBranches('gp1', 'u2', 'me/app')).rejects.toThrow(
      NotFoundException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GitHub: lists branches and flags the default from the repo metadata', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    onUrl('/branches', [{ name: 'main' }, { name: 'dev' }]);
    // repo metadata lookup for the default branch (must not match /branches)
    routes.push({
      match: (u) => /api\.github\.com\/repos\/me\/app$/.test(u),
      res: () => json({ default_branch: 'dev' }),
    });

    const res = await service.listBranches('gp1', 'u1', 'me/app');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer t');
    expect(res).toEqual([
      { name: 'main', isDefault: false },
      { name: 'dev', isDefault: true },
    ]);
  });

  it('GitLab: maps the inline `default` flag (no extra metadata call)', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITLAB', token: 'enc:gl',
    });
    onUrl('/repository/branches', [
      { name: 'main', default: true },
      { name: 'feature', default: false },
    ]);

    const res = await service.listBranches('gp1', 'u1', 'group/app');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['PRIVATE-TOKEN']).toBe('gl');
    expect(res).toEqual([
      { name: 'main', isDefault: true },
      { name: 'feature', isDefault: false },
    ]);
  });

  it('wraps an upstream failure in a 400', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    onUrl('/branches', {}, false);
    await expect(service.listBranches('gp1', 'u1', 'me/app')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('GitHub: paginates past 100 branches (no silent truncation)', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `b${i}` }));
    const page2 = [{ name: 'b100' }, { name: 'b101' }];
    // Match the `&page=N` param exactly — note the URL also carries `per_page=100`,
    // so a bare `page=1` substring would also match `per_page=100`.
    routes.push({
      match: (u) => u.includes('/branches') && u.includes('&page=1'),
      res: () => json(page1),
    });
    routes.push({
      match: (u) => u.includes('/branches') && u.includes('&page=2'),
      res: () => json(page2),
    });
    routes.push({
      match: (u) => /api\.github\.com\/repos\/me\/app$/.test(u),
      res: () => json({ default_branch: 'b0' }),
    });

    const res = await service.listBranches('gp1', 'u1', 'me/app');
    expect(res).toHaveLength(102);
    expect(res[0]).toEqual({ name: 'b0', isDefault: true });
    expect(res[101]).toEqual({ name: 'b101', isDefault: false });
  });

  it('Bitbucket: follows the `next` URL until exhausted', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'BITBUCKET', token: 'enc:bb',
    });
    routes.push({
      match: (u) => u.includes('/refs/branches') && !u.includes('page=2'),
      res: () => json({ values: [{ name: 'main' }], next: 'https://api.bitbucket.org/2.0/repositories/me/app/refs/branches?page=2' }),
    });
    routes.push({
      match: (u) => u.includes('/refs/branches') && u.includes('page=2'),
      res: () => json({ values: [{ name: 'dev' }] }),
    });
    routes.push({
      match: (u) => /repositories\/me\/app$/.test(u),
      res: () => json({ mainbranch: { name: 'main' } }),
    });

    const res = await service.listBranches('gp1', 'u1', 'me/app');
    expect(res).toEqual([
      { name: 'main', isDefault: true },
      { name: 'dev', isDefault: false },
    ]);
  });
});

// ── registerWebhook ──────────────────────────────────────────────────

describe('registerWebhook', () => {
  const URL = 'https://kryptalis.example.com/api/webhooks/applications/app1';

  it("404s on another user's provider before any network call", async () => {
    const { service } = makeProvidersService();
    await expect(
      service.registerWebhook('gp1', 'u2', 'me/app', URL, 'sec'),
    ).rejects.toThrow(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GitHub: POSTs a push hook with the secret in config when none exists', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    // existing-hooks GET returns empty, POST succeeds
    routes.push({
      match: (u, init) => u.includes('/hooks') && (!init || init.method !== 'POST'),
      res: () => json([]),
    });
    routes.push({
      match: (u, init) => u.includes('/hooks') && init?.method === 'POST',
      res: () => json({ id: 1 }, true, 201),
    });

    const res = await service.registerWebhook('gp1', 'u1', 'me/app', URL, 'sec');
    expect(res).toEqual({ created: true, alreadyExists: false });
    const post = fetchMock.mock.calls.find(([, i]: any[]) => i?.method === 'POST')!;
    const body = JSON.parse((post[1] as any).body);
    expect(body).toMatchObject({
      name: 'web',
      events: ['push'],
      config: { url: URL, content_type: 'json', secret: 'sec' },
    });
  });

  it('GitHub: idempotent — PATCHes the existing hook (re-syncs secret) instead of POSTing a duplicate', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    // existing-hooks GET returns a hook at our URL with an id to PATCH
    routes.push({
      match: (u, init) => u.includes('/hooks') && (!init || init.method === undefined),
      res: () => json([{ id: 42, config: { url: URL } }]),
    });
    routes.push({
      match: (u, init) => u.includes('/hooks/42') && init?.method === 'PATCH',
      res: () => json({ id: 42 }),
    });

    const res = await service.registerWebhook('gp1', 'u1', 'me/app', URL, 'newsecret');
    expect(res).toEqual({ created: false, alreadyExists: true });
    // No duplicate POST; the secret is re-synced via PATCH.
    expect(fetchMock.mock.calls.some(([, i]: any[]) => i?.method === 'POST')).toBe(false);
    const patch = fetchMock.mock.calls.find(([, i]: any[]) => i?.method === 'PATCH')!;
    expect(JSON.parse((patch[1] as any).body).config.secret).toBe('newsecret');
  });

  it('GitLab: POSTs with token + push_events', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITLAB', token: 'enc:gl',
    });
    routes.push({
      match: (u, init) => u.includes('/hooks') && (!init || init.method !== 'POST'),
      res: () => json([]),
    });
    routes.push({
      match: (u, init) => u.includes('/hooks') && init?.method === 'POST',
      res: () => json({ id: 2 }, true, 201),
    });

    await service.registerWebhook('gp1', 'u1', 'group/app', URL, 'sec');
    const post = fetchMock.mock.calls.find(([, i]: any[]) => i?.method === 'POST')!;
    const body = JSON.parse((post[1] as any).body);
    expect(body).toMatchObject({ url: URL, token: 'sec', push_events: true });
  });

  it('surfaces a readable 403 (token missing webhook permission)', async () => {
    const { service, prisma } = makeProvidersService();
    prisma.gitProvider.findFirst.mockResolvedValue({
      id: 'gp1', provider: 'GITHUB', token: 'enc:t',
    });
    routes.push({
      match: (u, init) => u.includes('/hooks') && (!init || init.method !== 'POST'),
      res: () => json([]),
    });
    routes.push({
      match: (u, init) => u.includes('/hooks') && init?.method === 'POST',
      res: () => json({ message: 'Forbidden' }, false, 403),
    });

    await expect(
      service.registerWebhook('gp1', 'u1', 'me/app', URL, 'sec'),
    ).rejects.toThrow(/missing the permission/);
  });
});
