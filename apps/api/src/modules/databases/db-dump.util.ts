/**
 * Shared, pure helpers for dumping and restoring a database that runs inside a
 * Docker container on the LOCAL host. These were duplicated (and had quietly
 * drifted) across three call sites:
 *
 *   - BackupsService.dumpDatabases / restoreDatabase (the canonical, proven
 *     command shapes — dump and restore are deliberately symmetric so a dump
 *     replays cleanly)
 *   - DatabasesService.exportDump (one-click download)
 *   - ProjectTransferService.dumpLocalDatabase (.dctproj export)
 *
 * Centralising the argv here makes dump↔restore symmetry a single source of
 * truth and fixes the container-resolution bug where auto-imported (bundled)
 * DBs were addressed as `dockcontrol-db-<name>` instead of their real
 * container_name (stored in the row's `host`).
 *
 * NOTE: these return argv ARRAYS for `docker` (no shell). Secrets that the
 * tool can only take via env (MySQL/MariaDB password) are surfaced as an
 * `envFileContent` descriptor — the CALLER writes it to a 0600 temp file and
 * splices `--env-file <path>` in, then unlinks it. This keeps the password off
 * the host process argv (where `ps` would leak it), matching how Backups does
 * it via withMysqlPwdEnvFile.
 */

/** The subset of a Database row these helpers need. */
export interface DumpableDb {
  name: string;
  type: string;
  username: string;
  /** Decrypted password (plaintext). Empty string when the engine has none. */
  password: string;
  /** Auto-imported (bundled in an app's compose) rows store the real
   *  container_name in `host`; manually-provisioned rows don't. */
  autoImported: boolean;
  host: string;
}

/**
 * Resolve the Docker container_name a DB row lives in.
 *   - auto-imported (bundled, e.g. PrestaShop's MariaDB): the real
 *     container_name was captured into `host` at import time.
 *   - manually provisioned: the deterministic `dockcontrol-db-<name>` scheme
 *     DatabasesService.launchContainer uses.
 */
export function resolveDbContainer(db: Pick<DumpableDb, 'name' | 'autoImported' | 'host'>): string {
  return db.autoImported ? db.host : `dockcontrol-db-${db.name}`;
}

/** Engines we can dump/restore over `docker exec`. Others (ClickHouse,
 *  Dragonfly) have no portable exec path — their data rides a volume tar. */
export function canDumpType(type: string): boolean {
  switch ((type || '').toUpperCase()) {
    case 'POSTGRESQL':
    case 'MYSQL':
    case 'MARIADB':
    case 'MONGODB':
    case 'REDIS':
    case 'KEYDB':
      return true;
    default:
      return false;
  }
}

export interface DumpPlan {
  /** docker argv AFTER `docker` (begins with `exec`). For MySQL/MariaDB the
   *  caller must splice `--env-file <path>` right after `exec` and provide
   *  envFileContent. */
  argv: string[];
  /** When set, the caller writes this to a 0600 temp file and inserts
   *  `--env-file <path>` immediately after `exec`. */
  envFileContent?: string;
  /** Output is binary (Mongo archive / Redis rdb) vs text (SQL). */
  binary: boolean;
  /** Suggested file extension (no leading dot). */
  ext: string;
  /** Some engines (Redis) need a synchronous prep step (SAVE) before the
   *  stream can be read. argv AFTER `docker`. Run and await before streaming. */
  prepArgv?: string[];
}

/**
 * Build the dump command for a DB. `dumpAll` mirrors Backups' behaviour:
 * auto-imported rows don't track a logical db name, so dump the whole instance.
 *
 * Dump shapes are kept IDENTICAL to BackupsService.dumpDatabases so the output
 * replays through restorePlan() (and Backups' restoreDatabase) without surprise.
 */
