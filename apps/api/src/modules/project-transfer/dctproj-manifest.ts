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
  /**
   * Whether each app's Docker IMAGES are bundled as `docker save` tars (heavy:
   * the archive grows by the full image size, often GBs). When true the import
   * `docker load`s them and runs the stack on the EXACT same image — no pull,
   * no rebuild — so `:latest` drift / a vanished build context can't change
   * the running binary. Independent of includesData.
   */
  includesImages?: boolean;
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
  /**
   * Archive-relative paths of this app's volume tars (empty if no data).
   * LEGACY (v1.0): just the path — the source volume name is the tar basename.
   * Kept for backward-compat reads. New exports ALSO populate `volumes` below
   * with the remappable key so the importer can compute the TARGET volume name
   * (the source/target compose-project prefix differs across installs).
   */
  volumeFiles: string[];
  /**
   * Per-volume descriptor for cross-install remapping. `file` is the
   * archive-relative tar path; `key` is the source volume name with its
   * compose-project prefix stripped (e.g. `prestashop_data_<oldId>`). The
   * importer rebuilds the target name as `<targetPrefix>_<key>` so the data
   * lands in the volume the freshly-deployed stack actually mounts.
   * Optional for backward-compat with v1.0 archives (fall back to volumeFiles).
   */
  volumes?: { file: string; key: string }[];
  /**
   * Archive-relative path of this app's `docker save` tar (gzip'd), present
   * only when the export bundled images. Holds EVERY image the stack resolves
   * to (the app + its sidecars, e.g. PrestaShop + MariaDB). The importer
   * `docker load`s it before `up`.
   */
  imageArchive?: string;
  /**
   * The exact image tags captured in `imageArchive`, in stack order. Used at
   * import to rewrite the compose so it consumes the loaded images
   * (`build:`→`image:<tag>`, `pull_policy: missing`) instead of pulling/building.
   */
  savedImages?: string[];
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
  /** Archive-relative path of the SQL dump (present only when includesData
   *  AND this is a standalone DB — see dataInVolume). */
  dumpFile?: string;
  /**
   * True for an auto-imported (bundled) DB whose data lives inside its parent
   * app's docker volume (e.g. PrestaShop's MariaDB). For these we do NOT emit
   * a separate SQL dump — the volume tar already carries the full datadir, and
   * the app restores it before first boot. Dumping SQL too would be redundant
   * and risks an inconsistent double-restore.
   */
  dataInVolume?: boolean;
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
