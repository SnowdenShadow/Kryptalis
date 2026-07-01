import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { CreateGitProviderDto } from './dto/create-git-provider.dto';
import { screenUrlLiteral, screenResolvedHost } from '../../common/net/ssrf-guard';

export interface Repo {
  name: string;
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
  description?: string;
  language?: string;
}

export interface Branch {
  name: string;
  isDefault: boolean;
}

/**
 * Derive the provider-API repo identifier (`owner/repo`, `group/sub/repo`,
 * `workspace/repo`) from a stored HTTPS clone URL. The Application stores the
 * full clone URL (e.g. https://github.com/acme/site.git) but every provider
 * REST call keys off the path-with-namespace, so we strip the leading slash
 * and a trailing `.git`. Throws BadRequestException on a non-URL / empty path
 * so callers surface a clear error instead of building a bogus API URL.
 */
export function repoFullNameFromUrl(gitUrl: string | null | undefined): string {
  if (!gitUrl) throw new BadRequestException('Application has no git URL');
  let url: URL;
  try {
    url = new URL(gitUrl);
  } catch {
    throw new BadRequestException('Invalid Git URL');
  }
  // Strip trailing slashes BEFORE the .git suffix: a copy-pasted clone URL like
  // `…/site.git/` ends in `/`, so removing `.git$` first would miss it and leave
  // `site.git`. Order: leading slashes → trailing slashes → .git → trailing
  // slashes again (in case `.git/` exposed a new trailing slash, e.g. `repo/.git/`).
  const full = url.pathname
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!full || !full.includes('/')) {
    throw new BadRequestException('Cannot derive owner/repo from the git URL');
  }
  return full;
}

/**
 * Canonical SaaS clone hosts for the hosted providers. Self-hosted providers
 * (Gitea/Forgejo) have no canonical host — they are pinned per-instance against
 * the host of their stored `baseUrl` instead (see assertCloneHostAllowed).
 */
const PROVIDER_HOSTS: Record<string, string[]> = {
  GITHUB: ['github.com', 'api.github.com'],
  GITLAB: ['gitlab.com'],
  BITBUCKET: ['bitbucket.org'],
};

/** Self-hosted providers that carry a per-instance baseUrl. */
export const SELF_HOSTED_PROVIDERS = new Set(['GITEA', 'FORGEJO']);

/**
 * Whether private/LAN git hosts are permitted. OFF by default — a self-hosted
 * Gitea on a public domain works out of the box; pointing the platform at an
 * RFC1918 LAN host requires the operator to explicitly opt in, mirroring
 * ALLOW_PRIVATE_S3_ENDPOINTS. Loopback/metadata stay blocked regardless.
 */
export function gitHostsAllowPrivate(): boolean {
  return (process.env.ALLOW_PRIVATE_GIT_HOSTS || 'false').toLowerCase() === 'true';
}

/**
 * Block clone targets that point at the loopback/link-local/private ranges
 * (SSRF). Used for the one-shot PAT path where there's no provider host to
 * pin against — we still refuse private/loopback literals. `allowPrivate`
 * relaxes RFC1918 (still never loopback/metadata) for opted-in self-hosted LANs.
 */
export function isPrivateOrLoopbackHost(hostname: string, allowPrivate = false): boolean {
  // Delegate to the shared SSRF guard (common/net/ssrf-guard.ts) so the git PAT
  // path benefits from the same coverage the webhook screen has: IPv4 smuggled
  // inside IPv6 (::ffff:127.0.0.1), CGNAT 100.64/10, 0.0.0.0/8, and WHATWG-URL
  // normalization of decimal/octal/hex IPv4. (M-7) screenUrlLiteral wants a
  // full URL, so wrap the host (bracket IPv6 literals).
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostForUrl = h.includes(':') ? `[${h}]` : h;
  return screenUrlLiteral(`https://${hostForUrl}`, { allowPrivate }) !== null;
}