export function dumpPlan(
  db: DumpableDb,
  container: string,
  opts: { dumpAll: boolean },
): DumpPlan | null {
  const t = (db.type || '').toUpperCase();
  const { dumpAll } = opts;
  switch (t) {
    case 'POSTGRESQL': {
      // No password on argv — inside the container pg_dump connects over the
      // local socket as the trusted superuser (official image pg_hba).
      const inner = dumpAll
        ? ['pg_dumpall', '-U', db.username, '--clean', '--if-exists']
        : ['pg_dump', '-U', db.username, '--clean', '--if-exists', '-d', db.name];
      return { argv: ['exec', container, ...inner], binary: false, ext: 'sql' };
    }
    case 'MYSQL':
    case 'MARIADB': {
      // `--databases <name>` (or `--all-databases`) so the dump carries
      // CREATE DATABASE / USE — required for a clean replay into a fresh
      // instance. Password via --env-file (caller splices it after `exec`).
      const inner = [
        'mysqldump', '-u', db.username,
        ...(dumpAll ? ['--all-databases'] : ['--databases', db.name]),
      ];
      return {
        argv: ['exec', container, ...inner],
        envFileContent: `MYSQL_PWD=${db.password}\n`,
        binary: false,
        ext: 'sql',
      };
    }
    case 'MONGODB': {
      // KNOWN LIMITATION (pre-existing, also in Backups): the Mongo password
      // is on the `docker exec` argv (visible via `ps`/proc to a co-located
      // process during the dump window). Unlike MySQL (MYSQL_PWD env-file) and
      // Redis (REDISCLI_AUTH env), mongodump has no password ENV — the off-argv
      // fix is a `--config <yaml>` file docker-cp'd into the container, which
      // needs the recent mongodb-database-tools and a live Mongo to verify.
      // Deferred rather than shipped blind against a working path. Local-only,
      // medium severity. If addressed: surface a configFileContent descriptor
      // here + have every caller cp it in, symmetric with restorePlan.
      const inner = [
        'mongodump', '--archive', '--quiet',
        '--username', db.username, '--password', db.password,
        '--authenticationDatabase', 'admin',
        ...(dumpAll ? [] : ['--db', db.name]),
      ];
      return { argv: ['exec', container, ...inner], binary: true, ext: 'archive' };
    }
    case 'REDIS':
    case 'KEYDB': {
      // SAVE first (returns before we can stream), then `cat` the rdb out.
      // REDISCLI_AUTH keeps the password off the argv.
      const authEnv = db.password ? ['-e', `REDISCLI_AUTH=${db.password}`] : [];
      return {
        prepArgv: ['exec', ...authEnv, container, 'redis-cli', 'SAVE'],
        argv: ['exec', container, 'cat', '/data/dump.rdb'],
        binary: true,
        ext: 'rdb',
      };
    }
    default:
      return null;
  }
}

export interface RestorePlan {
  /** Mode of replay:
   *   - 'stdin': pipe the dump file into the container's stdin (SQL / Mongo)
   *   - 'copy-restart': docker cp the file in, then restart (Redis rdb) */
  mode: 'stdin' | 'copy-restart';
  /** docker argv AFTER `docker`. For 'stdin' the process reads the dump on
   *  stdin (argv includes `exec -i`). For MySQL/MariaDB splice `--env-file`. */
  argv: string[];
  envFileContent?: string;
  /** 'copy-restart' only: the in-container path to docker-cp the file to, and
   *  the container to restart afterwards. */
  copyTo?: { container: string; path: string };
}

/**
 * Build the restore command — the exact inverse of dumpPlan, mirroring
 * BackupsService.restoreDatabase so a .dctproj/backup dump replays the same way.
 *
 * `dumpAll` MUST match how the dump was taken (auto-imported/whole-instance vs
 * single-db). It only affects Postgres: a pg_dumpall stream carries \connect +
 * CREATE DATABASE so it replays into the maintenance db (`postgres`), whereas a
 * single-db pg_dump has neither and must be loaded INTO its own database — so
 * we target `db.name`. Getting this wrong loads every table into `postgres`.
 */
export function restorePlan(db: DumpableDb, container: string, opts: { dumpAll: boolean } = { dumpAll: false }): RestorePlan | null {
  const t = (db.type || '').toUpperCase();
  switch (t) {
    case 'POSTGRESQL':
      return {
        mode: 'stdin',
        argv: ['exec', '-i', container, 'psql', '-U', db.username, '-d', opts.dumpAll ? 'postgres' : db.name],
      };
    case 'MYSQL':
    case 'MARIADB':
      return {
        mode: 'stdin',
        argv: ['exec', '-i', container, 'mysql', '-u', db.username],
        envFileContent: `MYSQL_PWD=${db.password}\n`,
      };
    case 'MONGODB':
      return {
        mode: 'stdin',
        argv: [
          'exec', '-i', container,
          'mongorestore', '--archive', '--drop',
          '--username', db.username, '--password', db.password,
          '--authenticationDatabase', 'admin',
        ],
      };
    case 'REDIS':
    case 'KEYDB':
      return { mode: 'copy-restart', argv: [], copyTo: { container, path: '/data/dump.rdb' } };
    default:
      return null;
  }
}
