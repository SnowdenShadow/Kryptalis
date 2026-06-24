// Mirrors of the Prisma enums (apps/api/prisma/schema.prisma).
//
// Values are UPPERCASE strings because that is what the API actually
// serializes — the previous lowercase values ('running', 'deploy') never
// matched a real API response, which is why nothing consumed this package.
// Keep these in sync with schema.prisma when adding values.

export enum ServerStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  PROVISIONING = 'PROVISIONING',
  PENDING_INSTALL = 'PENDING_INSTALL',
  MAINTENANCE = 'MAINTENANCE',
  ERROR = 'ERROR',
}

export enum DeploymentStatus {
  PENDING = 'PENDING',
  BUILDING = 'BUILDING',
  DEPLOYING = 'DEPLOYING',
  RUNNING = 'RUNNING',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  ROLLING_BACK = 'ROLLING_BACK',
  ROLLED_BACK = 'ROLLED_BACK',
}

export enum ApplicationStatus {
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  BUILDING = 'BUILDING',
  DEPLOYING = 'DEPLOYING',
  ERROR = 'ERROR',
  UNKNOWN = 'UNKNOWN',
}

// Docker container states (docker inspect .State.Status) — these ARE
// lowercase on the wire, that's Docker's format, not Prisma's.
export enum ContainerStatus {
  CREATED = 'created',
  RUNNING = 'running',
  STOPPED = 'stopped',
  RESTARTING = 'restarting',
  REMOVING = 'removing',
  PAUSED = 'paused',
  EXITED = 'exited',
  DEAD = 'dead',
}

export enum DomainStatus {
  ACTIVE = 'ACTIVE',
  PENDING = 'PENDING',
  ERROR = 'ERROR',
}

export enum SSLStatus {
  ACTIVE = 'ACTIVE',
  PENDING = 'PENDING',
  EXPIRED = 'EXPIRED',
  ERROR = 'ERROR',
}

export enum BackupStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum BackupTarget {
  LOCAL = 'LOCAL',
  S3 = 'S3',
  R2 = 'R2',
  B2 = 'B2',
}

export enum DatabaseType {
  POSTGRESQL = 'POSTGRESQL',
  MYSQL = 'MYSQL',
  MARIADB = 'MARIADB',
  REDIS = 'REDIS',
  KEYDB = 'KEYDB',
  DRAGONFLY = 'DRAGONFLY',
  MONGODB = 'MONGODB',
  CLICKHOUSE = 'CLICKHOUSE',
}

export enum GitProvider {
  GITHUB = 'GITHUB',
  GITLAB = 'GITLAB',
  BITBUCKET = 'BITBUCKET',
  FORGEJO = 'FORGEJO',
  GITEA = 'GITEA',
}

export enum AppFramework {
  NEXTJS = 'NEXTJS',
  REACT = 'REACT',
  VUE = 'VUE',
  ANGULAR = 'ANGULAR',
  NESTJS = 'NESTJS',
  EXPRESS = 'EXPRESS',
  LARAVEL = 'LARAVEL',
  SYMFONY = 'SYMFONY',
  DJANGO = 'DJANGO',
  FLASK = 'FLASK',
  FASTAPI = 'FASTAPI',
  STATIC = 'STATIC',
  DOCKER = 'DOCKER',
  DOCKER_COMPOSE = 'DOCKER_COMPOSE',
  /** Classic Apache + PHP shared-hosting site (selectable PHP version). */
  PHP_SITE = 'PHP_SITE',
}

export enum UserRole {
  SUPERADMIN = 'SUPERADMIN',
  ADMIN = 'ADMIN',
  USER = 'USER',
  VIEWER = 'VIEWER',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BANNED = 'BANNED',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  /** Set at registration when `require_admin_approval` is on — login is 403 until an admin activates. */
  PENDING_APPROVAL = 'PENDING_APPROVAL',
}

export enum ProjectRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  DEVELOPER = 'DEVELOPER',
  VIEWER = 'VIEWER',
}

export enum TaskType {
  DEPLOY = 'DEPLOY',
  BUILD = 'BUILD',
  START = 'START',
  RESTART = 'RESTART',
  STOP = 'STOP',
  REMOVE = 'REMOVE',
  LOGS = 'LOGS',
  EXEC = 'EXEC',
  STATUS = 'STATUS',
  FILE_READ = 'FILE_READ',
  FILE_WRITE = 'FILE_WRITE',
  FILE_LIST = 'FILE_LIST',
  FILE_DELETE = 'FILE_DELETE',
  DISK_USAGE = 'DISK_USAGE',
  SFTP_SYNC = 'SFTP_SYNC',
  BACKUP = 'BACKUP',
  SSL_ISSUE = 'SSL_ISSUE',
  SSL_RENEW = 'SSL_RENEW',
  DNS_UPDATE = 'DNS_UPDATE',
  MONITOR = 'MONITOR',
  VOLUME_EXPORT = 'VOLUME_EXPORT',
  VOLUME_IMPORT = 'VOLUME_IMPORT',
  RESTORE = 'RESTORE',
}

export enum TaskStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

// AlertRule comparison operator (schema.prisma AlertOperator, default GTE).
export enum AlertOperator {
  GT = 'GT',
  GTE = 'GTE',
  LT = 'LT',
  LTE = 'LTE',
  EQ = 'EQ',
}

export enum AlertChannel {
  EMAIL = 'EMAIL',
  DISCORD = 'DISCORD',
  SLACK = 'SLACK',
  WEBHOOK = 'WEBHOOK',
}

export enum DNSRecordType {
  A = 'A',
  AAAA = 'AAAA',
  CNAME = 'CNAME',
  TXT = 'TXT',
  MX = 'MX',
  NS = 'NS',
  CAA = 'CAA',
  SRV = 'SRV',
}
