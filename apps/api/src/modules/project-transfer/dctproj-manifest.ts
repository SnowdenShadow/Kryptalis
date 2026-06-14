/**
 * `.dctproj` archive manifest — the version-stable, self-describing contract
 * for moving a project BETWEEN two independent DockControl installs.
 *
 * Deliberately NOT built from Prisma types: the importing install may be a
 * different version, so the manifest mirrors the relevant Application /
 * Database / Domain fields by value and stays frozen per `version`. Secrets
 * (app envVars, DB passwords) are carried as base64 envelope strings
 * re-encrypted under the transfer passphrase — never plaintext on disk.
 */

export interface DctprojManifest {
  version: 1;
  /** ISO-8601; passed in by the caller (scripts can't call Date.now()). */
  exportedAt: string;
  source: {
    /** Opaque id of the exporting install (telemetry/debug only). */
    installId?: string;
    appVersion?: string;
  };
  /** Whether DB dumps + volume tars are bundled (false = config-only clone). */
  includesData: boolean;
  project: {
    name: string;
    description?: string;
  };
  applications: DctprojApp[];
  databases: DctprojDb[];
  domains: DctprojDomain[];
}

export interface DctprojApp {
  /** Canonical name (drives slug/container/dir on the target). */
  name: string;
  displayName?: string;
  /** AppFramework enum value as a string (e.g. "DOCKER", "DOCKER_COMPOSE"). */
  framework: string;
  gitUrl?: string;
  gitBranch?: string;
  dockerImage?: string;
  dockerComposeFile?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  hostPort?: number;
  containerPort?: number;
  customPort?: boolean;
  /**
   * The app's envVars object (JSON) re-encrypted under the transfer
   * passphrase, base64-encoded. Empty string when the app has no env.
   */
  envEncrypted?: string;
  /** Archive-relative paths of this app's volume tars (empty if no data). */
  volumeFiles: string[];
  /**
   * True when the app's compose mounts the docker socket or host paths (or is
   * otherwise unsafe to run from an untrusted archive). Such apps are NOT
   * portable between installs for security reasons — import skips them with a
   * clear warning rather than recreating an unrunnable / dangerous stack.
   */
  requiresHostAccess?: boolean;
}

export interface DctprojDb {
  name: string;
  /** DbType enum value as a string (e.g. "POSTGRES", "MYSQL", "REDIS"). */
  type: string;
  username: string;
  /** DB password re-encrypted under the transfer passphrase, base64. */
  passwordEncrypted: string;
  port?: number;
  /** Archive-relative path of the SQL dump (present only when includesData). */
  dumpFile?: string;
}

export interface DctprojDomain {
  domain: string;
  /** Name of the application this domain points at, resolved on import. */
  applicationName?: string;
  customPort?: number;
}

/** Result of parsing an uploaded archive WITHOUT applying it (import review). */
export interface DctprojParseResult {
  /** Server-side staging id the apply step references (archive kept on disk). */
  stagedId: string;
  manifest: DctprojManifest;
  /** Conflicts detected against the importing install's existing data. */
  conflicts: {
    /** Domains already present on this install (Domain.domain is @unique). */
    domains: string[];
    /** Project name already used by the importer. */
    projectNameTaken: boolean;
  };
  warnings: string[];
}

/** How to handle domains that already exist on the target install. */
export type DomainStrategy = 'skip' | 'attach';
