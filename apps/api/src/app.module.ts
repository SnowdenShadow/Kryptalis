import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import * as Joi from 'joi';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { MaintenanceGuard } from './common/guards/maintenance.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ServersModule } from './modules/servers/servers.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { ApplicationRepositoryModule } from './modules/applications/application-repository.module';
import { SchedulerModule } from './common/scheduler/scheduler.module';
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
import { SftpModule } from './modules/sftp/sftp.module';
import { TerminalModule } from './modules/terminal/terminal.module';
import { EmailModule } from './modules/email/email.module';
import { ReverseProxyModule } from './modules/reverse-proxy/reverse-proxy.module';
import { SystemModule } from './modules/system/system.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ProjectTransferModule } from './modules/project-transfer/project-transfer.module';
import { CronModule } from './modules/cron/cron.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        // Gates Swagger exposure (/api/docs) and refresh-token debug logging.
        NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
        DATABASE_URL: Joi.string().required(),
        API_PORT: Joi.number().default(4000),
        JWT_SECRET: Joi.string().min(32).required(),
        JWT_REFRESH_SECRET: Joi.string().min(32).required(),
        // .empty('') treats compose's `${VAR:-}` empty-string injection as
        // absent so the default actually applies (plain .default() only
        // covers missing keys and Joi rejects '' on a bare string()).
        JWT_EXPIRATION: Joi.string().empty('').default('15m'),
        JWT_REFRESH_EXPIRATION: Joi.string().empty('').default('7d'),
        ENCRYPTION_KEY: Joi.string().min(32).required(),
        // All these env vars are now ADMIN-MANAGED through the Admin UI's
        // System Config tab. docker-compose passes them as empty strings
        // (`${SMTP_HOST:-}`) when not set, which Joi normally rejects even
        // on .optional() — we use .allow('').optional() everywhere so the
        // bootstrap doesn't break when the operator hasn't yet visited the
        // Admin UI to fill them in.
        BACKUP_ENCRYPTION_KEY: Joi.string().min(32).allow('').optional(),
        CORS_ORIGINS: Joi.string().allow('').optional(),
        // Honor a literal '*' in CORS_ORIGINS together with credentials.
        // INSECURE (any-origin + cookies). Default off — '*' is ignored.
        ALLOW_INSECURE_CORS: Joi.string().allow('').optional(),
        SWAGGER_PUBLIC: Joi.string().allow('').optional(),
        // Background-scheduler leader flag. "false" → this replica runs no
        // schedulers (multi-replica follower). Default/unset → leader.
        SCHEDULER_ENABLED: Joi.string().allow('').optional(),
        SMTP_HOST: Joi.string().allow('').optional(),
        // Number() rejects empty string; use Joi.alternatives so both '' and
        // a real number are accepted.
        SMTP_PORT: Joi.alternatives().try(Joi.number(), Joi.string().allow('')).optional(),
        SMTP_USER: Joi.string().allow('').optional(),
        SMTP_PASS: Joi.string().allow('').optional(),
        SMTP_FROM: Joi.string().allow('').optional(),
        PUBLIC_DASHBOARD_URL: Joi.alternatives().try(Joi.string().uri(), Joi.string().allow('')).optional(),
        // Gates the refresh-cookie Secure flag + CORS allowlist derivation.
        // compose injects `${PUBLIC_API_URL:-http://localhost:4000}` so it's
        // normally a URL, but keep the compose empty-string convention.
        PUBLIC_API_URL: Joi.alternatives().try(Joi.string().uri(), Joi.string().allow('')).optional(),
      }),
    }),
    // Global throttler — defaults are conservative; tight per-route limits
    // live next to the relevant controller (auth/login etc.). Registering
    // ThrottlerGuard via APP_GUARD activates it across the whole API.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    CryptoModule,
    ApplicationRepositoryModule,
    SchedulerModule,
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
    SftpModule,
    TerminalModule,
    EmailModule,
    ReverseProxyModule,
    SystemModule,
    HealthModule,
    NotificationsModule,
    ProjectTransferModule,
    CronModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Maintenance gate AFTER the throttler: rate-limit first, then 503
    // non-admin writes when `maintenance_mode` is on. The flag is cached
    // in memory (SystemConfigService.onChange) — no DB hit per request.
    { provide: APP_GUARD, useClass: MaintenanceGuard },
  ],
})
export class AppModule {}
