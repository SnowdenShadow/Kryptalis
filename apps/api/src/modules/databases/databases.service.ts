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
import { DB_CONFIGS } from './db-configs';
import {
  slugify,
  resolveAppDir,
  attachProjectNetwork,
  projectNetworkName,
} from '../applications/applications.helpers';
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
      // reality. launchContainer logs its own failures. Pass projectId so the
      // DB joins its project network → sibling apps/sites reach it by name.
      void this.launchContainer(dto.name, dto.type, username, password, hostPort, projectId);
    } else if (server) {
      // Remote: attach the project network to the shipped compose too, so a
      // remote app in the same project can resolve the DB by container_name.
      let composeYaml = config.compose(dto.name, username, password, hostPort);
      if (projectId) composeYaml = attachProjectNetwork(composeYaml, projectNetworkName(projectId));
      await this.agent.enqueueTask(server.id, 'DEPLOY', {
        slug: `db-${dto.name}`,
        appName: `db-${dto.name}`,
        compose: composeYaml,
      });
    }

    // Return the PLAINTEXT password (the local var) — `db.password` from the
    // create is the AES-GCM envelope and must never reach the client.
    return { ...db, password, status: 'deploying', connectionString: this.getConnectionString(dto.type, username, password, hostPort, dto.name, this.connHost(server)) };
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
      // Container→container target (what another app in the project must use:
      // <db-container>:<internal-port>, NOT localhost:<published-port>). Same
      // data connectionInfo() already exposes — surfaced here so the card can
      // show it without a second fetch.
      const inNetwork = this.inNetworkConnectionInfo({
        name: db.name, type: db.type, username: db.username,
        password: db.password, autoImported: (db as any).autoImported, host: db.host,
      });
      // Expose the DECRYPTED password to API consumers (the dashboard shows it,
      // same as the connection string). The raw row stores it AES-GCM encrypted
      // (`v1.…`) — never leak that envelope to the client.
      return {
        ...db, password: this.dbPassword(db), status, connectionString,
        inNetwork: { host: inNetwork.host, port: inNetwork.port, url: inNetwork.url },
      };
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
    const inNetwork = this.inNetworkConnectionInfo({
      name: db.name, type: db.type, username: db.username,
      password: db.password, autoImported: (db as any).autoImported, host: db.host,
    });
    // Decrypted password for the client (matches connectionString); the stored
    // row keeps the AES-GCM envelope.
    return {
      ...db, password: this.dbPassword(db), status, connectionString,
      inNetwork: { host: inNetwork.host, port: inNetwork.port, url: inNetwork.url },
    };
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

  // ── credential management (reset password / rename user / restart) ──
  //
  // SQL engines only (Postgres / MySQL / MariaDB). The password / username are
  // applied INSIDE the live container (the volume is the source of truth at
  // runtime — env POSTGRES_*/MYSQL_* only seed an empty volume on first boot),
  // re-encrypted at rest, and the linked application's DB_* env is refreshed +
  // redeployed so it never loses the connection.

  /** Engines whose user credentials we can manage via SQL. */
  private static readonly SQL_ENGINES = new Set(['POSTGRESQL', 'MYSQL', 'MARIADB']);

  /**
   * Common guard for credential ops: DEVELOPER access, not auto-imported (owned
   * by the parent app), runs locally (we exec into the container), SQL engine.
   * Returns the db row + resolved container name.
   */
  private async assertManageableSqlDb(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'DEVELOPER');
    if ((db as any).autoImported) {
      throw new BadRequestException(
        'This database is managed by its parent application. Change its credentials from the application instead.',
      );
    }
    if (!DatabasesService.SQL_ENGINES.has(db.type)) {
      throw new BadRequestException(
        `Credential management isn't supported for ${db.type}. Only PostgreSQL, MySQL and MariaDB are supported.`,
      );
    }
    const server = await this.resolveDbServer(id);
    if (!this.isDbLocal(server)) {
      throw new BadRequestException(
        'This database runs on a remote server — manage its credentials from that server.',
      );
    }
    const container = resolveDbContainer({ name: db.name, autoImported: false, host: db.host || '' });
    return { db, container };
  }

  /**
   * Run SQL in a Postgres container as a SPECIFIC role over the unix socket.
   * The official postgres image uses `trust` auth for local socket connections,
   * so no password is needed — and the password never touches the argv. SQL on
   * stdin; ON_ERROR_STOP=1 → non-zero exit on any SQL error.
   */
  private async pgExec(container: string, asRole: string, dbName: string, sql: string): Promise<void> {
    await this.execWithStdin(
      'docker',
      ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', asRole, '-d', dbName],
      sql,
    );
  }

  /**
   * Run admin SQL in a MySQL/MariaDB container AS ROOT. We keep root's password
   * in sync with the stored app password (see resetPassword), so the current
   * stored password authenticates root. Password via a 0600 --env-file
   * (MYSQL_PWD), never `-p<pass>` on the argv (a `ps` leak).
   */
  private async mysqlRootExec(container: string, rootPw: string, sql: string): Promise<void> {
    const envFile = path.join(os.tmpdir(), `dockcontrol-dbadmin-${randomBytes(8).toString('hex')}.env`);
    fs.writeFileSync(envFile, `MYSQL_PWD=${rootPw}\n`, { mode: 0o600 });
    try {
      await this.execWithStdin(
        'docker',
        ['exec', '-i', '--env-file', envFile, container, 'mysql', '-u', 'root'],
        sql,
      );
    } finally {
      try { fs.unlinkSync(envFile); } catch {}
    }
  }

  /** Spawn a command, write `input` to its stdin, resolve on exit 0 else throw. */
  private execWithStdin(cmd: string, args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString(); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new BadRequestException(`Database command failed: ${stderr.trim().slice(0, 300) || `exit ${code}`}`));
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  /** A strong random password (same CSPRNG/shape as create). */
  private generatePassword(): string {
    return `dockcontrol_${randomBytes(12).toString('base64url')}`;
  }

  /**
   * Reset a DB user's password: apply it in the container, re-encrypt at rest,
   * then refresh + redeploy the linked application so its DB_* env stays valid.
   * Returns the new password ONCE (the caller shows it to the user).
   */
  async resetPassword(userId: string, id: string, dto: { password?: string }): Promise<{ password: string; redeployedApp: boolean | null }> {
    const { db, container } = await this.assertManageableSqlDb(userId, id);
    const newPw = dto.password?.trim() || this.generatePassword();
    // newPw is charset-restricted by the DTO (no quotes) → safe to interpolate
    // into the single-quoted SQL literal.
    const type = db.type.toUpperCase();
    if (type === 'POSTGRESQL') {
      // Changing your OWN password is allowed — connect as the user itself over
      // the trust-auth unix socket (no password on the argv).
      await this.pgExec(container, db.username, db.name, `ALTER USER "${db.username}" WITH PASSWORD '${newPw}';`);
    } else {
      // MySQL/MariaDB: authenticate as root with the CURRENT stored password
      // (root's password is kept == the app password, seeded equal at create),
      // and change the app user AND root in lockstep so the next admin op still
      // authenticates. IF EXISTS guards a root@'%' that may not exist.
      await this.mysqlRootExec(container, this.dbPassword(db),
        `ALTER USER '${db.username}'@'%' IDENTIFIED BY '${newPw}'; ` +
        `ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY '${newPw}'; ` +
        `ALTER USER 'root'@'localhost' IDENTIFIED BY '${newPw}'; FLUSH PRIVILEGES;`,
      );
    }

    await this.prisma.database.update({
      where: { id },
      data: { password: this.encryption.encrypt(newPw) },
    });

    const redeployedApp = await this.refreshLinkedApp(userId, id);
    return { password: newPw, redeployedApp };
  }

  /** Rename a DB user, persist it, and refresh the linked application. */
  async changeUsername(userId: string, id: string, dto: { username: string }): Promise<{ username: string; redeployedApp: boolean | null }> {
    const { db, container } = await this.assertManageableSqlDb(userId, id);
    const newUser = dto.username.trim();
    if (newUser === db.username) {
      return { username: newUser, redeployedApp: null };
    }
    const type = db.type.toUpperCase();
    // newUser is identifier-validated by the DTO regex.
    if (type === 'POSTGRESQL') {
      await this.pgRenameUser(container, db.name, db.username, newUser);
    } else {
      // MySQL/MariaDB rename requires admin privileges → run as root.
      await this.mysqlRootExec(container, this.dbPassword(db),
        `RENAME USER '${db.username}'@'%' TO '${newUser}'@'%'; FLUSH PRIVILEGES;`,
      );
    }

    await this.prisma.database.update({ where: { id }, data: { username: newUser } });

    const redeployedApp = await this.refreshLinkedApp(userId, id);
    return { username: newUser, redeployedApp };
  }

  /**
   * Rename a Postgres role. A role CANNOT rename itself ("session user cannot
   * be renamed"), and the image creates no separate `postgres` superuser (the
   * app user IS the bootstrap superuser). So: create a TEMP superuser, run the
   * rename from its session, then drop it — connecting as whichever of the
   * (new / old) role exists afterwards. All over the trust-auth socket.
   */
  private async pgRenameUser(container: string, dbName: string, oldUser: string, newUser: string): Promise<void> {
    const tmp = `dockctl_rename_${randomBytes(4).toString('hex')}`;
    // Create the temp admin as the current (superuser) app role.
    await this.pgExec(container, oldUser, dbName, `CREATE ROLE "${tmp}" WITH SUPERUSER LOGIN;`);
    try {
      await this.pgExec(container, tmp, dbName, `ALTER USER "${oldUser}" RENAME TO "${newUser}";`);
    } finally {
      // Cleanup: after success the role is newUser; after failure it's oldUser.
      // A session can't drop its own role, so connect as the renamed/original
      // user (not the temp role) to drop the temp. Best-effort.
      await this.pgExec(container, newUser, dbName, `DROP ROLE IF EXISTS "${tmp}";`).catch(() =>
        this.pgExec(container, oldUser, dbName, `DROP ROLE IF EXISTS "${tmp}";`).catch(() => {}),
      );
    }
  }

  /** Restart the database container (standalone, local). */
  async restart(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'DEVELOPER');
    if ((db as any).autoImported) {
      throw new BadRequestException(
        'This database is managed by its parent application. Restart it from the application page.',
      );
    }
    const server = await this.resolveDbServer(id);
    const slug = `db-${db.name}`;
    if (this.isDbLocal(server)) {
      const dbDir = path.join(DBS_DIR, db.name);
      if (fs.existsSync(dbDir)) {
        await compose(['restart'], { cwd: dbDir, timeout: 60000 });
      }
    } else if (server) {
      // No dedicated RESTART agent task — stop then start.
      await this.agent.enqueueTask(server.id, 'STOP', { slug });
      await this.agent.enqueueTask(server.id, 'START', { slug });
    }
    return { message: 'Database restarting' };
  }

  /** Full connection info for the "connect" panel (VIEWER access). */
  async connectionInfo(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'VIEWER');
    const server = await this.resolveDbServer(id);
    const password = this.dbPassword(db);
    const inNetwork = this.inNetworkConnectionInfo({
      name: db.name, type: db.type, username: db.username,
      password: db.password, autoImported: (db as any).autoImported, host: db.host,
    });
    return {
      type: db.type,
      host: this.connHost(server),
      port: db.port,
      database: db.name,
      username: db.username,
      password,
      url: this.getConnectionString(db.type, db.username, password, db.port, db.name, this.connHost(server)),
      inNetwork: { host: inNetwork.host, port: inNetwork.port, url: inNetwork.url },
    };
  }

  /**
   * After a credential change, refresh the linked application's DB_* env and
   * redeploy it. Decoupled via the lazily-resolved ApplicationsService (set by
   * ApplicationsModule to avoid a hard circular dependency). Returns:
   *   true  → an app was linked and redeployed,
   *   false → an app was linked but the redeploy failed (caller surfaces it),
   *   null  → no app is linked (nothing to do).
   */
  private async refreshLinkedApp(userId: string, dbId: string): Promise<boolean | null> {
    const db = await this.prisma.database.findUnique({
      where: { id: dbId },
      select: { applicationId: true },
    });
    if (!db?.applicationId) return null;
    if (!this.appRefresher) return null;
    return this.appRefresher(userId, db.applicationId, dbId);
  }

  /**
   * Injected by ApplicationsModule at init (setAppRefresher) to break the
   * Databases→Applications cycle. Rebuilds the app's DB_* env from the DB's
   * CURRENT (post-change) credentials and redeploys; resolves true/false on
   * redeploy success.
   */
  private appRefresher:
    | ((userId: string, applicationId: string, databaseId: string) => Promise<boolean>)
    | null = null;
  setAppRefresher(fn: (userId: string, applicationId: string, databaseId: string) => Promise<boolean>) {
    this.appRefresher = fn;
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

  /**
   * Link a DB to an application AND return the in-network env-var block to
   * inject into that app. Used by ApplicationsService.attachDatabase to wire a
   * managed DB into a site/app: it sets the soft applicationId link (so the DB
   * survives the app being deleted) and hands back DB_HOST/DB_PORT/… built from
   * the DB's container_name + internal port (container-to-container reachable).
   * Access is gated by assertDbAccess(ADMIN) inside setParent.
   */
  async linkToApplication(
    userId: string,
    dbId: string,
    applicationId: string,
  ): Promise<{ envVars: Record<string, string>; dbName: string }> {
    const db = await this.prisma.database.findUnique({ where: { id: dbId } });
    if (!db) throw new NotFoundException('Database not found');
    if (db.autoImported) {
      // Bundled DBs already live in their parent app's stack with their creds
      // wired in — re-injecting into a DIFFERENT app is almost never intended.
      throw new BadRequestException(
        'This database is bundled inside another application and cannot be attached separately.',
      );
    }

    // Cross-host guard: DB_HOST is the DB container_name, which only resolves
    // over a docker network on the SAME host. If the DB and the app run on
    // different servers, the injected hostname never resolves and the PHP
    // connection fails at runtime with a cryptic DNS error. Refuse early with a
    // clear message instead of "succeeding" into a broken state.
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: {
        projectId: true,
        server: { select: { host: true } },
        project: { select: { server: { select: { host: true } } } },
      },
    });
    if (!app) throw new NotFoundException('Application not found');
    const appHost = app.server?.host ?? app.project?.server?.host ?? null;
    const dbServer = await this.resolveDbServer(dbId);
    const dbHost = dbServer?.host ?? null;
    const sameHost =
      (isLocalHost(appHost) && isLocalHost(dbHost)) ||
      (!!appHost && !!dbHost && appHost === dbHost);
    if (!sameHost) {
      throw new BadRequestException(
        `The database runs on a different server than this application. Container-network attach only works when both are on the same host. ` +
        `Move one of them, or connect using the database's published host:port + DATABASE_URL manually.`,
      );
    }

    // assertDbAccess in setParent verifies the caller can manage this DB AND
    // (via the project check) the target application's project.
    await this.setParent(userId, dbId, { applicationId });

    // Repair path: a DB created before the project-network code, or one whose
    // container was started outside launchContainer, may not be on the app's
    // project network — so its container_name wouldn't resolve from the app.
    // Idempotently connect it now (local host only; remote DBs are guarded
    // above to be same-host, but cross-daemon `network connect` isn't possible
    // from here so we only repair local).
    if (this.isDbLocal(dbServer)) {
      await this.ensureDbOnProjectNetwork(resolveDbContainer({
        name: db.name, autoImported: db.autoImported, host: db.host,
      }), projectNetworkName(app.projectId!));
    }

    return {
      envVars: this.buildDbEnvVars({
        name: db.name,
        type: db.type,
        username: db.username,
        password: db.password,
        autoImported: db.autoImported,
        host: db.host,
      }),
      dbName: db.name,
    };
  }

  /**
   * Idempotently connect a DB container to a project network — repairs DBs that
   * predate the create-time network join. Creates the network first if missing.
   * Best-effort: a failure here doesn't block the attach (the env is still
   * injected; the user can redeploy/repair), but it's logged.
   */
  private async ensureDbOnProjectNetwork(container: string, net: string): Promise<void> {
    await this.ensureProjectNetwork(net);
    try {
      // Already connected? `network connect` errors if so — check first to keep
      // logs clean. The container may not exist yet (still pulling) — tolerate.
      const { stdout } = await execFileAsync(
        'docker',
        ['inspect', '--format', '{{json .NetworkSettings.Networks}}', container],
        { timeout: 5_000 },
      );
      if (stdout.includes(`"${net}"`)) return; // already a member
      await execFileAsync('docker', ['network', 'connect', net, container], { timeout: 10_000 });
    } catch (e) {
      this.logger.warn(`Could not connect ${container} to ${net}: ${(e as Error).message}`);
    }
  }

  /** Unlink a DB from its application (soft link only — container untouched). */
  async unlinkFromApplication(userId: string, dbId: string): Promise<{ dbName: string }> {
    const db = await this.assertDbAccess(userId, dbId, 'ADMIN');
    await this.prisma.database.update({
      where: { id: dbId },
      data: { applicationId: null },
    });
    return { dbName: db.name };
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

  private async launchContainer(
    name: string,
    type: string,
    user: string,
    pass: string,
    port: number,
    projectId?: string | null,
  ) {
    const config = DB_CONFIGS[type];
    if (!config) return;

    const dbDir = path.join(DBS_DIR, name);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    // Join the DB container to its PROJECT network so apps/sites in the SAME
    // project can reach it by container_name (dockcontrol-db-<name>) — without
    // exposing it to every container on the global bridge. Without this the DB
    // sits on its own per-stack default bridge and a sibling PHP/site container
    // cannot resolve its hostname (only the published host port worked, and
    // that's not reachable as a hostname from inside another container).
    let composeYaml = config.compose(name, user, pass, port);
    if (projectId) {
      const net = projectNetworkName(projectId);
      await this.ensureProjectNetwork(net);
      composeYaml = attachProjectNetwork(composeYaml, net);
    }
    fs.writeFileSync(path.join(dbDir, 'docker-compose.yml'), composeYaml);

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

  /** Idempotently create a project network (external bridge) if it's missing. */
  private async ensureProjectNetwork(net: string): Promise<void> {
    try {
      await execFileAsync('docker', ['network', 'inspect', net], { timeout: 5_000 });
    } catch {
      try {
        await execFileAsync('docker', ['network', 'create', net], { timeout: 10_000 });
      } catch {}
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

  /**
   * Connection coordinates a SIBLING container in the same project uses to
   * reach this DB over the docker network — host = the DB's container_name
   * (resolved by resolveDbContainer: dockcontrol-db-<name> for standalone, the
   * stored `host` for auto-imported), port = the engine's INTERNAL default
   * port (5432/3306/6379/…), NOT the published host port. This is what gets
   * injected into a PHP site's env vars on attach. Returns the decrypted
   * password — callers must treat the result as a secret.
   */
  inNetworkConnectionInfo(db: {
    name: string;
    type: string;
    username: string;
    password: string;
    autoImported?: boolean;
    host?: string;
  }): {
    host: string;
    port: number;
    name: string;
    username: string;
    password: string;
    url: string;
  } {
    const container = resolveDbContainer({
      name: db.name,
      autoImported: !!db.autoImported,
      host: db.host || '',
    });
    const internalPort = DB_CONFIGS[db.type]?.defaultPort ?? 0;
    const password = this.dbPassword(db);
    return {
      host: container,
      port: internalPort,
      name: db.name,
      username: db.username,
      password,
      url: this.getConnectionString(db.type, db.username, password, internalPort, db.name, container),
    };
  }

  /**
   * The env-var block injected into an app/site when a DB is attached. A fixed,
   * namespaced key set so detach can remove exactly these without clobbering
   * user-set env. Values use the in-network host/port (container-to-container).
   */
  buildDbEnvVars(db: {
    name: string;
    type: string;
    username: string;
    password: string;
    autoImported?: boolean;
    host?: string;
  }): Record<string, string> {
    const c = this.inNetworkConnectionInfo(db);
    return {
      DB_CONNECTION: this.dbConnectionKind(db.type),
      DB_HOST: c.host,
      DB_PORT: String(c.port),
      DB_DATABASE: c.name,
      DB_NAME: c.name,
      DB_USERNAME: c.username,
      DB_USER: c.username,
      DB_PASSWORD: c.password,
      DATABASE_URL: c.url,
    };
  }

  /**
   * Build the DB_* env block from a database id, reading the RAW (encrypted)
   * row so the password is decrypted exactly once. Use this instead of passing
   * a findOne() result (whose password is already decrypted) into
   * buildDbEnvVars — that would double-decrypt and corrupt the value.
   */
  async buildDbEnvVarsById(dbId: string): Promise<Record<string, string>> {
    const db = await this.prisma.database.findUnique({ where: { id: dbId } });
    if (!db) throw new NotFoundException('Database not found');
    return this.buildDbEnvVars({
      name: db.name, type: db.type, username: db.username,
      password: db.password, autoImported: (db as any).autoImported, host: db.host,
    });
  }

  /** Laravel-style DB_CONNECTION value for the engine. */
  private dbConnectionKind(type: string): string {
    switch (type) {
      case 'POSTGRESQL': return 'pgsql';
      case 'MYSQL': return 'mysql';
      case 'MARIADB': return 'mariadb';
      case 'MONGODB': return 'mongodb';
      case 'REDIS':
      case 'KEYDB':
      case 'DRAGONFLY': return 'redis';
      case 'CLICKHOUSE': return 'clickhouse';
      default: return type.toLowerCase();
    }
  }

  /** The canonical set of env-var keys attach injects (used by detach to strip). */
  static readonly DB_ENV_KEYS = [
    'DB_CONNECTION', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_NAME',
    'DB_USERNAME', 'DB_USER', 'DB_PASSWORD', 'DATABASE_URL',
  ] as const;
}
