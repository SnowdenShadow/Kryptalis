import { describe, it, expect } from 'vitest';
import { detectDatabasesInCompose } from './compose-db-detect';

describe('detectDatabasesInCompose', () => {
  it('detects a postgres service with creds and host port', () => {
    const compose = `
services:
  db:
    image: postgres:16
    container_name: my-postgres
    environment:
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: s3cret
      POSTGRES_DB: appdb
    ports:
      - "5433:5432"
  web:
    image: nginx:latest
`;
    const dbs = detectDatabasesInCompose(compose);
    expect(dbs).toHaveLength(1);
    expect(dbs[0]).toEqual({
      type: 'POSTGRESQL',
      serviceName: 'db',
      containerName: 'my-postgres',
      username: 'admin',
      password: 's3cret',
      database: 'appdb',
      containerPort: 5432,
      hostPort: 5433,
    });
  });

  it('handles list-form environment and no port binding', () => {
    const compose = `
services:
  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=u1
      - POSTGRES_PASSWORD=p1
`;
    const [db] = detectDatabasesInCompose(compose);
    expect(db.username).toBe('u1');
    expect(db.password).toBe('p1');
    expect(db.database).toBe('u1'); // falls back to username
    expect(db.hostPort).toBeNull();
    expect(db.containerName).toBe('db'); // falls back to service name
  });

  it('parses --requirepass from a Redis command (string form)', () => {
    const compose = `
services:
  cache:
    image: redis:7-alpine
    command: redis-server --requirepass s3cret --appendonly yes
`;
    const [db] = detectDatabasesInCompose(compose);
    expect(db.type).toBe('REDIS');
    expect(db.username).toBe('default');
    expect(db.password).toBe('s3cret');
  });

  it('parses --requirepass from a command list and the --requirepass=<x> form', () => {
    const listForm = `
services:
  cache:
    image: keydb
    command: ["keydb-server", "--requirepass", "kp@ss"]
`;
    expect(detectDatabasesInCompose(listForm)[0].password).toBe('kp@ss');

    const eqForm = `
services:
  cache:
    image: docker.dragonflydb.io/dragonflydb/dragonfly:latest
    command: ["--logtostderr", "--requirepass=df-pass"]
`;
    const [df] = detectDatabasesInCompose(eqForm);
    expect(df.type).toBe('DRAGONFLY');
    expect(df.password).toBe('df-pass');
  });

  it('prefers REDIS_PASSWORD env over the command --requirepass', () => {
    const compose = `
services:
  cache:
    image: redis:7
    environment:
      REDIS_PASSWORD: from-env
    command: redis-server --requirepass from-cmd
`;
    expect(detectDatabasesInCompose(compose)[0].password).toBe('from-env');
  });

  it('returns an empty array when no DB service is present', () => {
    const compose = `
services:
  web:
    image: nginx:latest
  api:
    build: .
`;
    expect(detectDatabasesInCompose(compose)).toEqual([]);
  });

  it('returns an empty array for YAML without services', () => {
    expect(detectDatabasesInCompose('version: "3"')).toEqual([]);
  });
});
