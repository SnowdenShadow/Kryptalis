import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
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

@Injectable()
export class GitProvidersService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateGitProviderDto) {
    const userInfo = await this.fetchUserInfo(dto.provider, dto.token);
    if (!userInfo) throw new BadRequestException('Invalid token or unable to fetch user info');

    return this.prisma.gitProvider.create({
      data: {
        userId,
        provider: dto.provider,
        name: dto.name,
        token: dto.token,
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
            headers: { 'Authorization': `Bearer ${gp.token}`, 'Accept': 'application/vnd.github+json' },
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
            headers: { 'PRIVATE-TOKEN': gp.token },
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

    return {
      framework,
      buildCommand,
      startCommand,
      port,
      hasCompose,
      hasDockerfile,
      hasPackageJson,
      detectedFiles: Object.keys(found),
    };
  }

  async fetchFile(id: string, userId: string, repoFullName: string, branch: string, filePath: string): Promise<{ content: string; exists: boolean }> {
    const gp = await this.prisma.gitProvider.findFirst({ where: { id, userId } });
    if (!gp) throw new NotFoundException('Provider not found');
    try {
      if (gp.provider === 'GITHUB') {
        const res = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(filePath)}?ref=${branch}`, {
          headers: { 'Authorization': `Bearer ${gp.token}`, 'Accept': 'application/vnd.github+json' },
        });
        if (!res.ok) return { content: '', exists: false };
        const data: any = await res.json();
        if (!data?.content) return { content: '', exists: true };
        return { content: Buffer.from(data.content, 'base64').toString(), exists: true };
      }
      if (gp.provider === 'GITLAB') {
        const projectPath = encodeURIComponent(repoFullName);
        const res = await fetch(`https://gitlab.com/api/v4/projects/${projectPath}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${branch}`, {
          headers: { 'PRIVATE-TOKEN': gp.token },
        });
        if (!res.ok) return { content: '', exists: false };
        return { content: await res.text(), exists: true };
      }
      if (gp.provider === 'BITBUCKET') {
        const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${repoFullName}/src/${branch}/${filePath}`, {
          headers: { 'Authorization': `Bearer ${gp.token}` },
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
      if (gp.provider === 'GITHUB') return await this.fetchGitHubRepos(gp.token);
      if (gp.provider === 'GITLAB') return await this.fetchGitLabRepos(gp.token);
      if (gp.provider === 'BITBUCKET') return await this.fetchBitbucketRepos(gp.token);
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
