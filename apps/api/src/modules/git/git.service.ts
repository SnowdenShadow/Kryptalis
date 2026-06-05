import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const GIT_PROVIDERS = [
  { id: 'github', name: 'GitHub', url: 'https://github.com' },
  { id: 'gitlab', name: 'GitLab', url: 'https://gitlab.com' },
  { id: 'bitbucket', name: 'Bitbucket', url: 'https://bitbucket.org' },
  { id: 'forgejo', name: 'Forgejo', url: '' },
  { id: 'gitea', name: 'Gitea', url: '' },
];

@Injectable()
export class GitService {
  constructor(private prisma: PrismaService) {}

  getProviders() { return GIT_PROVIDERS; }

  async handleWebhook(applicationId: string, _payload: any) {
    const app = await this.prisma.application.findUnique({ where: { id: applicationId } });
    if (!app) throw new NotFoundException('Application not found');

    const deployment = await this.prisma.deployment.create({
      data: {
        applicationId,
        commitSha: _payload?.head_commit?.id || _payload?.after || null,
        commitMessage: _payload?.head_commit?.message || null,
        triggeredById: (await this.prisma.user.findFirst())?.id || '',
      },
    });

    return { message: 'Deployment triggered', deploymentId: deployment.id };
  }
}