/**
 * Enforce that a clone URL is safe to inject a decrypted git token into:
 * HTTPS only, and the host must match the selected provider's allowed host(s).
 * A member who points gitUrl at evil.example.com would otherwise exfiltrate the
 * victim's git token (token exfil + SSRF).
 *
 * Host pinning, in order of precedence:
 *   - `baseUrl` set (self-hosted Gitea/Forgejo) → pin to the baseUrl's host.
 *   - else a known SaaS `provider` → pin to its canonical host(s).
 *   - else (one-shot PAT / anonymous) → no host pin, just HTTPS + non-private.
 *
 * `allowPrivate` (operator opt-in) relaxes RFC1918 for self-hosted LAN hosts;
 * loopback/metadata remain blocked. Centralized so create/redeploy/webhook
 * paths can't drift. Throws BadRequestException on any mismatch.
 */
export function assertCloneHostAllowed(
  provider: string | null | undefined,
  gitUrl: string,
  baseUrl?: string | null,
): void {
  let url: URL;
  try {
    url = new URL(gitUrl);
  } catch {
    throw new BadRequestException('Invalid Git URL');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException('Git URL must use https');
  }
  const allowPrivate = gitHostsAllowPrivate();
  const hostname = url.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(hostname, allowPrivate)) {
    throw new BadRequestException('Git URL host is not allowed');
  }
  let allowed: string[] | undefined;
  if (baseUrl) {
    // Self-hosted: pin to the instance host. A bad baseUrl throws clearly.
    let bu: URL;
    try {
      bu = new URL(baseUrl);
    } catch {
      throw new BadRequestException('Invalid provider base URL');
    }
    allowed = [bu.hostname.toLowerCase()];
  } else if (provider) {
    allowed = PROVIDER_HOSTS[provider];
  }
  if (allowed && !allowed.includes(hostname)) {
    throw new BadRequestException('Git URL host does not match the selected provider');
  }
}

/**
 * DNS-rebinding screen for a clone host (M-7). assertCloneHostAllowed() screens
 * the URL literal; this resolves the hostname and rejects if ANY A/AAAA points
 * at a private/loopback/metadata address. Call right before a clone that injects
 * a credential, so a public name that (re)binds to an internal IP between
 * validation and clone can't exfiltrate the token or SSRF an internal service.
 * Provider-pinned hosts (github.com etc.) resolve public and pass; the value is
 * for the one-shot PAT / anonymous path where the host is fully user-chosen.
 * `allowPrivate` honours the self-hosted-LAN opt-in (metadata still blocked).
 */
export async function assertCloneHostResolvable(
  gitUrl: string,
  allowPrivate = false,
): Promise<void> {
  const violation = await screenResolvedHost(gitUrl, {
    allowedSchemes: ['https:'],
    allowPrivate,
  });
  if (violation) {
    throw new BadRequestException(`Git URL host is not allowed (${violation})`);
  }
}

@Injectable()
export class GitProvidersService {
  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  /**
   * Decrypt the stored token. Legacy plaintext rows return as-is via the
   * EncryptionService prefix check; new rows are encrypted at-rest.
   */
  private getToken(gp: { token: string }): string {
    return this.encryption.decrypt(gp.token);
  }

  /**
   * Guard a clone URL before a decrypted token is injected into it.
   * Delegates to the shared {@link assertCloneHostAllowed} so the create
   * and redeploy/webhook paths share one rule. Throws BadRequestException.
   */
  assertCloneHostAllowed(
    provider: string | null | undefined,
    gitUrl: string,
    baseUrl?: string | null,
  ): void {
    assertCloneHostAllowed(provider, gitUrl, baseUrl);
  }

