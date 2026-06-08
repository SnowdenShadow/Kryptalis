import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import * as Joi from 'joi';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ServersModule } from './modules/servers/servers.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { DomainsModule } from './modules/domains/domains.module';
import { DeploymentsModule } from './modules/deployments/deployments.module';
import { DockerModule } from './modules/docker/docker.module';
import { DatabasesModule } from './modules/databases/databases.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { BackupsModule } from './modules/backups/backups.module';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { AgentModule } from './modules/agent/agent.module';
import { DeploymentTargetModule } from './modules/deployment-target/deployment-target.module';
import { SslModule } from './modules/ssl/ssl.module';
import { GitModule } from './modules/git/git.module';
import { GitProvidersModule } from './modules/git-providers/git-providers.module';
import { AdminModule } from './modules/admin/admin.module';
import { FilesModule } from './modules/files/files.module';
import { EmailModule } from './modules/email/email.module';
import { ReverseProxyModule } from './modules/reverse-proxy/reverse-proxy.module';
import { SystemModule } from './modules/system/system.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        DATABASE_URL: Joi.string().required(),
        API_PORT: Joi.number().default(4000),
        JWT_SECRET: Joi.string().min(32).required(),
        JWT_REFRESH_SECRET: Joi.string().min(32).required(),
        JWT_EXPIRATION: Joi.string().default('15m'),
        JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
        ENCRYPTION_KEY: Joi.string().min(32).required(),
        // Optional — when set, backup dumps are AES-256-GCM encrypted at rest.
        // Deliberately separate from ENCRYPTION_KEY so backup access can be
        // siloed (e.g. only an ops-team member holds it, app secrets unaffected
        // if it leaks, and vice versa).
        BACKUP_ENCRYPTION_KEY: Joi.string().min(32).optional(),
        CORS_ORIGINS: Joi.string().optional(),
        SWAGGER_PUBLIC: Joi.string().optional(),
        // Notifications — all optional. If SMTP_HOST is unset the
        // NotificationsService silently degrades to a logged no-op so
        // dev/test environments work without an SMTP relay.
        SMTP_HOST: Joi.string().optional(),
        SMTP_PORT: Joi.number().optional(),
        SMTP_USER: Joi.string().optional(),
        SMTP_PASS: Joi.string().optional(),
        SMTP_FROM: Joi.string().optional(),
        // Used to render CTA links inside transactional email. Defaults
        // to localhost:3000 when unset so dev links still resolve.
        PUBLIC_DASHBOARD_URL: Joi.string().uri().optional(),
      }),
    }),
    // Global throttler — defaults are conservative; tight per-route limits
    // live next to the relevant controller (auth/login etc.). Registering
    // ThrottlerGuard via APP_GUARD activates it across the whole API.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    CryptoModule,
    AuthModule,
    UsersModule,
    ServersModule,
    ProjectsModule,
    ApplicationsModule,
    DomainsModule,
    DeploymentsModule,
    DockerModule,
    DatabasesModule,
    MonitoringModule,
    BackupsModule,
    MarketplaceModule,
    AgentModule,
    DeploymentTargetModule,
    SslModule,
    GitModule,
    GitProvidersModule,
    AdminModule,
    FilesModule,
    EmailModule,
    ReverseProxyModule,
    SystemModule,
    HealthModule,
    NotificationsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
