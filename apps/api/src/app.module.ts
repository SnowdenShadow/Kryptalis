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
        // All these env vars are now ADMIN-MANAGED through the Admin UI's
        // System Config tab. docker-compose passes them as empty strings
        // (`${SMTP_HOST:-}`) when not set, which Joi normally rejects even
        // on .optional() — we use .allow('').optional() everywhere so the
        // bootstrap doesn't break when the operator hasn't yet visited the
        // Admin UI to fill them in.
        BACKUP_ENCRYPTION_KEY: Joi.string().min(32).allow('').optional(),
        CORS_ORIGINS: Joi.string().allow('').optional(),
        SWAGGER_PUBLIC: Joi.string().allow('').optional(),
        SMTP_HOST: Joi.string().allow('').optional(),
        // Number() rejects empty string; use Joi.alternatives so both '' and
        // a real number are accepted.
        SMTP_PORT: Joi.alternatives().try(Joi.number(), Joi.string().allow('')).optional(),
        SMTP_USER: Joi.string().allow('').optional(),
        SMTP_PASS: Joi.string().allow('').optional(),
        SMTP_FROM: Joi.string().allow('').optional(),
        PUBLIC_DASHBOARD_URL: Joi.alternatives().try(Joi.string().uri(), Joi.string().allow('')).optional(),
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
