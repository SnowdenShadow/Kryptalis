/**
 * Detect databases declared inside a docker-compose stack.
 *
 * Walks `services:` and matches each `image:` against known DB images
 * (Postgres / MySQL / MariaDB / Redis / KeyDB / Dragonfly / Mongo /
 * ClickHouse). For matches we extract:
 *
 *   - the canonical DockControl DbType
 *   - the service name (used as idempotency key on redeploy)
 *   - the resolved container_name (with __INSTANCE_ID__ already expanded
 *     by the caller — we get the final string)
 *   - username / password / database from the env block (each DB image
 *     uses its own naming convention)
 *   - the published host port if the service binds one
 *
 * Used by the post-deploy hook in applications.service.ts to upsert
 * `Database` rows attached to the parent app + project, so RBAC and
 * the /databases dashboard cover compose-bundled DBs the same way they
 * cover manually-provisioned ones.
 */

import * as yaml from 'js-yaml';
import type { DbType } from '@prisma/client';

export interface DetectedDb {
  type: DbType;
  serviceName: string;
  containerName: string;
  username: string;
  password: string;
  database: string;
  /** Internal port the DB listens on (always set — comes from a static map per type). */
  containerPort: number;
  /**
   * Host-side port if the compose binds it via `ports: ["X:Y"]`.
   * `null` if the service is only reachable inside the docker network.
   * The /databases UI shows this as the user-facing port; if null we
   * fall back to the container port (caller's responsibility).
   */
  hostPort: number | null;
}

// Default ports per DB image. Used as the "container side" of the bind
// and as the connection-string port when no host bind exists.
const DEFAULT_PORTS: Record<DbType, number> = {
  POSTGRESQL: 5432,
  MYSQL: 3306,
  MARIADB: 3306,
  REDIS: 6379,
  KEYDB: 6379,
  DRAGONFLY: 6379,
  MONGODB: 27017,
  CLICKHOUSE: 8123,
};

/**
 * Map a docker image reference to a DbType. Tag-stripped + lowercased.
 * Returns null when nothing matches — caller skips that service.
 */
function imageToType(rawImage: string): DbType | null {
  // Strip registry, tag, digest. We only care about the repo/name.
  const img = rawImage.toLowerCase().split('@')[0].split(':')[0].split('/').pop() || '';
  if (img === 'postgres' || img === 'postgresql' || img.startsWith('postgres-')) return 'POSTGRESQL';
  if (img === 'mariadb' || img.startsWith('mariadb-')) return 'MARIADB';
  if (img === 'mysql' || img.startsWith('mysql-')) return 'MYSQL';
  if (img === 'mongo' || img === 'mongodb' || img.startsWith('mongo-')) return 'MONGODB';
  if (img === 'redis' || img.startsWith('redis-')) return 'REDIS';
  if (img === 'keydb') return 'KEYDB';
  if (img === 'dragonfly') return 'DRAGONFLY';
  if (img === 'clickhouse-server' || img === 'clickhouse') return 'CLICKHOUSE';
  return null;
}

/**
 * Pull host:container from a compose `ports:` entry. Compose accepts
 * "8080", "8080:80", "127.0.0.1:8080:80", or the long-form object.
 * Returns the host side when the entry binds the DB's container port,
 * otherwise null.
 */
function extractHostPort(ports: unknown, targetContainerPort: number): number | null {
  if (!Array.isArray(ports)) return null;
  for (const entry of ports) {
    if (typeof entry === 'string') {
      const [spec] = entry.split('/'); // strip /tcp
      const parts = spec.split(':');
      let host: number | null = null;
      let container: number;
      if (parts.length === 1) { container = Number(parts[0]); host = container; }
      else if (parts.length === 2) { host = Number(parts[0]); container = Number(parts[1]); }
      else { host = Number(parts[1]); container = Number(parts[2]); }
      if (container === targetContainerPort && Number.isFinite(host as number)) {
        return host as number;
      }
    } else if (entry && typeof entry === 'object') {
      const target = Number((entry as any).target);
      const published = Number((entry as any).published);
      if (target === targetContainerPort && Number.isFinite(published)) {
        return published;
      }
    }
  }
  return null;
}

/**
 * Normalize a compose `environment:` block. Compose accepts BOTH list
 * form (`["KEY=value", "OTHER=x"]`) and map form (`{ KEY: value }`).
 * Returns the map shape with all values stringified.
 */
function normalizeEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq < 0) continue;
      out[item.slice(0, eq)] = item.slice(eq + 1);
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v == null ? '' : String(v);
    }
  }
  return out;
}

