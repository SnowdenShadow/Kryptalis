import { Injectable } from '@nestjs/common';
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
}
