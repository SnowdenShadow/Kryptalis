import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { COMPOSE_TEMPLATES, PORT_MAP } from './templates';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export interface MarketplaceApp {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  icon: string;
  version: string;
  ports: number[];
}

const APPS: MarketplaceApp[] = [
  { id: '1', name: 'Portainer', slug: 'portainer', description: 'Container management UI', category: 'DevOps', icon: 'container', version: '2.21', ports: [9443] },
  { id: '2', name: 'Grafana', slug: 'grafana', description: 'Observability dashboards', category: 'DevOps', icon: 'chart', version: '11.0', ports: [3001] },
  { id: '3', name: 'Uptime Kuma', slug: 'uptime-kuma', description: 'Self-hosted monitoring tool', category: 'DevOps', icon: 'heartbeat', version: '1.23', ports: [3002] },
  { id: '4', name: 'n8n', slug: 'n8n', description: 'Workflow automation', category: 'Automation', icon: 'workflow', version: '1.64', ports: [5678] },
  { id: '5', name: 'Supabase', slug: 'supabase', description: 'Open-source Firebase alternative', category: 'Backend', icon: 'lightning', version: '2.0', ports: [3003] },
  { id: '6', name: 'WordPress', slug: 'wordpress', description: 'Popular CMS', category: 'CMS', icon: 'edit', version: '6.6', ports: [8080] },
  { id: '7', name: 'Ghost', slug: 'ghost', description: 'Publishing platform', category: 'CMS', icon: 'ghost', version: '5.94', ports: [2368] },
  { id: '8', name: 'MinIO', slug: 'minio', description: 'S3-compatible object storage', category: 'Storage', icon: 'bucket', version: '2024', ports: [9001] },
  { id: '9', name: 'Nextcloud', slug: 'nextcloud', description: 'File hosting platform', category: 'Storage', icon: 'cloud', version: '29', ports: [8081] },
  { id: '10', name: 'PostgreSQL', slug: 'postgresql', description: 'Relational database', category: 'Databases', icon: 'database', version: '16', ports: [5433] },
  { id: '11', name: 'Redis', slug: 'redis', description: 'In-memory data store', category: 'Databases', icon: 'zap', version: '7.4', ports: [6380] },
  { id: '12', name: 'Appwrite', slug: 'appwrite', description: 'Backend-as-a-Service', category: 'Backend', icon: 'server', version: '1.6', ports: [8082] },

  // ── Email & webmail ─────────────────────────────────────────────
  { id: '13', name: 'Roundcube', slug: 'roundcube', description: 'Polished IMAP webmail client', category: 'Email', icon: 'mail', version: '1.6', ports: [8083] },
  { id: '14', name: 'SnappyMail', slug: 'snappymail', description: 'Modern lightweight webmail (Rainloop successor)', category: 'Email', icon: 'mail-check', version: '2.36', ports: [8084] },
  { id: '15', name: 'Rainloop', slug: 'rainloop', description: 'Legacy webmail client (read-only fork)', category: 'Email', icon: 'inbox', version: '1.16', ports: [8085] },
  { id: '16', name: 'Mailpit', slug: 'mailpit', description: 'SMTP testing tool with web UI — catches outgoing mail in dev', category: 'Email', icon: 'send', version: '1.20', ports: [8086, 1025] },
  { id: '17', name: 'Postal', slug: 'postal', description: 'Modern SMTP server alternative for transactional mail', category: 'Email', icon: 'server-cog', version: '3.0', ports: [8087] },
  { id: '18', name: 'Mailu', slug: 'mailu', description: 'Mail server admin panel — manage mailboxes & aliases', category: 'Email', icon: 'shield-mail', version: '2024.06', ports: [8088] },
];

const APPS_DIR = path.join(process.cwd(), '.kryptalis', 'apps');

@Injectable()
export class MarketplaceService {
  constructor(private prisma: PrismaService) {
    if (!fs.existsSync(APPS_DIR)) {
      fs.mkdirSync(APPS_DIR, { recursive: true });
    }
  }

  listApps() { return APPS; }

  getApp(slug: string) {
    const app = APPS.find((a) => a.slug === slug);
    if (!app) throw new NotFoundException('App not found');
    return app;
  }

