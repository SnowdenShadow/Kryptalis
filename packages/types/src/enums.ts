export enum ServerStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  PROVISIONING = 'provisioning',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
}

export enum DeploymentStatus {
  PENDING = 'pending',
  BUILDING = 'building',
  DEPLOYING = 'deploying',
  RUNNING = 'running',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  ROLLING_BACK = 'rolling_back',
  ROLLED_BACK = 'rolled_back',
}

export enum ApplicationStatus {
  RUNNING = 'running',
  STOPPED = 'stopped',
  BUILDING = 'building',
  DEPLOYING = 'deploying',
  ERROR = 'error',
  UNKNOWN = 'unknown',
}

export enum ContainerStatus {
  RUNNING = 'running',
  STOPPED = 'stopped',
  RESTARTING = 'restarting',
  PAUSED = 'paused',
  EXITED = 'exited',
  DEAD = 'dead',
}

export enum DomainStatus {
  ACTIVE = 'active',
  PENDING = 'pending',
  ERROR = 'error',
}

export enum SSLStatus {
  ACTIVE = 'active',
  PENDING = 'pending',
  EXPIRED = 'expired',
  ERROR = 'error',
}

export enum BackupStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum BackupTarget {
  LOCAL = 'local',
  S3 = 's3',
  R2 = 'r2',
  B2 = 'b2',
}

export enum DatabaseType {
  POSTGRESQL = 'postgresql',
  MYSQL = 'mysql',
  MARIADB = 'mariadb',
  REDIS = 'redis',
  MONGODB = 'mongodb',
}

export enum GitProvider {
  GITHUB = 'github',
  GITLAB = 'gitlab',
  BITBUCKET = 'bitbucket',
  FORGEJO = 'forgejo',
  GITEA = 'gitea',
}

export enum AppFramework {
  NEXTJS = 'nextjs',
  REACT = 'react',
  VUE = 'vue',
  ANGULAR = 'angular',
  NESTJS = 'nestjs',
  EXPRESS = 'express',
  LARAVEL = 'laravel',
  SYMFONY = 'symfony',
  DJANGO = 'django',
  FLASK = 'flask',
  FASTAPI = 'fastapi',
  STATIC = 'static',
  DOCKER = 'docker',
  DOCKER_COMPOSE = 'docker_compose',
}

export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
  VIEWER = 'viewer',
}

export enum TaskType {
  DEPLOY = 'deploy',
  BUILD = 'build',
  RESTART = 'restart',
  STOP = 'stop',
  BACKUP = 'backup',
  SSL_ISSUE = 'ssl_issue',
  SSL_RENEW = 'ssl_renew',
  DNS_UPDATE = 'dns_update',
  MONITOR = 'monitor',
}

export enum TaskStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum AlertChannel {
  EMAIL = 'email',
  DISCORD = 'discord',
  SLACK = 'slack',
  WEBHOOK = 'webhook',
}

export enum DNSRecordType {
  A = 'A',
  AAAA = 'AAAA',
  CNAME = 'CNAME',
  TXT = 'TXT',
  MX = 'MX',
  CAA = 'CAA',
  SRV = 'SRV',
}
