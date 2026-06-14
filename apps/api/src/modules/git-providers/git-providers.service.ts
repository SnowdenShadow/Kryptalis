import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { CreateGitProviderDto } from './dto/create-git-provider.dto';

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

/**
 * Canonical SaaS clone hosts per provider. A GitProvider row has NO
 * host/baseUrl column (see schema), so self-hosted GitLab/GitHub Enterprise
 * cannot be host-pinned yet — only these canonical hosts are accepted.
 * Self-hosted support needs a `host` column on GitProvider (deferred).
 */
const PROVIDER_HOSTS: Record<string, string[]> = {
  GITHUB: ['github.com', 'api.github.com'],
  GITLAB: ['gitlab.com'],
  BITBUCKET: ['bitbucket.org'],
};

/**
 * Block clone targets that point at the loopback/link-local/private ranges
 * (SSRF). Used for the one-shot PAT path where there's no provider host to
 * pin against — we still refuse private/loopback literals.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  // IPv4 literal ranges: loopback, link-local, RFC1918.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  }
  return false;
}

/**
 * Enforce that a clone URL is safe to inject a decrypted git token into:
 * HTTPS only, and the host must match the selected provider's canonical
 * host. A member who points gitUrl at evil.example.com would otherwise
 * exfiltrate the victim's GitHub/GitLab/Bitbucket token (token exfil + SSRF).
 *
 * `provider` null/unknown (one-shot PAT path) → no provider host to pin, so
 * we only require HTTPS and a non-private/loopback host.
 *
 * Centralized here so the create path and the redeploy/webhook path can't
 * drift. Throws BadRequestException on any mismatch.
 */
export function assertCloneHostAllowed(provider: string | null | undefined, gitUrl: string): void {
  let url: URL;
  try {
    url = new URL(gitUrl);
  } catch {
    throw new BadRequestException('Invalid Git URL');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException('Git URL must use https');
  }
  const hostname = url.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(hostname)) {
    throw new BadRequestException('Git URL host is not allowed');
  }
  const allowed = provider ? PROVIDER_HOSTS[provider] : undefined;
  if (allowed && !allowed.includes(hostname)) {
    throw new BadRequestException('Git URL host does not match the selected provider');
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
  assertCloneHostAllowed(provider: string | null | undefined, gitUrl: string): void {
    assertCloneHostAllowed(provider, gitUrl);
  }

  async create(userId: string, dto: CreateGitProviderDto) {
    const userInfo = await this.fetchUserInfo(dto.provider, dto.token);
    if (!userInfo) throw new BadRequestException('Invalid token or unable to fetch user info');

    return this.prisma.gitProvider.create({
      data: {
        userId,
        provider: dto.provider,
        name: dto.name,
        token: this.encryption.encrypt(dto.token),
        username: userInfo.username,
        avatarUrl: userInfo.avatarUrl,
      },
      select: {
        id: true, provider: true, name: true, username: true, avatarUrl: true, createdAt: true,
      },
    });
  }

  async findAll(userId: string) {
    return this.prisma.gitProvider.findMany({
      where: { userId },
      select: {
        id: true, provider: true, name: true, username: true, avatarUrl: true, createdAt: true,
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
        });
        if (!res.ok) return { content: '', exists: false };
        return { content: await res.text(), exists: true };
      }
      if (gp.provider === 'BITBUCKET') {
        const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${repoFullName}/src/${branch}/${filePath}`, {
          headers: { 'Authorization': `Bearer ${this.getToken(gp)}` },
        });
        if (!res.ok) return { content: '', exists: false };
        return { content: await res.text(), exists: true };
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
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to fetch repos');
    }
    return [];
  }

  private async fetchUserInfo(provider: string, token: string): Promise<{ username: string; avatarUrl: string } | null> {
    try {
      if (provider === 'GITHUB') {
        const res = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return { username: data.login, avatarUrl: data.avatar_url };
      }
      if (provider === 'GITLAB') {
        const res = await fetch('https://gitlab.com/api/v4/user', {
          headers: { 'PRIVATE-TOKEN': token },
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return { username: data.username, avatarUrl: data.avatar_url };
      }
      if (provider === 'BITBUCKET') {
        const res = await fetch('https://api.bitbucket.org/2.0/user', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return { username: data.username || data.display_name, avatarUrl: data.links?.avatar?.href || '' };
      }
    } catch {}
    return null;
  }

  private async fetchGitHubRepos(token: string): Promise<Repo[]> {
    const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
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
