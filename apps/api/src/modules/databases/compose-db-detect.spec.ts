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
