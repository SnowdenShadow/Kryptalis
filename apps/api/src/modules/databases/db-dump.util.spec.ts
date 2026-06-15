import { describe, it, expect } from 'vitest';
import {
  resolveDbContainer,
  canDumpType,
  dumpPlan,
  restorePlan,
  type DumpableDb,
} from './db-dump.util';

const base: DumpableDb = {
  name: 'shop',
  type: 'MARIADB',
  username: 'prestashop',
  password: 's3cret',
  autoImported: false,
  host: 'dockcontrol-prestashop-db-abc123',
};

describe('resolveDbContainer', () => {
  it('manual rows → dockcontrol-db-<name>', () => {
    expect(resolveDbContainer({ name: 'shop', autoImported: false, host: 'x' }))
      .toBe('dockcontrol-db-shop');
  });
  it('auto-imported rows → real container_name from host (the PrestaShop bug)', () => {
    expect(resolveDbContainer({ name: 'shop', autoImported: true, host: 'dockcontrol-prestashop-db-abc123' }))
      .toBe('dockcontrol-prestashop-db-abc123');
  });
});

describe('canDumpType', () => {
  it('true for exec-dumpable engines', () => {
    for (const t of ['POSTGRESQL', 'MYSQL', 'MARIADB', 'MONGODB', 'REDIS', 'KEYDB']) {
      expect(canDumpType(t), t).toBe(true);
    }
  });
  it('false for engines with no portable exec dump', () => {
    for (const t of ['CLICKHOUSE', 'DRAGONFLY', 'WHATEVER', '']) {
      expect(canDumpType(t), t).toBe(false);
    }
  });
});

describe('dumpPlan', () => {
  const C = 'container-x';

  it('Postgres single-db: pg_dump --clean --if-exists -d <name>, no password on argv', () => {
    const p = dumpPlan({ ...base, type: 'POSTGRESQL', name: 'app' }, C, { dumpAll: false })!;
    expect(p.argv).toEqual(['exec', C, 'pg_dump', '-U', 'prestashop', '--clean', '--if-exists', '-d', 'app']);
    expect(p.envFileContent).toBeUndefined();
    expect(p.binary).toBe(false);
    expect(p.ext).toBe('sql');
  });

  it('Postgres dumpAll: pg_dumpall', () => {
    const p = dumpPlan({ ...base, type: 'POSTGRESQL' }, C, { dumpAll: true })!;
    expect(p.argv).toContain('pg_dumpall');
  });

  it('MySQL/MariaDB: --databases <name> + password via env-file, never on argv', () => {
    const p = dumpPlan(base, C, { dumpAll: false })!;
    expect(p.argv).toEqual(['exec', C, 'mysqldump', '-u', 'prestashop', '--databases', 'shop']);
    expect(p.envFileContent).toBe('MYSQL_PWD=s3cret\n');
    // The password must NOT appear anywhere on the argv.
    expect(p.argv.join(' ')).not.toContain('s3cret');
  });

  it('MariaDB dumpAll: --all-databases (for auto-imported instances)', () => {
    const p = dumpPlan({ ...base, autoImported: true }, C, { dumpAll: true })!;
    expect(p.argv).toContain('--all-databases');
    expect(p.argv).not.toContain('--databases');
  });

  it('Mongo: --archive binary dump', () => {
    const p = dumpPlan({ ...base, type: 'MONGODB' }, C, { dumpAll: false })!;
    expect(p.argv).toContain('mongodump');
    expect(p.argv).toContain('--archive');
    expect(p.binary).toBe(true);
    expect(p.ext).toBe('archive');
  });

  it('Redis: SAVE prep then cat the rdb; auth via env not argv', () => {
    const p = dumpPlan({ ...base, type: 'REDIS' }, C, { dumpAll: false })!;
    expect(p.prepArgv).toEqual(['exec', '-e', 'REDISCLI_AUTH=s3cret', C, 'redis-cli', 'SAVE']);
    expect(p.argv).toEqual(['exec', C, 'cat', '/data/dump.rdb']);
    expect(p.ext).toBe('rdb');
  });

  it('Redis without password: no auth env', () => {
    const p = dumpPlan({ ...base, type: 'KEYDB', password: '' }, C, { dumpAll: false })!;
    expect(p.prepArgv).toEqual(['exec', C, 'redis-cli', 'SAVE']);
  });

  it('unsupported engine → null', () => {
    expect(dumpPlan({ ...base, type: 'CLICKHOUSE' }, C, { dumpAll: false })).toBeNull();
  });
});

describe('restorePlan — inverse of dumpPlan', () => {
  const C = 'container-x';

  it('Postgres single-db: psql stdin into the db\'s OWN name (pg_dump has no \\connect)', () => {
    const r = restorePlan({ ...base, type: 'POSTGRESQL', name: 'app' }, C, { dumpAll: false })!;
    expect(r.mode).toBe('stdin');
    expect(r.argv).toEqual(['exec', '-i', C, 'psql', '-U', 'prestashop', '-d', 'app']);
  });

  it('Postgres dumpAll: psql stdin into the maintenance db (pg_dumpall carries \\connect)', () => {
    const r = restorePlan({ ...base, type: 'POSTGRESQL', name: 'app' }, C, { dumpAll: true })!;
    expect(r.argv).toEqual(['exec', '-i', C, 'psql', '-U', 'prestashop', '-d', 'postgres']);
  });

  it('MySQL/MariaDB: mysql stdin, password via env-file', () => {
    const r = restorePlan(base, C)!;
    expect(r.mode).toBe('stdin');
    expect(r.argv).toEqual(['exec', '-i', C, 'mysql', '-u', 'prestashop']);
    expect(r.envFileContent).toBe('MYSQL_PWD=s3cret\n');
    expect(r.argv.join(' ')).not.toContain('s3cret');
  });

  it('Mongo: mongorestore --archive --drop on stdin', () => {
    const r = restorePlan({ ...base, type: 'MONGODB' }, C)!;
    expect(r.mode).toBe('stdin');
    expect(r.argv).toContain('mongorestore');
    expect(r.argv).toContain('--drop');
  });

  it('Redis: copy-restart to /data/dump.rdb', () => {
    const r = restorePlan({ ...base, type: 'REDIS' }, C)!;
    expect(r.mode).toBe('copy-restart');
    expect(r.copyTo).toEqual({ container: C, path: '/data/dump.rdb' });
  });

  it('unsupported engine → null', () => {
    expect(restorePlan({ ...base, type: 'DRAGONFLY' }, C)).toBeNull();
  });
});