  /**
   * Resolve the API base for a provider. Self-hosted Gitea/Forgejo expose the
   * GitHub-compatible REST API under `${baseUrl}/api/v1`. Every self-hosted
   * call screens the baseUrl host first so we never fetch an unscreened host.
   */
  private giteaApiBase(gp: { provider: string; baseUrl: string | null }): string {
    if (!gp.baseUrl) {
      throw new BadRequestException('Self-hosted provider is missing its base URL');
    }
    let bu: URL;
    try {
      bu = new URL(gp.baseUrl);
    } catch {
      throw new BadRequestException('Invalid provider base URL');
    }
    if (bu.protocol !== 'https:') {
      throw new BadRequestException('Provider base URL must use https');
    }
    if (isPrivateOrLoopbackHost(bu.hostname, gitHostsAllowPrivate())) {
      throw new BadRequestException('Provider base URL host is not allowed');
    }
    return `${gp.baseUrl.replace(/\/+$/, '')}/api/v1`;
  }

  async create(userId: string, dto: CreateGitProviderDto) {
    // Self-hosted providers require an instance base URL. Normalize + screen it
    // (HTTPS, non-private unless opted in) BEFORE we send the token anywhere.
    let baseUrl: string | null = null;
    if (SELF_HOSTED_PROVIDERS.has(dto.provider)) {
      if (!dto.baseUrl) {
        throw new BadRequestException('Gitea/Forgejo require the instance base URL');
      }
      let bu: URL;
      try {
        bu = new URL(dto.baseUrl);
      } catch {
        throw new BadRequestException('Invalid provider base URL');
      }
      if (bu.protocol !== 'https:') {
        throw new BadRequestException('Provider base URL must use https');
      }
      if (isPrivateOrLoopbackHost(bu.hostname, gitHostsAllowPrivate())) {
        throw new BadRequestException('Provider base URL host is not allowed');
      }
      baseUrl = `${dto.baseUrl.replace(/\/+$/, '')}`;
    }

    const userInfo = await this.fetchUserInfo(dto.provider, dto.token, baseUrl);
    if (!userInfo) throw new BadRequestException('Invalid token or unable to fetch user info');

    return this.prisma.gitProvider.create({
      data: {
        userId,
        provider: dto.provider,
        name: dto.name,
        baseUrl,
        token: this.encryption.encrypt(dto.token),
        username: userInfo.username,
        avatarUrl: userInfo.avatarUrl,
      },
      select: {
        id: true, provider: true, name: true, baseUrl: true, username: true, avatarUrl: true, createdAt: true,
      },
    });
  }