  async install(
    data: {
      appSlug: string;
      serverId: string;
      projectId: string;
      domainId?: string;
      port?: number;
      envVars?: Record<string, string>;
    },
    userId?: string,
  ) {
    const app = this.getApp(data.appSlug);
    const template = COMPOSE_TEMPLATES[data.appSlug];
    if (!template) throw new NotFoundException(`No template for ${app.name}`);

    const existing = await this.prisma.application.findFirst({
      where: { name: app.name, projectId: data.projectId },
    });
    if (existing) {
      throw new ConflictException(`${app.name} is already installed in this project`);
    }

    const realPort = data.port || PORT_MAP[data.appSlug] || app.ports[0];

    // Pre-compute auto-resolved values for webmail-style apps that need to
    // point at an existing Kryptalis mail server. The compose template is
    // patched on the fly with these substitutions.
    let composeContent = template.compose;
    if (
      (data.appSlug === 'roundcube' ||
        data.appSlug === 'snappymail' ||
        data.appSlug === 'rainloop') &&
      data.domainId
    ) {
      const mailServer = await this.prisma.mailServer.findUnique({
        where: { domainId: data.domainId },
      });
      const domain = await this.prisma.domain.findUnique({
        where: { id: data.domainId },
      });
      if (mailServer && domain) {
        // For docker-internal access we use host.docker.internal:<actual-port>.
        // Roundcube env vars accept tls:// + host + port.
        const imapHost = `host.docker.internal`;
        const smtpHost = `host.docker.internal`;
        composeContent = composeContent
          .replace(
            /ROUNDCUBEMAIL_DEFAULT_HOST: tls:\/\/host\.docker\.internal/g,
            `ROUNDCUBEMAIL_DEFAULT_HOST: tls://${imapHost}`,
          )
          .replace(
            /ROUNDCUBEMAIL_DEFAULT_PORT: "993"/g,
            `ROUNDCUBEMAIL_DEFAULT_PORT: "${mailServer.imapsPort}"`,
          )
          .replace(
            /ROUNDCUBEMAIL_SMTP_SERVER: tls:\/\/host\.docker\.internal/g,
            `ROUNDCUBEMAIL_SMTP_SERVER: tls://${smtpHost}`,
          )
          .replace(
            /ROUNDCUBEMAIL_SMTP_PORT: "587"/g,
            `ROUNDCUBEMAIL_SMTP_PORT: "${mailServer.submissionPort}"`,
          );
      }
    }

    // Custom env override from the install request — written as a .env file alongside compose
    const envOverride = data.envVars || {};

    const application = await this.prisma.application.create({
      data: {
        name: app.name,
        projectId: data.projectId,
        framework: 'DOCKER_COMPOSE',
        status: 'DEPLOYING',
        port: realPort,
      },
    });

    if (data.domainId) {
      await this.prisma.domain.update({
        where: { id: data.domainId },
        data: { applicationId: application.id },
      });
    }

    const task = await this.prisma.agentTask.create({
      data: {
        serverId: data.serverId,
        type: 'DEPLOY',
        status: 'RUNNING',
        startedAt: new Date(),
        payload: {
          appSlug: app.slug,
          appName: app.name,
          applicationId: application.id,
          ports: app.ports,
        },
      },
    });

    if (userId) {
      await this.prisma.deployment.create({
        data: {
          applicationId: application.id,
          status: 'DEPLOYING',
          commitMessage: `Install ${app.name} v${app.version} from Marketplace`,
          triggeredById: userId,
          startedAt: new Date(),
        },
      });
    }

    this.runDockerCompose(data.appSlug, composeContent, application.id, task.id, envOverride);

    return {
      message: `Installing ${app.name}...`,
      taskId: task.id,
      applicationId: application.id,
      app,
    };
  }

  async uninstall(appSlug: string) {
    const appDir = path.join(APPS_DIR, appSlug);
    if (fs.existsSync(appDir)) {
      try {
        await execAsync('docker compose down -v', { cwd: appDir });
      } catch {}
    }
  }

  private async runDockerCompose(
    slug: string,
    compose: string,
    applicationId: string,
    taskId: string,
    envOverride: Record<string, string> = {},
  ) {
    const appDir = path.join(APPS_DIR, slug);
    if (!fs.existsSync(appDir)) {
      fs.mkdirSync(appDir, { recursive: true });
    }
    fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);

    // user-supplied envVars → written as .env (picked up by docker compose at runtime)
    if (Object.keys(envOverride).length > 0) {
      const envContent = Object.entries(envOverride)
        .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`)
        .join('\n') + '\n';
      fs.writeFileSync(path.join(appDir, '.env'), envContent);
    }

    try {
      await execAsync('docker compose pull', { cwd: appDir, timeout: 120000 });
      await execAsync('docker compose up -d', { cwd: appDir, timeout: 60000 });

      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { status: 'RUNNING' },
      });
      await this.prisma.deployment.updateMany({
        where: { applicationId, status: 'DEPLOYING' },
        data: { status: 'RUNNING', finishedAt: new Date() },
      });
    } catch (err: any) {
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { status: 'FAILED', error: err.message || 'Docker compose failed', completedAt: new Date() },
      });
      await this.prisma.deployment.updateMany({
        where: { applicationId, status: 'DEPLOYING' },
        data: { status: 'FAILED', finishedAt: new Date() },
      });
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { status: 'ERROR' },
      });
    }
  }
}
