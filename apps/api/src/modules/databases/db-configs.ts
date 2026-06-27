// Managed-database compose templates — the SINGLE source of truth for how a
// managed database (Postgres/MySQL/MariaDB/Redis/Mongo/KeyDB/Dragonfly/
// ClickHouse) is rendered into a docker-compose file.
//
// This used to live module-private inside databases.service.ts, with a
// hand-copied duplicate in projects.service.ts (project migration). The two
// drifted — the MariaDB copy used MARIADB_* env keys while this one uses
// MYSQL_*, so a managed MariaDB rebuilt via the migration path initialized a
// fresh volume with different env than the databases path. Extracting it to a
// leaf module (no service dependencies → no import cycle) lets both consumers
// share one definition so they can never drift again.
//
// Each `compose(name, user, pass, port)` returns a complete compose body. The
// raw db.name is used verbatim for the service/container/db name (NEVER
// slugified — callers rely on that for container resolution). The DTO layer
// constrains name/username so they cannot smuggle YAML/shell metacharacters.

export interface DbConfig {
  image: string;
  defaultPort: number;
  portBase: number;
  compose: (name: string, user: string, pass: string, port: number) => string;
}

export const DB_CONFIGS: Record<string, DbConfig> = {
  POSTGRESQL: {
    image: 'postgres:16-alpine',
    defaultPort: 5432,
    portBase: 5440,
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: postgres:16-alpine
    container_name: dockcontrol-db-${name}
    restart: unless-stopped
    ports:
      - "${port}:5432"
    environment:
      POSTGRES_DB: ${name}
      POSTGRES_USER: ${user}
      POSTGRES_PASSWORD: ${pass}
    volumes:
      - data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${user}"]
      interval: 5s
      timeout: 5s
      retries: 5
volumes:
  data:`,
  },
  MYSQL: {
    image: 'mysql:8',
    defaultPort: 3306,
    portBase: 3310,
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: mysql:8
    container_name: dockcontrol-db-${name}
    restart: unless-stopped
    ports:
      - "${port}:3306"
    environment:
      MYSQL_DATABASE: ${name}
      MYSQL_USER: ${user}
      MYSQL_PASSWORD: ${pass}
      MYSQL_ROOT_PASSWORD: ${pass}
    volumes:
      - data:/var/lib/mysql
volumes:
  data:`,
  },
  MARIADB: {
    image: 'mariadb:11',
    defaultPort: 3306,
    portBase: 3360,
    // mariadb:11 honors the MYSQL_* env keys; keep them identical to MYSQL so
    // a MariaDB initialized via either the databases path or the project-
    // migration path seeds the same env (see the drift note above).
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: mariadb:11
    container_name: dockcontrol-db-${name}
    restart: unless-stopped
    ports:
      - "${port}:3306"
    environment:
      MYSQL_DATABASE: ${name}
      MYSQL_USER: ${user}
      MYSQL_PASSWORD: ${pass}
      MYSQL_ROOT_PASSWORD: ${pass}
    volumes:
      - data:/var/lib/mysql
volumes:
  data:`,
  },
  REDIS: {
    image: 'redis:7-alpine',
    defaultPort: 6379,
    portBase: 6390,
    compose: (name, _user, pass, port) => `services:
  ${name}:
    image: redis:7-alpine
    container_name: dockcontrol-db-${name}
    restart: unless-stopped
    ports:
      - "${port}:6379"
    command: redis-server${pass ? ` --requirepass ${pass}` : ''}
    volumes:
      - data:/data
volumes:
  data:`,
  },
  MONGODB: {
    image: 'mongo:7',
    defaultPort: 27017,
    portBase: 27020,
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: mongo:7
    container_name: dockcontrol-db-${name}
    restart: unless-stopped
    ports:
      - "${port}:27017"
    environment:
      MONGO_INITDB_DATABASE: ${name}
      MONGO_INITDB_ROOT_USERNAME: ${user}
      MONGO_INITDB_ROOT_PASSWORD: ${pass}
    volumes:
      - data:/data/db
volumes:
  data:`,
  },
  KEYDB: {
    image: 'eqalpha/keydb:latest',
    defaultPort: 6379,
    portBase: 6440,
    compose: (name, _user, pass, port) => `services:
  ${name}:
    image: eqalpha/keydb:latest
    container_name: dockcontrol-db-${name}
    restart: unless-stopped
    ports:
      - "${port}:6379"
    command: keydb-server${pass ? ` --requirepass ${pass}` : ''} --server-threads 2
    volumes:
      - data:/data
volumes:
  data:`,
  },
  DRAGONFLY: {
    image: 'docker.dragonflydb.io/dragonflydb/dragonfly:latest',
    defaultPort: 6379,
    portBase: 6490,
    compose: (name, _user, pass, port) => `services:
  ${name}:
    image: docker.dragonflydb.io/dragonflydb/dragonfly:latest
    container_name: dockcontrol-db-${name}
    restart: unless-stopped
    ports:
      - "${port}:6379"
    ulimits:
      memlock: -1
    command: ["--logtostderr"${pass ? `, "--requirepass=${pass}"` : ''}]
    volumes:
      - data:/data
volumes:
  data:`,
  },
  CLICKHOUSE: {
    image: 'clickhouse/clickhouse-server:latest',
    defaultPort: 8123,
    portBase: 8130,
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: clickhouse/clickhouse-server:latest
    container_name: dockcontrol-db-${name}
    restart: unless-stopped
    ports:
      - "${port}:8123"
      - "${port + 1000}:9000"
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    environment:
      CLICKHOUSE_DB: ${name}
      CLICKHOUSE_USER: ${user}
      CLICKHOUSE_PASSWORD: ${pass}
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: 1
    volumes:
      - data:/var/lib/clickhouse
volumes:
  data:`,
  },
};

/**
 * Render the compose body for a managed database from its already-DECRYPTED
 * password. Returns null for an unknown type. Callers must decrypt the stored
 * password first (this module is dependency-free and never touches crypto).
 */
export function renderDbCompose(db: {
  name: string;
  type: string;
  username: string;
  port: number;
}, decryptedPassword: string): string | null {
  const config = DB_CONFIGS[db.type];
  if (!config) return null;
  return config.compose(db.name, db.username, decryptedPassword, db.port);
}