  async findAll(userId: string) {
    return this.prisma.gitProvider.findMany({
      where: { userId },
      select: {
        id: true, provider: true, name: true, baseUrl: true, username: true, avatarUrl: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async remove(id: string, userId: string) {
    const gp = await this.prisma.gitProvider.findFirst({ where: { id, userId } });
    if (!gp) throw new NotFoundException('Provider not found');
    await this.prisma.gitProvider.delete({ where: { id } });
    return { message: 'Provider disconnected' };
  }

  async detectRepo(id: string, userId: string, repoFullName: string, branch: string) {
    const gp = await this.prisma.gitProvider.findFirst({ where: { id, userId } });
    if (!gp) throw new NotFoundException('Provider not found');

    const files = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile', 'package.json', 'requirements.txt', 'composer.json', 'Gemfile', 'go.mod'];
    const found: Record<string, boolean> = {};
    let pkgJson: any = null;

    try {
      if (gp.provider === 'GITHUB') {
        for (const file of files) {
          const res = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${file}?ref=${branch}`, {
            headers: { 'Authorization': `Bearer ${this.getToken(gp)}`, 'Accept': 'application/vnd.github+json' },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            found[file] = true;
            if (file === 'package.json') {
              const data: any = await res.json();
              if (data.content) {
                try { pkgJson = JSON.parse(Buffer.from(data.content, 'base64').toString()); } catch {}
              }
            }
          }
        }
      } else if (gp.provider === 'GITLAB') {
        const projectPath = encodeURIComponent(repoFullName);
        for (const file of files) {
          const res = await fetch(`https://gitlab.com/api/v4/projects/${projectPath}/repository/files/${encodeURIComponent(file)}?ref=${branch}`, {
            headers: { 'PRIVATE-TOKEN': this.getToken(gp) },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            found[file] = true;
            if (file === 'package.json') {
              const data: any = await res.json();
              if (data.content) {
                try { pkgJson = JSON.parse(Buffer.from(data.content, 'base64').toString()); } catch {}
              }
            }
          }
        }
      } else if (SELF_HOSTED_PROVIDERS.has(gp.provider)) {
        const apiBase = this.giteaApiBase(gp);
        for (const file of files) {
          const res = await fetch(`${apiBase}/repos/${repoFullName}/contents/${encodeURIComponent(file)}?ref=${branch}`, {
            headers: { 'Authorization': `token ${this.getToken(gp)}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            found[file] = true;
            if (file === 'package.json') {
              const data: any = await res.json();
              if (data.content) {
                try { pkgJson = JSON.parse(Buffer.from(data.content, 'base64').toString()); } catch {}
              }
            }
          }
        }
      }
    } catch {}

    const hasCompose = found['docker-compose.yml'] || found['docker-compose.yaml'] || found['compose.yml'] || found['compose.yaml'];
    const hasDockerfile = found['Dockerfile'];
    const hasPackageJson = found['package.json'];

    let framework = 'STATIC';
    let buildCommand = '';
    let startCommand = '';
    let port = 3000;

    if (hasCompose) {
      framework = 'DOCKER_COMPOSE';
    } else if (hasDockerfile) {
      framework = 'DOCKER';
    } else if (hasPackageJson && pkgJson) {
      const deps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
      if (deps['next']) { framework = 'NEXTJS'; buildCommand = 'npm run build'; startCommand = 'npm start'; }
      else if (deps['@nestjs/core']) { framework = 'NESTJS'; buildCommand = 'npm run build'; startCommand = 'npm run start:prod'; port = 3000; }
      else if (deps['@angular/core']) { framework = 'ANGULAR'; buildCommand = 'npm run build'; startCommand = 'npm start'; port = 4200; }
      else if (deps['vue']) { framework = 'VUE'; buildCommand = 'npm run build'; startCommand = 'npm run preview'; }
      else if (deps['react']) { framework = 'REACT'; buildCommand = 'npm run build'; startCommand = 'npm start'; }
      else if (deps['express']) { framework = 'EXPRESS'; buildCommand = 'npm install'; startCommand = pkgJson.scripts?.start || 'node index.js'; }
      else { framework = 'EXPRESS'; buildCommand = pkgJson.scripts?.build ? 'npm run build' : ''; startCommand = pkgJson.scripts?.start || 'node index.js'; }
    } else if (found['requirements.txt']) {
      framework = 'FLASK';
      buildCommand = 'pip install -r requirements.txt';
      startCommand = 'python app.py';
      port = 5000;
    } else if (found['composer.json']) {
      framework = 'LARAVEL';
      port = 8000;
    }

    // Surface the repo's declared env vars so the deploy dialog can prefill
    // the Advanced editor — the user configures everything BEFORE the first
    // deploy instead of discovering missing vars from a broken build.
    // .env.example is the convention for "here's what you must set"; fall
    // back to a committed .env when there's no example file.
    const envVars: Array<{ key: string; defaultValue: string }> = [];
    for (const candidate of ['.env.example', '.env.sample', '.env']) {
      const file = await this.fetchFile(id, userId, repoFullName, branch, candidate);
      if (!file.exists || !file.content) continue;
      for (const rawLine of file.content.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.trimStart().startsWith('#')) continue;
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        envVars.push({ key: m[1], defaultValue: val });
      }
      break; // first file found wins — don't merge example with committed .env
    }

    return {
      framework,
      buildCommand,
      startCommand,
      port,
      hasCompose,
      hasDockerfile,
      hasPackageJson,
      detectedFiles: Object.keys(found),
      envVars,
    };
  }

  async fetchFile(id: string, userId: string, repoFullName: string, branch: string, filePath: string): Promise<{ content: string; exists: boolean }> {
    const gp = await this.prisma.gitProvider.findFirst({ where: { id, userId } });
    if (!gp) throw new NotFoundException('Provider not found');
    try {
      if (gp.provider === 'GITHUB') {
        const res = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(filePath)}?ref=${branch}`, {
          headers: { 'Authorization': `Bearer ${this.getToken(gp)}`, 'Accept': 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { content: '', exists: false };
        const data: any = await res.json();
        if (!data?.content) return { content: '', exists: true };
        return { content: Buffer.from(data.content, 'base64').toString(), exists: true };
      }
      if (gp.provider === 'GITLAB') {
        const projectPath = encodeURIComponent(repoFullName);
        const res = await fetch(`https://gitlab.com/api/v4/projects/${projectPath}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${branch}`, {
          headers: { 'PRIVATE-TOKEN': this.getToken(gp) },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { content: '', exists: false };
        return { content: await res.text(), exists: true };
      }
      if (gp.provider === 'BITBUCKET') {
        const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${repoFullName}/src/${branch}/${filePath}`, {
          headers: { 'Authorization': `Bearer ${this.getToken(gp)}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { content: '', exists: false };
        return { content: await res.text(), exists: true };
      }
      if (SELF_HOSTED_PROVIDERS.has(gp.provider)) {
        const apiBase = this.giteaApiBase(gp);
        const res = await fetch(`${apiBase}/repos/${repoFullName}/contents/${encodeURIComponent(filePath)}?ref=${branch}`, {
          headers: { 'Authorization': `token ${this.getToken(gp)}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { content: '', exists: false };
        const data: any = await res.json();
        if (!data?.content) return { content: '', exists: true };
        return { content: Buffer.from(data.content, 'base64').toString(), exists: true };
      }
    } catch {}
    return { content: '', exists: false };
  }

  async listRepos(id: string, userId: string): Promise<Repo[]> {
    const gp = await this.prisma.gitProvider.findFirst({ where: { id, userId } });
    if (!gp) throw new NotFoundException('Provider not found');

    try {
      const token = this.getToken(gp);
      if (gp.provider === 'GITHUB') return await this.fetchGitHubRepos(token);
      if (gp.provider === 'GITLAB') return await this.fetchGitLabRepos(token);
      if (gp.provider === 'BITBUCKET') return await this.fetchBitbucketRepos(token);
      if (SELF_HOSTED_PROVIDERS.has(gp.provider)) {
        return await this.fetchGiteaRepos(this.giteaApiBase(gp), token);
      }
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to fetch repos');
    }
    return [];
  }

  /**
   * List the branches of a repo via the provider API. Same dispatch shape as
   * {@link listRepos}. Used by the branch picker so the user chooses a real
   * branch instead of free-typing one that doesn't exist. Returns the default
   * branch first-class via `isDefault` so the UI can pre-select it.
   */
  async listBranches(id: string, userId: string, repoFullName: string): Promise<Branch[]> {
    const gp = await this.prisma.gitProvider.findFirst({ where: { id, userId } });
    if (!gp) throw new NotFoundException('Provider not found');
    const token = this.getToken(gp);
    // Cap the page walk so a repo with thousands of branches can't hang the
    // request (10 pages × 100 = 1000 branches, far past any picker's usefulness).
    const MAX_PAGES = 10;
    try {
      if (gp.provider === 'GITHUB') {
        const names: string[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const res = await fetch(
            `https://api.github.com/repos/${repoFullName}/branches?per_page=100&page=${page}`,
            {
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
          const data: any[] = await res.json();
          for (const b of data) names.push(b.name);
          if (data.length < 100) break; // last page
        }
        // GitHub's branch list doesn't flag the default; fetch it once to mark it.
        const def = await this.fetchDefaultBranch(gp.provider, repoFullName, token);
        return names.map((name) => ({ name, isDefault: name === def }));
      }
      if (gp.provider === 'GITLAB') {
        const projectPath = encodeURIComponent(repoFullName);
        const out: Branch[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const res = await fetch(
            `https://gitlab.com/api/v4/projects/${projectPath}/repository/branches?per_page=100&page=${page}`,
            { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(10_000) },
          );
          if (!res.ok) throw new Error(`GitLab API: ${res.status}`);
          const data: any[] = await res.json();
          for (const b of data) out.push({ name: b.name, isDefault: !!b.default });
          if (data.length < 100) break;
        }
        return out;
      }
      if (gp.provider === 'BITBUCKET') {
        const names: string[] = [];
        // Bitbucket paginates via an absolute `next` URL rather than a page param.
        let next: string | null =
          `https://api.bitbucket.org/2.0/repositories/${repoFullName}/refs/branches?pagelen=100`;
        for (let page = 0; page < MAX_PAGES && next; page++) {
          const res = await fetch(next, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`Bitbucket API: ${res.status}`);
          const data: any = await res.json();
          for (const b of data.values || []) names.push(b.name);
          next = typeof data.next === 'string' ? data.next : null;
        }
        const def = await this.fetchDefaultBranch(gp.provider, repoFullName, token);
        return names.map((name) => ({ name, isDefault: name === def }));
      }
      if (SELF_HOSTED_PROVIDERS.has(gp.provider)) {
        const apiBase = this.giteaApiBase(gp);
        const names: string[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const res = await fetch(
            `${apiBase}/repos/${repoFullName}/branches?limit=50&page=${page}`,
            { headers: { Authorization: `token ${token}` }, signal: AbortSignal.timeout(10_000) },
          );
          if (!res.ok) throw new Error(`Gitea API: ${res.status}`);
          const data: any[] = await res.json();
          for (const b of data) names.push(b.name);
          if (data.length < 50) break;
        }
        const def = await this.fetchDefaultBranch(gp.provider, repoFullName, token, apiBase);
        return names.map((name) => ({ name, isDefault: name === def }));
      }
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to fetch branches');
    }
    return [];
  }

  /** Best-effort default-branch lookup (GitHub/Bitbucket/Gitea don't flag it inline). */
  private async fetchDefaultBranch(
    provider: string,
    repoFullName: string,
    token: string,
    apiBase?: string,
  ): Promise<string | null> {
    try {
      if (provider === 'GITHUB') {
        const res = await fetch(`https://api.github.com/repos/${repoFullName}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        return (await res.json())?.default_branch ?? null;
      }
      if (provider === 'BITBUCKET') {
        const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${repoFullName}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        return (await res.json())?.mainbranch?.name ?? null;
      }
      if (SELF_HOSTED_PROVIDERS.has(provider) && apiBase) {
        const res = await fetch(`${apiBase}/repos/${repoFullName}`, {
          headers: { Authorization: `token ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        return (await res.json())?.default_branch ?? null;
      }
    } catch {}
    return null;
  }

  /**
   * Create a push webhook on the provider so a `git push` auto-triggers a
   * redeploy — no manual copy-paste of the URL/secret into the provider UI.
   *
   * Idempotent WITHOUT a migration: we first GET the existing hooks. If one
   * already points at our `url`, we UPDATE it with the current secret (so a
   * rotated secret stays in sync between platform and provider rather than
   * silently drifting); otherwise we POST a new hook subscribed to push events.
   *
   * The `secret` is the SAME value the receiver verifies (HMAC for
   * GitHub/Bitbucket, shared token for GitLab). Token scope matters: GitHub
   * needs `admin:repo_hook` (covered by the `repo` scope we request), GitLab
   * needs `api`, Bitbucket needs `webhook`. A scope/permission failure surfaces
   * as a readable BadRequestException.
   */
  async registerWebhook(
    id: string,
    userId: string,
    repoFullName: string,
    url: string,
    secret: string,
  ): Promise<{ created: boolean; alreadyExists: boolean }> {
    const gp = await this.prisma.gitProvider.findFirst({ where: { id, userId } });
    if (!gp) throw new NotFoundException('Provider not found');
    const token = this.getToken(gp);

    try {
      if (gp.provider === 'GITHUB') {
        const base = `https://api.github.com/repos/${repoFullName}/hooks`;
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
        const existing = await fetch(`${base}?per_page=100`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        const config = { url, content_type: 'json', secret, insecure_ssl: '0' };
        if (existing.ok) {
          const hooks: any[] = await existing.json();
          const mine = hooks.find((h) => h?.config?.url === url);
          if (mine) {
            // Re-sync the secret (e.g. after a rotate) instead of leaving it stale.
            const upd = await fetch(`${base}/${mine.id}`, {
              method: 'PATCH',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ active: true, events: ['push'], config }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!upd.ok) throw new Error(await this.hookError(upd, 'GitHub'));
            return { created: false, alreadyExists: true };
          }
        }
        const res = await fetch(base, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'web', active: true, events: ['push'], config }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(await this.hookError(res, 'GitHub'));
        return { created: true, alreadyExists: false };
      }

      if (gp.provider === 'GITLAB') {
        const projectPath = encodeURIComponent(repoFullName);
        const base = `https://gitlab.com/api/v4/projects/${projectPath}/hooks`;
        const headers = { 'PRIVATE-TOKEN': token };
        const body = {
          url,
          token: secret,
          push_events: true,
          enable_ssl_verification: true,
        };
        const existing = await fetch(`${base}?per_page=100`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (existing.ok) {
          const hooks: any[] = await existing.json();
          const mine = hooks.find((h) => h?.url === url);
          if (mine) {
            const upd = await fetch(`${base}/${mine.id}`, {
              method: 'PUT',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(10_000),
            });
            if (!upd.ok) throw new Error(await this.hookError(upd, 'GitLab'));
            return { created: false, alreadyExists: true };
          }
        }
        const res = await fetch(base, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(await this.hookError(res, 'GitLab'));
        return { created: true, alreadyExists: false };
      }

      if (gp.provider === 'BITBUCKET') {
        const base = `https://api.bitbucket.org/2.0/repositories/${repoFullName}/hooks`;
        const headers = { Authorization: `Bearer ${token}` };
        const body = {
          description: 'Kryptalis auto-deploy',
          url,
          active: true,
          events: ['repo:push'],
          secret,
        };
        const existing = await fetch(`${base}?pagelen=100`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (existing.ok) {
          const data: any = await existing.json();
          const mine = (data.values || []).find((h: any) => h?.url === url);
          if (mine?.uuid) {
            const upd = await fetch(`${base}/${encodeURIComponent(mine.uuid)}`, {
              method: 'PUT',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(10_000),
            });
            if (!upd.ok) throw new Error(await this.hookError(upd, 'Bitbucket'));
            return { created: false, alreadyExists: true };
          }
        }
        const res = await fetch(base, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(await this.hookError(res, 'Bitbucket'));
        return { created: true, alreadyExists: false };
      }

      if (SELF_HOSTED_PROVIDERS.has(gp.provider)) {
        const apiBase = this.giteaApiBase(gp);
        const base = `${apiBase}/repos/${repoFullName}/hooks`;
        const headers = { Authorization: `token ${token}` };
        // Gitea/Forgejo hook shape mirrors GitHub's: type 'gitea', config map.
        const body = {
          type: 'gitea',
          active: true,
          events: ['push'],
          config: { url, content_type: 'json', secret },
        };
        const existing = await fetch(`${base}?limit=50`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (existing.ok) {
          const hooks: any[] = await existing.json();
          const mine = hooks.find((h) => h?.config?.url === url);
          if (mine?.id != null) {
            const upd = await fetch(`${base}/${mine.id}`, {
              method: 'PATCH',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ active: true, events: ['push'], config: body.config }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!upd.ok) throw new Error(await this.hookError(upd, 'Gitea'));
            return { created: false, alreadyExists: true };
          }
        }
        const res = await fetch(base, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(await this.hookError(res, 'Gitea'));
        return { created: true, alreadyExists: false };
      }
    } catch (err: any) {
      if (err instanceof NotFoundException || err instanceof BadRequestException) throw err;
      throw new BadRequestException(err?.message || 'Failed to register webhook');
    }
    throw new BadRequestException(`Webhook auto-registration not supported for ${gp.provider}`);
  }

  /** Build a readable error from a failed hook API response. */
  private async hookError(res: Response, provider: string): Promise<string> {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {}
    if (res.status === 401 || res.status === 403) {
      return `${provider} rejected the webhook (${res.status}). The connected token is missing the permission to manage webhooks.`;
    }
    if (res.status === 404) {
      return `${provider} returned 404 — the repo wasn't found or the token can't access it.`;
    }
    return `${provider} webhook API error ${res.status}${detail ? `: ${detail}` : ''}`;
  }

  private async fetchUserInfo(
    provider: string,
    token: string,
    baseUrl?: string | null,
  ): Promise<{ username: string; avatarUrl: string } | null> {
    try {
      if (provider === 'GITHUB') {
        const res = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return { username: data.login, avatarUrl: data.avatar_url };
      }
      if (provider === 'GITLAB') {
        const res = await fetch('https://gitlab.com/api/v4/user', {
          headers: { 'PRIVATE-TOKEN': token },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return { username: data.username, avatarUrl: data.avatar_url };
      }
      if (provider === 'BITBUCKET') {
        const res = await fetch('https://api.bitbucket.org/2.0/user', {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return { username: data.username || data.display_name, avatarUrl: data.links?.avatar?.href || '' };
      }
      if (SELF_HOSTED_PROVIDERS.has(provider)) {
        // Gitea/Forgejo mirror the GitHub REST API under /api/v1. The baseUrl
        // was already screened at create()/giteaApiBase time.
        const apiBase = `${(baseUrl || '').replace(/\/+$/, '')}/api/v1`;
        const res = await fetch(`${apiBase}/user`, {
          headers: { 'Authorization': `token ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return { username: data.login || data.username, avatarUrl: data.avatar_url || '' };
      }
    } catch {}
    return null;
  }

  private async fetchGiteaRepos(apiBase: string, token: string): Promise<Repo[]> {
    const out: Repo[] = [];
    const MAX_PAGES = 10;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(`${apiBase}/user/repos?limit=50&page=${page}`, {
        headers: { 'Authorization': `token ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Gitea API: ${res.status}`);
      const data: any[] = await res.json();
      for (const r of data) {
        out.push({
          name: r.name,
          fullName: r.full_name,
          url: r.clone_url,
          private: r.private,
          defaultBranch: r.default_branch || 'main',
          updatedAt: r.updated_at,
          description: r.description,
          language: r.language || '',
        });
      }
      if (data.length < 50) break;
    }
    return out;
  }

  private async fetchGitHubRepos(token: string): Promise<Repo[]> {
    const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
    const data: any[] = await res.json();
    return data.map(r => ({
      name: r.name,
      fullName: r.full_name,
      url: r.clone_url,
      private: r.private,
      defaultBranch: r.default_branch,
      updatedAt: r.updated_at,
      description: r.description,
      language: r.language,
    }));
  }

  private async fetchGitLabRepos(token: string): Promise<Repo[]> {
    const res = await fetch('https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at', {
      headers: { 'PRIVATE-TOKEN': token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitLab API: ${res.status}`);
    const data: any[] = await res.json();
    return data.map(r => ({
      name: r.name,
      fullName: r.path_with_namespace,
      url: r.http_url_to_repo,
      private: r.visibility === 'private',
      defaultBranch: r.default_branch || 'main',
      updatedAt: r.last_activity_at,
      description: r.description,
      language: '',
    }));
  }

  private async fetchBitbucketRepos(token: string): Promise<Repo[]> {
    const res = await fetch('https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100&sort=-updated_on', {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Bitbucket API: ${res.status}`);
    const data: any = await res.json();
    return (data.values || []).map((r: any) => ({
      name: r.name,
      fullName: r.full_name,
      url: r.links?.clone?.find((c: any) => c.name === 'https')?.href || '',
      private: r.is_private,
      defaultBranch: r.mainbranch?.name || 'main',
      updatedAt: r.updated_on,
      description: r.description,
      language: r.language,
    }));
  }
}
