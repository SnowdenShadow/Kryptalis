import { describe, it, expect, afterEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  freshDb,
  migrationCount,
  count,
  seedUser,
  seedServer,
  seedProject,
  seedApp,
  seedDeployment,
  id,
  NOW,
} from './pg-harness';

/**
 * DB-level integration tests against a REAL Postgres (PGlite/WASM, no Docker).
 *
 * These exercise the SQL invariants the unit suite cannot, because it mocks
 * Prisma: foreign-key cascade / SET NULL / RESTRICT, the partial unique
 * in-flight-deployment index (the TOCTOU close), and NULL-distinct unique
 * behavior. The schema is loaded from the project's own migration files, so
 * these track production exactly.
 */

let db: PGlite;
afterEach(async () => {
  if (db) await db.close();
});

describe('migration harness', () => {
  it('applies every project migration cleanly and builds the expected schema', async () => {
    db = await freshDb();
    // All migrations applied (freshDb throws on the first failure).
    expect(migrationCount()).toBeGreaterThanOrEqual(20);
    // Core tables exist.
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const t of ['users', 'projects', 'applications', 'deployments', 'domains', 'servers']) {
      expect(tables).toContain(t);
    }
  });

  it('git_providers carries the self-hosted baseUrl column (Gitea/Forgejo)', async () => {
    db = await freshDb();
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='git_providers'`,
    );
    expect(rows.map((r) => r.column_name)).toContain('baseUrl');
  });

  it('projects has NO serverId column (a project is server-agnostic) and app.serverId is NOT NULL', async () => {
    db = await freshDb();
    const proj = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='projects'`,
    );
    expect(proj.rows.map((r) => r.column_name)).not.toContain('serverId');
    const app = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name='applications' AND column_name='serverId'`,
    );
    expect(app.rows[0]?.is_nullable).toBe('NO');
  });
});

describe('FK ON DELETE CASCADE', () => {
  it('deleting a project cascades to its applications and their deployments', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);
    await seedDeployment(db, a, u, 'RUNNING');

    expect(await count(db, 'applications')).toBe(1);
    expect(await count(db, 'deployments')).toBe(1);

    await db.query(`DELETE FROM "projects" WHERE id=$1`, [p]);

    // applications.projectId → CASCADE, deployments.applicationId → CASCADE.
    expect(await count(db, 'applications')).toBe(0);
    expect(await count(db, 'deployments')).toBe(0);
  });

  it('deleting a server that still hosts an app is REFUSED (Restrict, not cascade)', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    await seedApp(db, p, s);

    // applications.serverId → RESTRICT: the server can't be deleted while an app
    // references it (there's no project server to fall back to). The project
    // itself is server-agnostic and is unaffected.
    await expect(
      db.query(`DELETE FROM "servers" WHERE id=$1`, [s]),
    ).rejects.toThrow();
    expect(await count(db, 'applications')).toBe(1);
    expect(await count(db, 'projects')).toBe(1);
  });

  it('deleting a user cascades to their sessions', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    await db.query(
      `INSERT INTO "sessions" ("id","userId","refreshTokenHash","familyId","expiresAt")
       VALUES ($1,$2,$3,$4, ${NOW})`,
      [id('ses'), u, 'hash', id('fam')],
    );
    expect(await count(db, 'sessions')).toBe(1);

    await db.query(`DELETE FROM "users" WHERE id=$1`, [u]);
    expect(await count(db, 'sessions')).toBe(0);
  });
});

describe('FK ON DELETE SET NULL', () => {
  it('deleting an application nulls a database row’s applicationId (does NOT delete it)', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);
    const dbId = id('db');
    await db.query(
      `INSERT INTO "databases"
        ("id","name","type","host","port","username","password","applicationId","projectId","serverId","updatedAt")
       VALUES ($1,$2,'POSTGRESQL','localhost',5432,'u','p',$3,$4,$5, ${NOW})`,
      [dbId, 'maindb', a, p, s],
    );

    await db.query(`DELETE FROM "applications" WHERE id=$1`, [a]);

    // databases.applicationId is ON DELETE SET NULL — the row survives, FK nulled.
    const { rows } = await db.query<{ applicationId: string | null }>(
      `SELECT "applicationId" FROM "databases" WHERE id=$1`,
      [dbId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].applicationId).toBeNull();
  });

  it('deleting a project nulls a domain’s projectId and applicationId, keeping the domain', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);
    const dom = id('dom');
    await db.query(
      `INSERT INTO "domains" ("id","domain","projectId","applicationId","updatedAt")
       VALUES ($1,$2,$3,$4, ${NOW})`,
      [dom, 'example.com', p, a],
    );

    // Deleting the project cascades the app away, but the domain’s FKs are
    // SET NULL — the domain row must survive with both ids nulled.
    await db.query(`DELETE FROM "projects" WHERE id=$1`, [p]);

    const { rows } = await db.query<{ projectId: string | null; applicationId: string | null }>(
      `SELECT "projectId","applicationId" FROM "domains" WHERE id=$1`,
      [dom],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].projectId).toBeNull();
    expect(rows[0].applicationId).toBeNull();
  });
});

describe('FK ON DELETE RESTRICT (audit-trail preservation)', () => {
  it('refuses to delete a user who triggered a deployment', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);
    // A SECOND user triggers the deploy, so deleting them is blocked by RESTRICT
    // (deleting the owner would instead cascade the whole tree first).
    const trigger = await seedUser(db, { email: 'trigger@example.com' });
    await seedDeployment(db, a, trigger, 'RUNNING');

    await expect(db.query(`DELETE FROM "users" WHERE id=$1`, [trigger])).rejects.toThrow();

    // The triggering user is still there (delete was refused).
    expect(await count(db, 'users', `id='${trigger}'`)).toBe(1);
  });
});

describe('partial unique index: one in-flight deployment per app (TOCTOU close)', () => {
  it('rejects a second concurrent in-flight deployment for the same app', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);

    await seedDeployment(db, a, u, 'BUILDING');
    // A near-simultaneous second redeploy: must be rejected by the partial
    // unique index, NOT silently inserted (the race assertNoInflightDeployment
    // could not close on its own).
    await expect(seedDeployment(db, a, u, 'PENDING')).rejects.toThrow();
    expect(await count(db, 'deployments')).toBe(1);
  });

  it('allows a new in-flight deployment once the previous reaches a terminal state', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);

    const first = await seedDeployment(db, a, u, 'BUILDING');
    // Terminal → no longer in-flight, frees the slot.
    await db.query(`UPDATE "deployments" SET status='RUNNING' WHERE id=$1`, [first]);
    // Now a fresh deploy is allowed.
    await expect(seedDeployment(db, a, u, 'PENDING')).resolves.toBeTruthy();
    expect(await count(db, 'deployments')).toBe(2);
  });

  it('does NOT constrain terminal states (many RUNNING/FAILED rows are fine)', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);

    await seedDeployment(db, a, u, 'RUNNING');
    await seedDeployment(db, a, u, 'FAILED');
    await seedDeployment(db, a, u, 'ROLLED_BACK');
    await seedDeployment(db, a, u, 'CANCELLED');
    expect(await count(db, 'deployments')).toBe(4);
  });

  it('in-flight slots are per-application, not global', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a1 = await seedApp(db, p, s);
    const a2 = await seedApp(db, p, s);

    // Each app may hold its own in-flight deploy simultaneously.
    await expect(seedDeployment(db, a1, u, 'BUILDING')).resolves.toBeTruthy();
    await expect(seedDeployment(db, a2, u, 'BUILDING')).resolves.toBeTruthy();
    expect(await count(db, 'deployments', `status='BUILDING'`)).toBe(2);
  });
});

describe('unique constraints', () => {
  it('enforces unique user email', async () => {
    db = await freshDb();
    await seedUser(db, { email: 'dup@example.com' });
    await expect(seedUser(db, { email: 'dup@example.com' })).rejects.toThrow();
  });

  it('enforces globally unique domain name', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const insertDomain = () =>
      db.query(
        `INSERT INTO "domains" ("id","domain","projectId","updatedAt") VALUES ($1,$2,$3, ${NOW})`,
        [id('dom'), 'taken.example.com', p],
      );
    await insertDomain();
    await expect(insertDomain()).rejects.toThrow();
  });

  it('enforces one project membership per (project,user) pair', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const member = await seedUser(db, { email: 'm@example.com' });
    const addMember = () =>
      db.query(
        `INSERT INTO "project_members" ("id","projectId","userId","role","updatedAt")
         VALUES ($1,$2,$3,'DEVELOPER', ${NOW})`,
        [id('pm'), p, member],
      );
    await addMember();
    await expect(addMember()).rejects.toThrow();
  });
});

describe('known NULL-distinct unique quirk on (applicationId, serviceName)', () => {
  it('does NOT dedupe two databases with a NULL serviceName for the same app', async () => {
    // Documents the audit’s "broken nullable @@unique" finding: in Postgres,
    // NULLs are distinct, so the UNIQUE(applicationId, serviceName) index does
    // not prevent two rows with the same applicationId and serviceName = NULL.
    // This test pins the real behavior so a future "fix" (NULLS NOT DISTINCT)
    // is a deliberate, visible change.
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);

    const insertDb = (name: string) =>
      db.query(
        `INSERT INTO "databases"
          ("id","name","type","serverId","host","port","username","password","applicationId","serviceName","updatedAt")
         VALUES ($1,$2,'POSTGRESQL',$3,'localhost',5432,'u','p',$4,NULL, ${NOW})`,
        [id('db'), name, s, a],
      );
    await insertDb('db1');
    // Second row, same app, serviceName NULL → NOT rejected (NULL != NULL).
    await expect(insertDb('db2')).resolves.toBeTruthy();
    expect(await count(db, 'databases')).toBe(2);
  });

  it('DOES dedupe when serviceName is a concrete value', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);

    const insertDb = (name: string) =>
      db.query(
        `INSERT INTO "databases"
          ("id","name","type","serverId","host","port","username","password","applicationId","serviceName","updatedAt")
         VALUES ($1,$2,'POSTGRESQL',$3,'localhost',5432,'u','p',$4,'maindb', ${NOW})`,
        [id('db'), name, s, a],
      );
    await insertDb('db1');
    await expect(insertDb('db2')).rejects.toThrow();
  });
});

describe('column defaults applied by the database', () => {
  it('new users default to role USER / status ACTIVE', async () => {
    db = await freshDb();
    const uid = id('usr');
    // Insert WITHOUT role/status — the DB defaults must fill them.
    await db.query(
      `INSERT INTO "users" ("id","name","email","password","updatedAt")
       VALUES ($1,$2,$3,$4, ${NOW})`,
      [uid, 'n', `${uid}@example.com`, 'x'],
    );
    const { rows } = await db.query<{ role: string; status: string; failedLoginAttempts: number }>(
      `SELECT role, status, "failedLoginAttempts" FROM "users" WHERE id=$1`,
      [uid],
    );
    expect(rows[0].role).toBe('USER');
    expect(rows[0].status).toBe('ACTIVE');
    expect(rows[0].failedLoginAttempts).toBe(0);
  });

  it('new deployments default to status PENDING', async () => {
    db = await freshDb();
    const u = await seedUser(db);
    const s = await seedServer(db);
    const p = await seedProject(db, u);
    const a = await seedApp(db, p, s);
    const did = id('dep');
    await db.query(
      `INSERT INTO "deployments" ("id","applicationId","triggeredById") VALUES ($1,$2,$3)`,
      [did, a, u],
    );
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM "deployments" WHERE id=$1`,
      [did],
    );
    expect(rows[0].status).toBe('PENDING');
  });
});
