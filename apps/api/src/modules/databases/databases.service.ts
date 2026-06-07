import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDatabaseDto } from './dto/create-database.dto';
import { DbType } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import {
  assertProjectAccess,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import { AgentService } from '../agent/agent.service';

const execAsync = promisify(exec);
const DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const DBS_DIR = path.join(DATA_DIR, 'databases');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLocalServer(host: string | null | undefined): boolean {
  if (!host) return true;
  return LOCAL_HOSTS.has(host);
}

const DB_CONFIGS: Record<string, { image: string; defaultPort: number; hostPort: (name: string) => number; compose: (name: string, user: string, pass: string, port: number) => string }> = {
  POSTGRESQL: {
    image: 'postgres:16-alpine',
    defaultPort: 5432,
    hostPort: () => 5440 + Math.floor(Math.random() * 50),
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: postgres:16-alpine
    container_name: kryptalis-db-${name}
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
    hostPort: () => 3310 + Math.floor(Math.random() * 50),
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: mysql:8
    container_name: kryptalis-db-${name}
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
    hostPort: () => 3360 + Math.floor(Math.random() * 50),
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: mariadb:11
    container_name: kryptalis-db-${name}
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
    hostPort: () => 6390 + Math.floor(Math.random() * 50),
    compose: (name, _user, pass, port) => `services:
  ${name}:
    image: redis:7-alpine
    container_name: kryptalis-db-${name}
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
    hostPort: () => 27020 + Math.floor(Math.random() * 50),
    compose: (name, user, pass, port) => `services:
  ${name}:
    image: mongo:7
    container_name: kryptalis-db-${name}
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
};

@Injectable()
export class DatabasesService {
  constructor(
    private prisma: PrismaService,
    private agent: AgentService,
  ) {
    if (!fs.existsSync(DBS_DIR)) fs.mkdirSync(DBS_DIR, { recursive: true });
  }

  /**
   * Resolve the server a database runs on. Databases attach to a project (or
   * to an app that belongs to a project), so we walk up to project.server.
   */
  private async resolveDbServer(dbId: string) {
    const db = await this.prisma.database.findUnique({
      where: { id: dbId },
      select: {
        project: { select: { server: { select: { id: true, host: true } } } },
        application: { select: { project: { select: { server: { select: { id: true, host: true } } } } } },
      },
    });
    return db?.project?.server ?? db?.application?.project?.server ?? null;
  }

  private isDbLocal(server: { host: string } | null): boolean {
    if (!server) return true;
    return isLocalServer(server.host);
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

    // Pin the database to the project's server. Letting the client choose
    // dto.serverId freely was a cross-tenant resource-placement vector: a
    // DEVELOPER on project A could pin a database container onto another
    // tenant's host. The DB always belongs to its project; the project
    // belongs to one server.
    const parentProject = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { serverId: true },
    });
    if (!parentProject) throw new NotFoundException('Project not found');
    if (dto.serverId && dto.serverId !== parentProject.serverId) {
      throw new BadRequestException(
        "serverId must match the project's server. Move the project first if you need to relocate.",
      );
    }
    const effectiveServerId = parentProject.serverId;

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

    const username = dto.username || dto.name;
    const password = dto.password || `kryptalis_${Math.random().toString(36).slice(2, 10)}`;
    const hostPort = config.hostPort(dto.name);

    const db = await this.prisma.database.create({
      data: {
        name: dto.name,
        type: dto.type as DbType,
        serverId: effectiveServerId,
        projectId,
        applicationId,
        port: hostPort,
        username,
        password,
      },
    });

    // Resolve the target server (projectId is guaranteed by the validation above).
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { server: { select: { id: true, host: true } } },
    });
    const server = project?.server ?? null;
    if (this.isDbLocal(server)) {
      this.launchContainer(dto.name, dto.type, username, password, hostPort);
    } else if (server) {
      const compose = config.compose(dto.name, username, password, hostPort);
      await this.agent.enqueueTask(server.id, 'DEPLOY', {
        slug: `db-${dto.name}`,
        appName: `db-${dto.name}`,
        compose,
      });
    }

    return { ...db, status: 'deploying', connectionString: this.getConnectionString(dto.type, username, password, hostPort, dto.name) };
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
      },
    });

    return Promise.all(dbs.map(async (db) => {
      const status = await this.getContainerStatus(db.name);
      const connectionString = this.getConnectionString(db.type, db.username, db.password, db.port, db.name);
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
      },
    });
    if (!db) throw new NotFoundException('Database not found');
    const status = await this.getContainerStatus(db.name);
    const connectionString = this.getConnectionString(db.type, db.username, db.password, db.port, db.name);
    return { ...db, status, connectionString };
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async start(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'DEVELOPER');
    const slug = `db-${db.name}`;
    const server = await this.resolveDbServer(id);
    if (this.isDbLocal(server)) {
      const dbDir = path.join(DBS_DIR, db.name);
      if (fs.existsSync(dbDir)) {
        await execAsync('docker compose up -d', { cwd: dbDir, timeout: 30000 });
      }
    } else if (server) {
      await this.agent.enqueueTask(server.id, 'START', { slug });
    }
    return { message: 'Database started' };
  }

  async stop(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'DEVELOPER');
    const slug = `db-${db.name}`;
    const server = await this.resolveDbServer(id);
    if (this.isDbLocal(server)) {
      const dbDir = path.join(DBS_DIR, db.name);
      if (fs.existsSync(dbDir)) {
        await execAsync('docker compose stop', { cwd: dbDir, timeout: 30000 });
      }
    } else if (server) {
      await this.agent.enqueueTask(server.id, 'STOP', { slug });
    }
    return { message: 'Database stopped' };
  }

  async remove(userId: string, id: string) {
    const db = await this.assertDbAccess(userId, id, 'ADMIN');
    const containerName = `kryptalis-db-${db.name}`;
    const slug = `db-${db.name}`;
    const server = await this.resolveDbServer(id);

    if (this.isDbLocal(server)) {
      const dbDir = path.join(DBS_DIR, db.name);
      if (fs.existsSync(dbDir)) {
        try { await execAsync('docker compose down -v --remove-orphans', { cwd: dbDir, timeout: 30000 }); } catch {}
        fs.rmSync(dbDir, { recursive: true, force: true });
      }
      try { await execAsync(`docker rm -f ${containerName}`, { timeout: 10000 }); } catch {}
    } else if (server) {
      await this.agent.enqueueTask(server.id, 'REMOVE', {
        slug,
        containerName,
        purgeVolumes: true,
      });
    }

    await this.prisma.database.delete({ where: { id } });
    return { message: 'Database deleted' };
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

  private async launchContainer(name: string, type: string, user: string, pass: string, port: number) {
    const config = DB_CONFIGS[type];
    if (!config) return;

    const dbDir = path.join(DBS_DIR, name);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'docker-compose.yml'), config.compose(name, user, pass, port));

    try {
      await execAsync('docker compose pull', { cwd: dbDir, timeout: 120000 });
      await execAsync('docker compose up -d', { cwd: dbDir, timeout: 60000 });
    } catch {}
  }

  private async getContainerStatus(name: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`docker inspect --format="{{.State.Status}}" kryptalis-db-${name}`, { timeout: 5000 });
      return stdout.trim() || 'unknown';
    } catch {
      return 'not running';
    }
  }

  private getConnectionString(type: string, user: string, pass: string, port: number, name: string): string {
    switch (type) {
      case 'POSTGRESQL': return `postgresql://${user}:${pass}@localhost:${port}/${name}`;
      case 'MYSQL':
      case 'MARIADB': return `mysql://${user}:${pass}@localhost:${port}/${name}`;
      case 'REDIS': return `redis://${pass ? `:${pass}@` : ''}localhost:${port}`;
      case 'MONGODB': return `mongodb://${user}:${pass}@localhost:${port}/${name}`;
      default: return `localhost:${port}`;
    }
  }
}
