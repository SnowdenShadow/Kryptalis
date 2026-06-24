import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDatabaseDto } from './dto/create-database.dto';
import { DbType } from '@prisma/client';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { randomBytes, randomInt } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectDatabasesInCompose, type DetectedDb } from './compose-db-detect';
import { resolveDbContainer, dumpPlan, restorePlan } from './db-dump.util';
import { slugify, resolveAppDir } from '../applications/applications.helpers';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { DBS_DIR } from '../../common/paths';
import { AgentService } from '../agent/agent.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';

// execFile (array argv, no shell) — container/DB names must never reach a
// shell even though the DTO restricts them; defence in depth.
const execFileAsync = promisify(execFile);
const compose = (args: string[], opts: { cwd?: string; timeout?: number } = {}) =>
  execFileAsync('docker', ['compose', ...args], opts);

const DB_CONFIGS: Record<string, { image: string; defaultPort: number; portBase: number; compose: (name: string, user: string, pass: string, port: number) => string }> = {
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

@Injectable()
export class DatabasesService {
  private readonly logger = new Logger(DatabasesService.name);

  constructor(
    private prisma: PrismaService,
    private agent: AgentService,
    private encryption: EncryptionService,
  ) {
    if (!fs.existsSync(DBS_DIR)) fs.mkdirSync(DBS_DIR, { recursive: true });
  }

  /** Decrypt a stored DB password. Legacy plaintext rows are returned as-is. */
  private dbPassword(db: { password: string }): string {
    return this.encryption.decrypt(db.password);
  }

  /**
   * Resolve the server a database runs on: the DB row's OWN serverId first
   * (per-DB placement — set at create time, default = project server), then
   * the project / parent-app fallbacks for legacy rows.
   */
  private async resolveDbServer(dbId: string) {
    const db = await this.prisma.database.findUnique({
      where: { id: dbId },
      select: {
        server: { select: { id: true, host: true } },
        project: { select: { server: { select: { id: true, host: true } } } },
        application: { select: { project: { select: { server: { select: { id: true, host: true } } } } } },
      },
    });
    return db?.server ?? db?.project?.server ?? db?.application?.project?.server ?? null;
  }

  private isDbLocal(server: { host: string } | null): boolean {
    if (!server) return true;
    return isLocalHost(server.host);
  }

  /**
   * Host to advertise in connection strings: the server's address when the
   * DB lives on a remote host, 'localhost' otherwise. Previously hardcoded
   * to localhost — connection strings for remote-server DBs were unusable.
   */
  private connHost(server: { host: string } | null | undefined): string {
    return server && !isLocalHost(server.host) ? server.host : 'localhost';
  }

  // ── access ─────────────────────────────────────────────────────────

  private async assertDbAccess(
    userId: string,
    id: string,
    minRole: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' = 'VIEWER',
  ) {
    const db = await this.prisma.database.findUnique({ where: { id } });
    if (!db) throw new NotFoundException('Database not found');
    if (db.projectId) {
      await assertProjectAccess(this.prisma, userId, db.projectId, minRole);
    } else if (db.applicationId) {
      const app = await this.prisma.application.findUnique({
        where: { id: db.applicationId },
        select: { projectId: true },
      });
      if (app) await assertProjectAccess(this.prisma, userId, app.projectId, minRole);
    } else {
      // unlinked db (legacy) — only ADMIN or above can touch
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (!me || (me.role !== 'ADMIN' && me.role !== 'SUPERADMIN')) {
        throw new ForbiddenException('Unlinked databases are admin-only');
      }
    }
    return db;
  }

  // ── create ─────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateDatabaseDto) {
    const config = DB_CONFIGS[dto.type];
    if (!config) throw new NotFoundException(`Unsupported database type: ${dto.type}`);

    // resolve parent + access check
    let projectId = dto.projectId ?? null;
    let applicationId = dto.applicationId ?? null;

    if (applicationId) {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { projectId: true },
      });
      if (!app) throw new NotFoundException('Application not found');
      projectId = projectId || app.projectId;
      if (projectId !== app.projectId) {
        throw new BadRequestException("Application doesn't belong to the given project");
      }
    }

    if (!projectId) {
      throw new BadRequestException('projectId (or applicationId) is required');
    }
    await assertProjectAccess(this.prisma, userId, projectId, 'DEVELOPER');

    // Per-DB server placement, same model as apps: default = the project's
    // server; an explicit dto.serverId is honored after validating the
    // server EXISTS and is ONLINE. This is not a cross-tenant vector:
    // servers are platform-level resources (admin-managed fleet), there is
    // no per-tenant server ownership to violate — the project-membership
    // check above already gates who can provision into this project.
    const parentProject = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { serverId: true },
    });
    if (!parentProject) throw new NotFoundException('Project not found');
    let effectiveServerId = parentProject.serverId;
    if (dto.serverId && dto.serverId !== parentProject.serverId) {
      const target = await this.prisma.server.findUnique({ where: { id: dto.serverId } });
      if (!target) throw new NotFoundException('Server not found');
      if (target.status !== 'ONLINE') {
        throw new BadRequestException(`Server "${target.name}" is ${target.status} — choose an ONLINE server`);
      }
      effectiveServerId = target.id;
    }

    // Database name is project-scoped now — two tenants can both have
    // 'app-db' without colliding on a global namespace. The on-disk dir
    // also uses db.id (set after create) instead of db.name to avoid
    // cross-tenant collisions in /databases/<name>.
    const existing = await this.prisma.database.findFirst({
      where: { name: dto.name, projectId },
    });
    if (existing) {
      throw new ConflictException(
        `Database "${dto.name}" already exists in this project. Pick another name.`,
      );
    }

    const username = dto.username || dto.name.replace(/-/g, '_');
    // CSPRNG — Math.random() is predictable and was a credential-guessing
    // vector for DB containers whose host port is published.
    const password = dto.password || `dockcontrol_${randomBytes(12).toString('base64url')}`;
    const hostPort = await this.allocateHostPort(config.portBase);

    const db = await this.prisma.database.create({
      data: {
        name: dto.name,
        type: dto.type as DbType,
        serverId: effectiveServerId,
        projectId,
        applicationId,
        port: hostPort,
        username,
        password: this.encryption.encrypt(password),
      },
    });

    // Resolve the target server — the DB's OWN serverId (which is either the
    // project default or the explicitly-validated pick above).
    const server = await this.prisma.server.findUnique({
      where: { id: effectiveServerId },
      select: { id: true, host: true },
    });
    if (this.isDbLocal(server)) {
      // Deliberately not awaited — container start can take minutes (pull);
      // the row is returned as 'deploying' and status polling reflects
      // reality. launchContainer logs its own failures.
      void this.launchContainer(dto.name, dto.type, username, password, hostPort);
    } else if (server) {
      const composeYaml = config.compose(dto.name, username, password, hostPort);
      await this.agent.enqueueTask(server.id, 'DEPLOY', {
        slug: `db-${dto.name}`,
        appName: `db-${dto.name}`,
        compose: composeYaml,
      });
    }

    return { ...db, status: 'deploying', connectionString: this.getConnectionString(dto.type, username, password, hostPort, dto.name, this.connHost(server)) };
  }

  // ── read ───────────────────────────────────────────────────────────

  async findAll(userId: string, opts: { serverId?: string; projectId?: string; applicationId?: string }) {
    const where: any = {};
    if (opts.serverId) where.serverId = opts.serverId;
    if (opts.projectId) where.projectId = opts.projectId;
    if (opts.applicationId) where.applicationId = opts.applicationId;

    // visibility: any DB attached to a project the user can access
    const projectIds = await listAccessibleProjectIds(this.prisma, userId);
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const isPlatformAdmin = me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';

    if (!isPlatformAdmin) {
      where.OR = [{ projectId: { in: projectIds } }];
      // applicationId branch already covered via projectId once we backfill;
      // but the schema allows app-only attachment, so include it explicitly:
      where.OR.push({ application: { projectId: { in: projectIds } } });
    }

    const dbs = await this.prisma.database.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        project: { select: { id: true, name: true } },
        application: { select: { id: true, name: true } },
        // server.host feeds the connection string for remote DBs — loaded
        // via include so we don't N+1 a server query per row.
        server: { select: { host: true } },
      },
    });

    return Promise.all(dbs.map(async (db) => {
      const status = await this.getContainerStatus(resolveDbContainer(db as any));
      const connectionString = this.getConnectionString(db.type, db.username, this.dbPassword(db), db.port, db.name, this.connHost((db as any).server));
      return { ...db, status, connectionString };
    }));
  }

  async findOne(userId: string, id: string) {
    await this.assertDbAccess(userId, id, 'VIEWER');
    const db = await this.prisma.database.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        application: { select: { id: true, name: true } },
        server: { select: { host: true } },
      },
    });
    if (!db) throw new NotFoundException('Database not found');
    const status = await this.getContainerStatus(resolveDbContainer(db as any));
    const connectionString = this.getConnectionString(db.type, db.username, this.dbPassword(db), db.port, db.name, this.connHost((db as any).server));
    return { ...db, status, connectionString };
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async start(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'DEVELOPER');
    // Auto-imported DBs are owned by the parent app's compose stack — calling
    // `docker compose` in our DBS_DIR would no-op (the YAML doesn't exist
    // there). Force the user to operate on the parent app instead.
    if ((db as any).autoImported) {
      throw new BadRequestException(
        'This database is managed by its parent application. Start it from the application page.',
      );
    }
    const slug = `db-${db.name}`;
    const server = await this.resolveDbServer(id);
    if (this.isDbLocal(server)) {
      const dbDir = path.join(DBS_DIR, db.name);
      if (fs.existsSync(dbDir)) {
        await compose(['up', '-d'], { cwd: dbDir, timeout: 30000 });
      }
    } else if (server) {
      await this.agent.enqueueTask(server.id, 'START', { slug });
    }
    return { message: 'Database started' };
  }

  async stop(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'DEVELOPER');
    if ((db as any).autoImported) {
      throw new BadRequestException(
        'This database is managed by its parent application. Stop it from the application page.',
      );
    }
    const slug = `db-${db.name}`;
    const server = await this.resolveDbServer(id);
    if (this.isDbLocal(server)) {
      const dbDir = path.join(DBS_DIR, db.name);
      if (fs.existsSync(dbDir)) {
        await compose(['stop'], { cwd: dbDir, timeout: 30000 });
      }
    } else if (server) {
      await this.agent.enqueueTask(server.id, 'STOP', { slug });
    }
    return { message: 'Database stopped' };
  }

  async remove(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'ADMIN');
    const server = await this.resolveDbServer(id);
    const autoImported = (db as any).autoImported as boolean;

    // ── Auto-imported (bundled) DB: lives inside its parent app's compose
    //    stack, NOT in DBS_DIR. There's no standalone compose dir to `down`,
    //    so we tear down the real sidecar CONTAINER (its name is stored in
    //    `host`, resolved via the shared helper) + drop its volume, then the
    //    row. We deliberately allow this now (was a hard 400): a bundled DB is
    //    a database like any other. CAVEAT surfaced in the return message: if
    //    the parent app still exists, its stack is now incomplete and a
    //    redeploy of the app will re-create the sidecar (and re-import the
    //    row) — to remove it for good, delete the application.
    if (autoImported) {
      const container = resolveDbContainer(db); // = db.host for bundled rows
      if (this.isDbLocal(server)) {
        // Discover the container's named volumes BEFORE removing it (after
        // `rm` the mounts are gone). Best-effort throughout — a missing
        // container/volume must not block the row delete.
        let volumes: string[] = [];
        try {
          const { stdout } = await execFileAsync(
            'docker',
            ['inspect', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', container],
            { timeout: 10_000 },
          );
          volumes = stdout.trim().split(/\s+/).filter(Boolean);
        } catch {}
        try { await execFileAsync('docker', ['rm', '-f', container], { timeout: 15_000 }); } catch {}
        for (const v of volumes) {
          try { await execFileAsync('docker', ['volume', 'rm', '-f', v], { timeout: 10_000 }); } catch {}
        }
      } else if (server) {
        // Remote: ask the agent to remove just this container + its volumes.
        try {
          await this.agent.enqueueTask(server.id, 'REMOVE', {
            slug: `db-${db.name}`,
            containerName: container,
            purgeVolumes: true,
          });
        } catch (err: any) {
          this.logger.warn(`failed to enqueue remote REMOVE for bundled "${db.name}": ${err?.message || err}`);
        }
      }
      await this.prisma.database.delete({ where: { id } });
      const appId = (db as any).applicationId as string | null;
      return {
        message: appId
          ? 'Database removed. It was bundled in an application — that app\'s stack is now incomplete, and redeploying the app will recreate this database. Delete the application to remove it permanently.'
          : 'Database removed.',
      };
    }

    // ── Standalone DB: managed in its own DBS_DIR compose stack. ───────
    const containerName = `dockcontrol-db-${db.name}`;
    const slug = `db-${db.name}`;

    if (this.isDbLocal(server)) {
      const dbDir = path.join(DBS_DIR, db.name);
      if (fs.existsSync(dbDir)) {
        try { await compose(['down', '-v', '--remove-orphans'], { cwd: dbDir, timeout: 30000 }); } catch {}
        fs.rmSync(dbDir, { recursive: true, force: true });
      }
      try { await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 10000 }); } catch {}
    } else if (server) {
      // Best-effort, same contract as the local path (which swallows compose
      // down / docker rm failures): an unreachable agent must not keep a
      // zombie registry row alive — the row is deleted regardless.
      try {
        await this.agent.enqueueTask(server.id, 'REMOVE', {
          slug,
          containerName,
          purgeVolumes: true,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[databases] failed to enqueue remote REMOVE for "${db.name}":`, err);
      }
    }

    await this.prisma.database.delete({ where: { id } });
    return { message: 'Database deleted' };
  }

  // ── export (one-click dump download) ───────────────────────────────
  //
  // Streams a logical dump of a single database for the user to download.
  // Reuses the exact dump command shapes proven in BackupsService so the
  // output is restore-compatible with that flow.
  //
  // Scope (kept deliberately narrow — fail loud rather than half-work):
  //   - LOCAL server only. Remote-server DBs run on a machine this API can't
  //     `docker exec` into; those are covered by the Backups module (agent
  //     dump → S3). We point the user there instead of shipping a fragile
  //     parallel remote path.
  //   - Engines with a portable exec dump: Postgres / MySQL / MariaDB /
  //     Mongo / Redis / KeyDB. ClickHouse / Dragonfly have no dump strategy
  //     (same gap as Backups) → 400.
  //   - Auto-imported rows dump the WHOLE instance (the logical db name isn't
  //     tracked — `name` is a display label); manual rows dump their one db.
  //
  // Returns a child-process stdout stream + the suggested filename. The
  // controller pipes it straight to the HTTP response (no temp file on disk).
  async exportDump(
    userId: string,
    id: string,
  ): Promise<{ stream: NodeJS.ReadableStream; filename: string; cleanup?: () => void }> {
    const db = await this.assertDbAccess(userId, id, 'DEVELOPER');
    const server = await this.resolveDbServer(id);
    if (!this.isDbLocal(server)) {
      throw new BadRequestException(
        'This database runs on a remote server. Use Backups (Backups → Create) to dump it — remote dumps are handled by the agent.',
      );
    }

    const autoImported = (db as any).autoImported as boolean;
    const dumpable = {
      name: db.name,
      type: db.type,
      username: db.username,
      password: this.dbPassword(db),
      autoImported,
      host: db.host,
    };
    const container = resolveDbContainer(dumpable);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const safeName = (db.name || 'database').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);

    // Single source of truth for the dump command shapes (shared with Backups
    // + project-transfer). Auto-imported rows dump the WHOLE instance — the
    // logical db name isn't tracked (name is a display label).
    const plan = dumpPlan(dumpable, container, { dumpAll: autoImported });
    if (!plan) {
      throw new BadRequestException(
        `Export not supported for ${db.type}. Use the database's own GUI (e.g. DBGate) to export.`,
      );
    }

    // Redis needs a synchronous SAVE before the rdb is readable.
    if (plan.prepArgv) {
      await execFileAsync('docker', plan.prepArgv, { timeout: 300_000 });
    }

    // Engines that take the password via env (MySQL/MariaDB) get a 0600 temp
    // --env-file spliced after `exec`, never the host argv (ps leak). Unlinked
    // by cleanup() once the stream is fully consumed.
    let argv = plan.argv;
    let cleanup: (() => void) | undefined;
    if (plan.envFileContent) {
      const envFile = path.join(os.tmpdir(), `dockcontrol-export-${randomBytes(8).toString('hex')}.env`);
      fs.writeFileSync(envFile, plan.envFileContent, { mode: 0o600 });
      argv = [plan.argv[0], '--env-file', envFile, ...plan.argv.slice(1)];
      cleanup = () => { try { fs.unlinkSync(envFile); } catch {} };
    }

    // Spawn `docker <argv>` and hand the stdout stream back as the download
    // body. A non-zero exit can't un-send bytes already streamed, so we
    // re-emit the failure on the stdout stream — the controller's error
    // handler destroys the HTTP response, giving the client a failed transfer
    // rather than a silently truncated dump.
    const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString(); });
    child.once('close', (code) => {
      if (code !== 0) child.stdout.emit('error', new Error(`dump exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
    child.once('error', (err) => child.stdout.emit('error', err));

    return { stream: child.stdout, filename: `${safeName}-${stamp}.${plan.ext}`, cleanup };
  }

  /**
   * Replay a gzip'd SQL/archive dump into a freshly-created LOCAL database
   * (project-transfer import of a STANDALONE db). Waits for the container to
   * accept connections, then streams gunzip → the engine's restore command
   * (shared restorePlan, symmetric with the export dump).
   *
   * `gzPath` is a host file the caller owns; we do NOT delete it (the caller's
   * cleanup does). Best-effort: logs + throws on failure so the importer can
   * surface a warning, but never leaves a half-applied silent success.
   *
   * Redis (.rdb, copy-restart) isn't reachable this way — its data travels via
   * its volume tar in practice; we only handle the stdin-replay engines here.
   */
  async restoreDbDump(dbId: string, gzPath: string): Promise<void> {
    const db = await this.prisma.database.findUnique({ where: { id: dbId } });
    if (!db) throw new NotFoundException('Database not found');
    const dumpable = {
      name: db.name, type: db.type, username: db.username,
      password: this.dbPassword(db), autoImported: (db as any).autoImported, host: db.host,
    };
    const container = resolveDbContainer(dumpable);
    // dumpAll mirrors how the dump was taken (auto-imported = whole instance);
    // standalone project-transfer dumps are single-db. Steers the Postgres
    // target db so tables don't land in the wrong database.
    const plan = restorePlan(dumpable, container, { dumpAll: !!dumpable.autoImported });
    if (!plan || plan.mode !== 'stdin') {
      throw new BadRequestException(`No stdin restore strategy for ${db.type}.`);
    }

    // Wait until the container exists AND the engine answers (a fresh DB
    // container can take a while to initialise on first boot).
    await this.waitForDbReady(container, db.type, dumpable.username);

    // MySQL/MariaDB password via temp --env-file spliced after `exec -i`.
    let argv = plan.argv;
    let envFile: string | undefined;
    if (plan.envFileContent) {
      envFile = path.join(os.tmpdir(), `dockcontrol-restore-${randomBytes(8).toString('hex')}.env`);
      fs.writeFileSync(envFile, plan.envFileContent, { mode: 0o600 });
      // argv = ['exec','-i',container,...] → insert env-file after 'exec'.
      argv = [argv[0], argv[1], '--env-file', envFile, ...argv.slice(2)];
    }

    try {
      const zlib = await import('zlib');
      await new Promise<void>((resolve, reject) => {
        const child = spawn('docker', argv, { stdio: ['pipe', 'ignore', 'pipe'] });
        const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString(); });
        const src = fs.createReadStream(gzPath);
        const gz = zlib.createGunzip();
        src.once('error', (err) => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} reject(err); });
        gz.once('error', (err) => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} reject(err); });
        src.pipe(gz).pipe(child.stdin);
        child.stdin.once('error', () => undefined); // early-exit EPIPE; code carries the error
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`restore exited ${code}: ${stderr.trim().slice(0, 300)}`));
        });
      });
    } finally {
      if (envFile) { try { fs.unlinkSync(envFile); } catch {} }
    }
  }

  /** Poll until a DB container answers a trivial query (or time out ~90s). */
  private async waitForDbReady(container: string, type: string, user: string): Promise<void> {
    const t = (type || '').toUpperCase();
    // Liveness only — we never auth here. `mysqladmin ping` reports success even
    // on access-denied (the server answered), which is all the readiness gate
    // needs, and it keeps the DB password OFF the host process argv (a `-e
    // MYSQL_PWD=` here would leak it via ps for every 3s retry).
    const probe: string[] | null =
      t === 'POSTGRESQL' ? ['exec', container, 'pg_isready', '-U', user]
      : t === 'MYSQL' || t === 'MARIADB' ? ['exec', container, 'mysqladmin', 'ping', '--silent']
      : t === 'MONGODB' ? ['exec', container, 'mongosh', '--quiet', '--eval', 'db.runCommand({ ping: 1 })']
      : null;
    if (!probe) return;
    const deadline = Date.now() + 90_000;
    // small fixed backoff loop — first boot of a DB image (initdb) is the slow case
    while (Date.now() < deadline) {
      try {
        await execFileAsync('docker', probe, { timeout: 10_000 });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    throw new Error(`database container ${container} did not become ready within 90s`);
  }

  // ── link / unlink ──────────────────────────────────────────────────

  async setParent(
    userId: string,
    id: string,
    payload: { projectId?: string | null; applicationId?: string | null },
  ) {
    const db = await this.assertDbAccess(userId, id, 'ADMIN');
    let projectId = payload.projectId ?? db.projectId ?? null;
    let applicationId = payload.applicationId ?? null;
    if (applicationId) {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { projectId: true },
      });
      if (!app) throw new NotFoundException('Application not found');
      projectId = projectId || app.projectId;
      if (projectId !== app.projectId) {
        throw new BadRequestException("Application doesn't belong to the given project");
      }
    }
    if (projectId) {
      await assertProjectAccess(this.prisma, userId, projectId, 'DEVELOPER');
    }
    return this.prisma.database.update({
      where: { id },
      data: { projectId, applicationId },
      include: {
        project: { select: { id: true, name: true } },
        application: { select: { id: true, name: true } },
      },
    });
  }

  // ── helpers ────────────────────────────────────────────────────────

  /**
   * Pick a host port in [base, base+200) that no other Database row uses.
   * The previous random pick (base + rand*50) had no collision check — two
   * DBs of the same type could land on the same port and the second
   * container would fail to start. Random start point keeps allocations
   * spread; the linear scan guarantees uniqueness against the DB table.
   */
  private async allocateHostPort(base: number): Promise<number> {
    const RANGE = 200;
    const taken = new Set(
      (
        await this.prisma.database.findMany({
          where: { port: { gte: base, lt: base + RANGE } },
          select: { port: true },
        })
      ).map((d) => d.port),
    );
    const start = randomInt(RANGE);
    for (let i = 0; i < RANGE; i++) {
      const port = base + ((start + i) % RANGE);
      if (!taken.has(port)) return port;
    }
    throw new ConflictException(
      `No free host port left in ${base}-${base + RANGE - 1}. Remove unused databases first.`,
    );
  }

  private async launchContainer(name: string, type: string, user: string, pass: string, port: number) {
    const config = DB_CONFIGS[type];
    if (!config) return;

    const dbDir = path.join(DBS_DIR, name);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'docker-compose.yml'), config.compose(name, user, pass, port));

    try {
      await compose(['pull'], { cwd: dbDir, timeout: 120000 });
      await compose(['up', '-d'], { cwd: dbDir, timeout: 60000 });
    } catch (err) {
      // Surface the failure in the API logs — the row exists but the
      // container didn't start; status polling will show 'not running'.
      // eslint-disable-next-line no-console
      console.error(`[databases] failed to launch container for "${name}":`, err);
    }
  }

  // Takes the ALREADY-RESOLVED container name (callers use resolveDbContainer,
  // the single source of truth for auto-imported vs standalone naming).
  private async getContainerStatus(container: string): Promise<string> {
    try {
      // execFile: arbitrary container_name strings from auto-imported rows
      // never touch a shell.
      const { stdout } = await execFileAsync(
        'docker',
        ['inspect', '--format', '{{.State.Status}}', container],
        { timeout: 5000 },
      );
      return stdout.trim() || 'unknown';
    } catch {
      return 'not running';
    }
  }

  // ── auto-import from a stack's docker-compose.yml ──────────────────
  //
  // Called by ApplicationsService right after `docker compose up -d`
  // succeeds (compose-only deploys + marketplace installs that include
  // bundled DB services). For each detected DB service we upsert a
  // `Database` row attached to the app + project so:
  //   - RBAC works (any project member sees the DB via projectId)
  //   - the /databases dashboard shows it next to manually-provisioned ones
  //   - cleanup cascades when the parent app is removed
  //
  // Idempotent on redeploy thanks to the @@unique([applicationId, serviceName])
  // — every redeploy upserts the same row instead of stacking duplicates.
  // Errors here are swallowed (logged but never crash the deploy) because
  // the actual containers ARE running by the time we get here.
  async importFromAppCompose(opts: {
    applicationId: string;
    projectId: string;
    serverId: string;
    composeYaml: string;
  }): Promise<{ created: number; updated: number; skipped: number }> {
    let detected: DetectedDb[] = [];
    try {
      detected = detectDatabasesInCompose(opts.composeYaml);
    } catch {
      return { created: 0, updated: 0, skipped: 0 };
    }
    if (detected.length === 0) return { created: 0, updated: 0, skipped: 0 };

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const db of detected) {
      try {
        // The detected password may be blank — Redis-like images often ship
        // without one, and the detector can't always recover a real value
        // (e.g. a password injected at runtime). We must NOT clobber a
        // previously-stored real password with an encrypted empty string on
        // redeploy, so the update path below only writes `password` when a
        // real value was detected (see the conditional spread).
        const password = db.password || '';

        const existing = await this.prisma.database.findFirst({
          where: { applicationId: opts.applicationId, serviceName: db.serviceName },
        });

        // Name shown in the dashboard. We prefix with the app slug-ish service
        // name so two apps both bundling `db` don't display ambiguously. The
        // @@unique constraint is on (applicationId, serviceName) — `name` can
        // collide across apps freely.
        const displayName = `${db.serviceName}@${opts.applicationId.slice(0, 6)}`;
        // Host = the DB's REAL container_name (other apps reach it by this name;
        // the UI shows it; lifecycle ops docker-exec into it). The detector
        // returns an explicit container_name when the compose declares one, else
        // it falls back to the bare SERVICE name (== db.serviceName) and asks
        // the caller to resolve the real one. When that happens we ask docker
        // for the actual container of this compose service — otherwise `host`
        // would be a name no container answers to, and status/export/restore/
        // DELETE would all silently target nothing (orphaning the real
        // container on delete). resolveLiveComposeContainer falls back to the
        // detector value if docker can't be reached.
        const host = db.containerName === db.serviceName
          ? await this.resolveLiveComposeContainer(opts.applicationId, db.serviceName)
          : db.containerName;
        const port = db.hostPort ?? db.containerPort;

        if (existing) {
          await this.prisma.database.update({
            where: { id: existing.id },
            data: {
              type: db.type,
              host,
              port,
              username: db.username,
              // Only overwrite the stored password when a real value was
              // detected. A blank detection on redeploy must NOT replace an
              // existing non-empty password with encrypted "" — that breaks
              // every connection string built from this row.
              ...(password ? { password: this.encryption.encrypt(password) } : {}),
              autoImported: true,
              serverId: opts.serverId,
              projectId: opts.projectId,
              applicationId: opts.applicationId,
            },
          });
          updated++;
        } else {
          await this.prisma.database.create({
            data: {
              name: displayName,
              type: db.type,
              serverId: opts.serverId,
              projectId: opts.projectId,
              applicationId: opts.applicationId,
              host,
              port,
              username: db.username,
              password: this.encryption.encrypt(password),
              autoImported: true,
              serviceName: db.serviceName,
            },
          });
          created++;
        }
      } catch {
        // Single-DB import failure (collision, encryption error, etc.)
        // must NOT break the whole batch — keep going.
        skipped++;
      }
    }

    return { created, updated, skipped };
  }

  /**
   * Resolve the REAL docker container_name of a bundled DB service that the
   * compose did NOT name explicitly. Compose names such a container
   * `<project>-<service>-N` where project = the app dir basename. We ask docker
   * for the live container carrying the compose service+project labels (robust
   * against the `-1`/`-2` suffix + name sanitization). Falls back to the bare
   * service name if docker is unreachable or nothing matches (no worse than the
   * previous behaviour, and a redeploy re-runs this).
   */
  private async resolveLiveComposeContainer(applicationId: string, serviceName: string): Promise<string> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { name: true },
      });
      if (!app) return serviceName;
      const project = path.basename(resolveAppDir(slugify(app.name), applicationId));
      const { stdout } = await execFileAsync(
        'docker',
        [
          'ps', '--format', '{{.Names}}',
          '--filter', `label=com.docker.compose.project=${project}`,
          '--filter', `label=com.docker.compose.service=${serviceName}`,
        ],
        { timeout: 10_000 },
      );
      const name = stdout.trim().split('\n').map((s) => s.trim()).find(Boolean);
      return name || serviceName;
    } catch {
      return serviceName;
    }
  }

  // ── cleanup helper for ApplicationsService ─────────────────────────
  //
  // Called from ApplicationsService.remove() BEFORE deleting the app row.
  // We drop only the auto-imported rows; manually-provisioned DBs that
  // happened to be linked via applicationId fall back to SetNull cascade
  // so the registry row survives.
  async deleteAutoImportedForApp(applicationId: string): Promise<number> {
    const r = await this.prisma.database.deleteMany({
      where: { applicationId, autoImported: true },
    });
    return r.count;
  }

  private getConnectionString(type: string, user: string, pass: string, port: number, name: string, host = 'localhost'): string {
    switch (type) {
      case 'POSTGRESQL': return `postgresql://${user}:${pass}@${host}:${port}/${name}`;
      case 'MYSQL':
      case 'MARIADB': return `mysql://${user}:${pass}@${host}:${port}/${name}`;
      // KeyDB + Dragonfly are wire-compatible with Redis → same scheme.
      case 'REDIS':
      case 'KEYDB':
      case 'DRAGONFLY': return `redis://${pass ? `:${pass}@` : ''}${host}:${port}`;
      case 'MONGODB': return `mongodb://${user}:${pass}@${host}:${port}/${name}`;
      // ClickHouse: HTTP scheme so libs like clickhouse-js Just Work.
      case 'CLICKHOUSE': return `http://${user}:${pass}@${host}:${port}/?database=${name}`;
      default: return `${host}:${port}`;
    }
  }
}