/**
 * Extract (user, password, dbname) from a service's env block based on
 * its DB type. Each image uses its own convention so we centralize the
 * mapping here.
 *
 * Falls back to sensible defaults so we never insert an empty username —
 * the user can re-run the importer or rotate creds from the UI later.
 */
/**
 * Pull the value of `--requirepass <x>` (or `--requirepass=<x>`) out of a
 * compose `command:` — Redis/KeyDB/Dragonfly carry the password there, not
 * in env. Accepts the string form ("redis-server --requirepass secret") and
 * the list form (["redis-server", "--requirepass", "secret"] or
 * ["--requirepass=secret"]). Returns '' when not present.
 */
function extractRequirePass(command: unknown): string {
  const tokens: string[] = Array.isArray(command)
    ? command.map((c) => String(c))
    : typeof command === 'string'
      ? command.split(/\s+/).filter(Boolean)
      : [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--requirepass') {
      const next = tokens[i + 1];
      if (next && !next.startsWith('--')) return next;
    } else if (t.startsWith('--requirepass=')) {
      return t.slice('--requirepass='.length);
    }
  }
  return '';
}

function extractCreds(
  type: DbType,
  env: Record<string, string>,
  serviceName: string,
  command?: unknown,
): { username: string; password: string; database: string } {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (env[k]) return env[k];
    return '';
  };

  let username = '';
  let password = '';
  let database = '';

  switch (type) {
    case 'POSTGRESQL':
      username = pick('POSTGRES_USER', 'POSTGRESQL_USERNAME') || 'postgres';
      password = pick('POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD');
      database = pick('POSTGRES_DB', 'POSTGRESQL_DATABASE') || username;
      break;
    case 'MYSQL':
    case 'MARIADB':
      // MariaDB images accept both MARIADB_* and MYSQL_* — check the
      // newer MARIADB_ keys first so explicit overrides win.
      username = pick('MARIADB_USER', 'MYSQL_USER') || 'root';
      password = pick(
        'MARIADB_PASSWORD',
        'MYSQL_PASSWORD',
        'MARIADB_ROOT_PASSWORD',
        'MYSQL_ROOT_PASSWORD',
      );
      database = pick('MARIADB_DATABASE', 'MYSQL_DATABASE') || serviceName;
      break;
    case 'MONGODB':
      username = pick('MONGO_INITDB_ROOT_USERNAME', 'MONGODB_ROOT_USER') || 'root';
      password = pick('MONGO_INITDB_ROOT_PASSWORD', 'MONGODB_ROOT_PASSWORD');
      database = pick('MONGO_INITDB_DATABASE', 'MONGODB_DATABASE') || serviceName;
      break;
    case 'REDIS':
    case 'KEYDB':
    case 'DRAGONFLY':
      // No user/db concept — Redis uses a single optional password.
      // Common patterns: REDIS_PASSWORD env, or --requirepass in the command.
      username = 'default';
      password = pick('REDIS_PASSWORD', 'KEYDB_PASSWORD') || extractRequirePass(command);
      database = serviceName;
      break;
    case 'CLICKHOUSE':
      username = pick('CLICKHOUSE_USER') || 'default';
      password = pick('CLICKHOUSE_PASSWORD');
      database = pick('CLICKHOUSE_DB') || serviceName;
      break;
  }
  return { username, password, database };
}

/**
 * Walk the parsed compose doc and return every detected DB service.
 * Skips services with no recognized image. Safe to call on user-supplied
 * YAML; any parse error bubbles up to the caller.
 */
export function detectDatabasesInCompose(composeYaml: string): DetectedDb[] {
  const doc: any = yaml.load(composeYaml);
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') {
    return [];
  }
  const out: DetectedDb[] = [];
  for (const [serviceName, raw] of Object.entries(doc.services)) {
    const svc = raw as Record<string, unknown>;
    const image = typeof svc.image === 'string' ? svc.image : '';
    if (!image) continue;
    const type = imageToType(image);
    if (!type) continue;
    const containerPort = DEFAULT_PORTS[type];
    const env = normalizeEnv(svc.environment);
    const { username, password, database } = extractCreds(type, env, serviceName, svc.command);
    out.push({
      type,
      serviceName,
      // When the user doesn't set container_name, compose uses
      // <project>-<service>-1. We don't know the project prefix here,
      // so we fall back to the service name — the caller (which DOES
      // know the project prefix from the appDir name) can override.
      containerName: typeof svc.container_name === 'string' ? svc.container_name : serviceName,
      username,
      password,
      database,
      containerPort,
      hostPort: extractHostPort(svc.ports, containerPort),
    });
  }
  return out;
}
