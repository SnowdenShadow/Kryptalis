import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Real-Postgres integration harness for DB-level invariants.
 *
 * Every other spec in this codebase mocks Prisma with `vi.fn()`, so the actual
 * SQL — FK cascade/SET NULL/RESTRICT semantics, the partial unique in-flight
 * index, NULL-distinct unique behavior — is never executed against a database.
 * The audit called this out as the one real coverage blind spot.
 *
 * PGlite is a genuine PostgreSQL compiled to WASM: it runs in-process with no
 * Docker daemon, yet enforces the exact constraints production Postgres does
 * (partial indexes, deferred FKs, NULL-distinct uniques). We load the project's
 * OWN migration SQL into it — not a hand-written schema — so these tests track
 * the real schema as it evolves. If a future migration breaks, these specs fail.
 *
 * Usage:
 *   const pg = await freshDb();
 *   await pg.exec(`INSERT INTO ...`);
 *   const { rows } = await pg.query(`SELECT ...`);
 *   // pg.close() in afterAll / afterEach
 */

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

/** Migration directory names, lexically sorted = chronological apply order. */
function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Spin up a fresh in-memory Postgres with every project migration applied, in
 * order. Each call is fully isolated (its own database), so specs never share
 * state. Throws with the offending migration name if any migration fails to
 * apply — that itself is a useful regression signal.
 */
export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const dir of migrationDirs()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
    try {
      await db.exec(sql);
    } catch (e: any) {
      await db.close();
      throw new Error(`migration ${dir} failed to apply: ${e?.message || e}`);
    }
  }
  return db;
}

/** Number of migrations on disk — asserted by the harness self-test. */
export function migrationCount(): number {
  return migrationDirs().length;
}

let seq = 0;
/** Deterministic unique-ish id (no crypto/random needed for tests). */
export function id(prefix = 'id'): string {
  seq += 1;
  return `${prefix}_${seq.toString(36).padStart(6, '0')}`;
}

/** now() literal helper for NOT NULL `updatedAt` columns Prisma normally fills. */
export const NOW = 'CURRENT_TIMESTAMP';

/** Insert a user and return its id. */
export async function seedUser(
  db: PGlite,
  opts: { role?: string; email?: string } = {},
): Promise<string> {
  const uid = id('usr');
  await db.query(
    `INSERT INTO "users" ("id","name","email","password","role","updatedAt")
     VALUES ($1,$2,$3,$4,$5, ${NOW})`,
    [uid, 'Test User', opts.email ?? `${uid}@example.com`, 'x', opts.role ?? 'USER'],
  );
  return uid;
}

/** Insert a server and return its id. */
export async function seedServer(db: PGlite): Promise<string> {
  const sid = id('srv');
  await db.query(
    `INSERT INTO "servers" ("id","name","host","updatedAt") VALUES ($1,$2,$3, ${NOW})`,
    [sid, 'srv', '203.0.113.1'],
  );
  return sid;
}

/** Insert a project (needs a server + owner) and return its id. */
export async function seedProject(db: PGlite, serverId: string, userId: string): Promise<string> {
  const pid = id('prj');
  await db.query(
    `INSERT INTO "projects" ("id","name","serverId","userId","updatedAt")
     VALUES ($1,$2,$3,$4, ${NOW})`,
    [pid, 'proj', serverId, userId],
  );
  return pid;
}

/** Insert an application under a project and return its id. */
export async function seedApp(db: PGlite, projectId: string): Promise<string> {
  const aid = id('app');
  await db.query(
    `INSERT INTO "applications" ("id","name","projectId","updatedAt")
     VALUES ($1,$2,$3, ${NOW})`,
    [aid, 'app', projectId],
  );
  return aid;
}

/** Insert a deployment for an app and return its id. */
export async function seedDeployment(
  db: PGlite,
  applicationId: string,
  triggeredById: string,
  status: string,
): Promise<string> {
  const did = id('dep');
  await db.query(
    `INSERT INTO "deployments" ("id","applicationId","status","triggeredById")
     VALUES ($1,$2,$3,$4)`,
    [did, applicationId, status, triggeredById],
  );
  return did;
}

/** SELECT count(*) helper. */
export async function count(db: PGlite, table: string, where = ''): Promise<number> {
  const sql = `SELECT count(*)::int AS n FROM "${table}"${where ? ' WHERE ' + where : ''}`;
  const { rows } = await db.query<{ n: number }>(sql);
  return rows[0].n;
}
