import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { AdminService } from '../admin/admin.service';
import {
  assertProjectAccess,
  getProjectRole,
  listAccessibleProjectIds,
} from '../../common/rbac/project-access';
import type { ProjectRole } from '@prisma/client';
import { AgentService, AgentTaskCompletion } from '../agent/agent.service';
import { appVolumePrefix, dbVolumePrefix, deterministicVolumeNames } from '../agent/volume-naming.util';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { MailServerService } from '../email/mail-server.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);
const PROJ_DATA_DIR = process.env.KRYPTALIS_DATA_DIR || path.join(process.cwd(), '.kryptalis');
const PROJ_APPS_DIR = path.join(PROJ_DATA_DIR, 'apps');
const PROJ_DBS_DIR = path.join(PROJ_DATA_DIR, 'databases');

/** Stream a command's stdout to a file (no shell, never buffered in memory). */
function runCommandToFile(cmd: string, args: string[], outPath: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 8192) stderr += d.toString();
    });
    child.stdout.pipe(out);
    child.once('error', (err) => {
      clearTimeout(timer);
      out.destroy();
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      out.close(() => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
      });
    });
  });
}

/** Pipe a file into a command's stdin (no shell, streaming). */
function runCommandWithInputFile(cmd: string, args: string[], inPath: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 8192) stderr += d.toString();
    });
    const src = fs.createReadStream(inPath);
    src.once('error', (err) => {
      child.kill('SIGKILL');
      clearTimeout(timer);
      reject(err);
    });
    src.pipe(child.stdin);
    child.stdin.once('error', () => undefined);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

@Injectable()
export class ProjectsService implements OnModuleInit {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private prisma: PrismaService,
    private admin: AdminService,
    private agent: AgentService,
    private proxy: ReverseProxyService,
    private mailServer: MailServerService,
    private notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // Remote→LOCAL migration leg: a VOLUME_EXPORT whose payload carries
    // `migrateLocalImport` means the target server is the local host (no
    // agent task can import there) — the API imports the uploaded tars
    // into local docker volumes itself, then enqueues the deferred DEPLOYs.
    // Runs before the agent service's generic transfer cleanup (handlers
    // are invoked first), so the uploaded files are still on disk.
    this.agent.registerTaskCompletionHandler('VOLUME_EXPORT', (task) =>
      this.onVolumeExportForLocalImport(task),
    );
  }

  async create(userId: string, dto: CreateProjectDto) {
    const mode = await this.admin.getDeploymentMode();
    let serverId = dto.serverId;
    if (mode === 'LOCAL') {
      // In LOCAL mode there is only one server — the local one. Use it
      // regardless of what the client sent (silently override).
      const local = await this.prisma.server.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      if (!local) {
        throw new BadRequestException('No local server provisioned yet');
      }
      serverId = local.id;
    } else {
      // MULTI mode: a serverId is required and must point at an ONLINE server.
      if (!serverId) {
        throw new BadRequestException('serverId is required in MULTI mode — pick a server in the wizard');
      }
      const server = await this.prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw new NotFoundException('Server not found');
      if (server.status !== 'ONLINE') {
        throw new BadRequestException(`Server "${server.name}" is ${server.status} — choose an ONLINE server`);
      }
    }
    const project = await this.prisma.project.create({
      data: {
        ...dto,
        serverId,
        userId,
        members: {
          create: { userId, role: 'OWNER' },
        },
      },
      include: { server: { select: { id: true, name: true, host: true } } },
    });
    return project;
  }

  async findAll(userId: string) {
    const ids = await listAccessibleProjectIds(this.prisma, userId);
    if (ids.length === 0) return [];
    return this.prisma.project.findMany({
      where: { id: { in: ids } },
      include: {
        server: { select: { id: true, name: true, host: true } },
        applications: {
          select: {
            id: true,
            name: true,
            status: true,
            framework: true,
            port: true,
          },
        },
        members: { where: { userId }, select: { role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const role = await assertProjectAccess(this.prisma, userId, id, 'VIEWER');
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        server: { select: { id: true, name: true, host: true } },
        applications: {
          include: {
            domains: { select: { id: true, domain: true, sslStatus: true } },
          },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return { ...project, currentRole: role };
  }

  async update(id: string, userId: string, dto: UpdateProjectDto) {
    await assertProjectAccess(this.prisma, userId, id, 'ADMIN');
    return this.prisma.project.update({
      where: { id },
      data: dto,
      include: { server: { select: { id: true, name: true, host: true } } },
    });
  }

  /**
   * Set the per-project file-storage quota. Restricted to platform
   * ADMIN/SUPERADMIN at the controller — project members (even OWNER)
   * cannot grant themselves more disk. quotaBytes must be a non-negative
   * integer; null is rejected here (use a positive value, or leave the
   * default by not calling this endpoint).
   */
  async setQuota(id: string, quotaBytes: number | string | bigint) {
    let q: bigint;
    try {
      q = typeof quotaBytes === 'bigint' ? quotaBytes : BigInt(quotaBytes as any);
    } catch {
      throw new BadRequestException('quotaBytes must be an integer (bytes)');
    }
    if (q < 0n) {
      throw new BadRequestException('quotaBytes must be >= 0');
    }
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    return this.prisma.project.update({
      where: { id },
      data: { storageQuotaBytes: q } as any,
      select: { id: true, name: true, storageQuotaBytes: true } as any,
    });
  }

  async remove(id: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, id, 'OWNER');

    // Tear down infra BEFORE the DB cascade wipes the rows. Without this,
    // containers + volumes + mail server + Caddy entries all stay alive on
    // the host while the user thinks the project is gone.
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        server: { select: { id: true, host: true } },
        applications: { select: { id: true, name: true } },
        databases: { select: { id: true, name: true } },
        domains: { select: { id: true, domain: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    // Match applications.service slugify (NFKD + diacritic strip) so on-disk
    // dir lookups hit the same path the install step wrote.
    const slugify = (n: string) =>
      n
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'app';

    const isLocal = isLocalHost(project.server?.host);

    // ── Applications ────────────────────────────────────────────────
    // LOCAL: drive docker compose + fs cleanup directly (the agent loop
    // wouldn't run before the cascade nukes the rows). MULTI: enqueue REMOVE
    // on the remote agent. purgeVolumes=true — user explicitly deleted the
    // project, no recovery path expected.
    for (const app of project.applications) {
      const slug = slugify(app.name);
      if (isLocal) {
        // Marketplace multi-install apps live in <slug>-<id12>; legacy installs
        // in <slug>. Try the per-instance dir first, then fall back.
        const id12 = app.id.slice(0, 12);
        const perInstanceDir = path.join(PROJ_APPS_DIR, `${slug}-${id12}`);
        const legacyDir = path.join(PROJ_APPS_DIR, slug);
        for (const dir of [perInstanceDir, legacyDir]) {
          if (fs.existsSync(dir)) {
            // --rmi local purges locally-BUILT images (the per-app
            // `<slug>-<id>-web:latest` ones) so they don't accumulate.
            // Pulled images like postgres:16 are shared → not touched.
            try { await execFileAsync('docker', ['compose', 'down', '-v', '--rmi', 'local', '--remove-orphans'], { cwd: dir, timeout: 90_000 }); } catch {}
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          }
        }
        // belt + suspenders: kill orphan containers under both naming schemes
        try { await execFileAsync('docker', ['rm', '-f', `kryptalis-${slug}`], { timeout: 10_000 }); } catch {}
        try { await execFileAsync('docker', ['rm', '-f', `kryptalis-${slug}-${id12}`], { timeout: 10_000 }); } catch {}
      } else {
        try {
          await this.agent.enqueueTask(project.serverId, 'REMOVE', {
            slug,
            containerName: `kryptalis-${slug}`,
            purgeVolumes: true,
          });
        } catch {}
      }
    }

    // ── Databases ───────────────────────────────────────────────────
    // databases.service stores compose dir as DBS_DIR/<db.name> (no slug) and
    // names containers kryptalis-db-<db.name>. Match those exactly or LOCAL
    // cleanup misses the bind-mount + leaks the postgres/redis container.
    for (const db of project.databases) {
      const containerName = `kryptalis-db-${db.name}`;
      const slug = `db-${db.name}`;
      if (isLocal) {
        const dbDir = path.join(PROJ_DBS_DIR, db.name);
        if (fs.existsSync(dbDir)) {
          try { await execFileAsync('docker', ['compose', 'down', '-v', '--remove-orphans'], { cwd: dbDir, timeout: 30_000 }); } catch {}
          try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
        }
        try { await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 10_000 }); } catch {}
      } else {
        try {
          await this.agent.enqueueTask(project.serverId, 'REMOVE', {
            slug,
            containerName,
            purgeVolumes: true,
          });
        } catch {}
      }
    }

    // ── Mail servers ────────────────────────────────────────────────
    // Per-domain mail server stack. removeForDomain() already does compose
    // down -v + fs.rmSync + force-rm by container name — works LOCAL or MULTI
    // because mail compose dirs are managed locally regardless of project
    // server (mail rides the host's Caddy). Cascade would otherwise orphan
    // the DKIM keys + Postfix/Dovecot data dir + the MailServer row.
    for (const d of project.domains) {
      try { await this.mailServer.removeForDomain(d.id); } catch {}
    }

    // Drop the project's dedicated docker network now that every app/db
    // in it is gone. Otherwise `docker network ls` keeps showing
    // kryptalis_proj_<id> forever and we leak networks on every
    // project delete.
    if (isLocal) {
      const networkName = `kryptalis_proj_${id.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
      try { await execFileAsync('docker', ['network', 'rm', networkName], { timeout: 10_000 }); } catch {}
    }

    await this.prisma.project.delete({ where: { id } });
    // Regenerate Caddy so domains aren't kept routing to dead containers.
    this.proxy.regenerate().catch(() => {});
    return { message: 'Project deleted' };
  }

  /**
   * Move every app + DB in this project from its current server to `targetServerId`.
   *
   * Flow per app: enqueue REMOVE on the *old* server (best-effort — failures
   * are logged not blocking, because the old server may be unreachable, which
   * is often why the user is migrating in the first place), then flip the
   * project.serverId, transfer the docker volumes and enqueue DEPLOY on the
   * new server. Caddy regenerates so domain routing follows.
   *
   * Volume transfer (three source/target combinations — local→local doesn't
   * exist in MULTI mode):
   *   - remote → remote: enqueue VOLUME_EXPORT on the source with an
   *     onComplete chain [VOLUME_IMPORT on the target, ...DEPLOY tasks].
   *     The agent service's generic chaining sequences them and threads
   *     sourceTaskId so the import downloads the export's uploaded tars.
   *   - local → remote: the API exports each volume directly (`docker run
   *     busybox tar`) into transfers/<local-id>/, then enqueues
   *     VOLUME_IMPORT on the target ({sourceTaskId: <local-id>}) with the
   *     DEPLOYs chained behind it.
   *   - remote → local: enqueue VOLUME_EXPORT on the source with a
   *     `migrateLocalImport` marker; the VOLUME_EXPORT completion handler
   *     (onVolumeExportForLocalImport) untars the uploaded volumes into
   *     local docker volumes and then enqueues the deferred DEPLOYs.
   * Volume resolution is the deterministic compose-prefix convention (real
   * `docker volume ls` prefix filtering when the source is local — full
   * coverage; deterministic `<composeProject>_data` names when remote, which
   * does NOT cover stacks with differently-named volumes). If the transfer
   * can't be set up (enqueue/export failure), we fall back to the previous
   * behavior — deploy immediately with empty volumes — and surface a warning.
   */
  async migrate(projectId: string, userId: string, targetServerId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'ADMIN');

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        server: { select: { id: true, host: true, name: true } },
        applications: { select: { id: true, name: true, status: true } },
        databases: { select: { id: true, name: true, autoImported: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (project.serverId === targetServerId) {
      throw new BadRequestException('Project is already on this server');
    }

    const target = await this.prisma.server.findUnique({ where: { id: targetServerId } });
    if (!target) throw new NotFoundException('Target server not found');
    if (target.status !== 'ONLINE') {
      throw new BadRequestException(`Target server "${target.name}" is ${target.status} — must be ONLINE`);
    }

    const oldServerId = project.serverId;
    const sourceLocal = isLocalHost(project.server?.host);
    const targetLocal = isLocalHost(target.host);
    const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';

    // Best-effort tear down on old server. CRITICAL: purgeVolumes is FALSE
    // here so the source server stops the containers but KEEPS the named
    // volumes intact — the export below reads them, and the user can still
    // recover the source state by flipping back.
    const teardownErrors: string[] = [];
    for (const app of project.applications) {
      try {
        await this.agent.enqueueTask(oldServerId, 'REMOVE', {
          slug: slugify(app.name),
          containerName: `kryptalis-${slugify(app.name)}`,
          purgeVolumes: false,
        });
      } catch (e: any) {
        teardownErrors.push(`${app.name}: ${e?.message || e}`);
      }
    }
    for (const db of project.databases) {
      try {
        await this.agent.enqueueTask(oldServerId, 'REMOVE', {
          slug: slugify(db.name),
          containerName: `kryptalis-db-${slugify(db.name)}`,
          purgeVolumes: false,
        });
      } catch (e: any) {
        teardownErrors.push(`db ${db.name}: ${e?.message || e}`);
      }
    }

    // Flip the server pointer.
    await this.prisma.project.update({
      where: { id: projectId },
      data: { serverId: targetServerId },
    });

    // DEPLOY descriptors — either enqueued directly (no volume transfer) or
    // chained behind the volume import so containers come up on real data.
    const deploys: Array<{ serverId: string; type: 'DEPLOY'; payload: any; label: string }> = [
      ...project.applications.map((app) => ({
        serverId: targetServerId,
        type: 'DEPLOY' as const,
        payload: { applicationId: app.id, slug: slugify(app.name) },
        label: app.name,
      })),
      ...project.databases.map((db) => ({
        serverId: targetServerId,
        type: 'DEPLOY' as const,
        payload: { databaseId: db.id, slug: slugify(db.name) },
        label: `db:${db.name}`,
      })),
    ];

    // ── volume transfer ───────────────────────────────────────────────
    let volumesInFlight = false;
    let volumes: string[] = [];
    try {
      volumes = sourceLocal
        ? await this.listLocalProjectVolumes(project.applications, project.databases)
        : deterministicVolumeNames(project.applications, project.databases);
    } catch (e: any) {
      teardownErrors.push(`volume discovery: ${e?.message || e}`);
    }

    const queued: string[] = [];
    if (volumes.length > 0) {
      try {
        const chainEntries = deploys.map((d) => ({
          serverId: d.serverId,
          type: d.type,
          payload: d.payload,
        }));
        if (sourceLocal && !targetLocal) {
          // Export locally into transfers/<local-id>/, agent pulls from there.
          const sourceTaskId = await this.exportLocalVolumes(volumes);
          await this.agent.enqueueTask(targetServerId, 'VOLUME_IMPORT', {
            volumes,
            sourceTaskId,
            onComplete: chainEntries,
          });
        } else if (!sourceLocal && !targetLocal) {
          // Full agent chain: export on source → import on target → deploys.
          await this.agent.enqueueTask(oldServerId, 'VOLUME_EXPORT', {
            volumes,
            onComplete: [
              { serverId: targetServerId, type: 'VOLUME_IMPORT', payload: { volumes } },
              ...chainEntries,
            ],
          });
        } else {
          // remote → local: the export's uploads land on this host already;
          // the VOLUME_EXPORT completion handler imports them + enqueues
          // the deferred deploys.
          await this.agent.enqueueTask(oldServerId, 'VOLUME_EXPORT', {
            volumes,
            migrateLocalImport: { volumes, deploys: chainEntries },
          });
        }
        volumesInFlight = true;
        // Deploys ride the chain — report them as queued.
        queued.push(...deploys.map((d) => d.label));
      } catch (e: any) {
        teardownErrors.push(`volume transfer: ${e?.message || e} — falling back to empty volumes`);
        this.logger.warn(
          `Project ${projectId} migrate: volume transfer setup failed (${e?.message || e}) — deploying with empty volumes.`,
        );
      }
    }

    // No transfer in flight (no volumes, or setup failed) → previous
    // behavior: deploy immediately, volumes start empty.
    if (!volumesInFlight) {
      for (const d of deploys) {
        try {
          await this.agent.enqueueTask(d.serverId, d.type, d.payload);
          queued.push(d.label);
        } catch (e: any) {
          teardownErrors.push(`redeploy ${d.label.replace(/^db:/, 'db ')}: ${e?.message || e}`);
        }
      }
    }

    // Caddy regen so domains follow the move.
    this.proxy.regenerate().catch(() => {});

    const hasRedeployErrors = teardownErrors.some((e) => e.startsWith('redeploy '));
    const status = hasRedeployErrors ? 'partial' : 'ok';
    let message: string;
    if (status === 'partial') {
      message = `Project migration started with errors — check warnings. Source volumes are KEPT on the old server for recovery.`;
    } else if (volumesInFlight) {
      message = `Project migrated from ${project.server?.name || oldServerId} → ${target.name}. Docker volumes are being transferred asynchronously — apps and databases will deploy on the target once the data arrives. Source volumes are preserved on the old server for recovery.`;
    } else {
      message = `Project migrated from ${project.server?.name || oldServerId} → ${target.name}. NOTE: no Docker volumes were transferred; databases and uploads will start empty on the target. Source volumes are preserved on the old server for recovery.`;
    }
    return { status, message, queued, warnings: teardownErrors };
  }

  /**
   * Volumes belonging to this project's compose stacks on the LOCAL host —
   * real `docker volume ls` filtered by the deterministic compose-project
   * prefixes (covers every volume of a stack, unlike the name-guessing used
   * for remote hosts).
   */
  private async listLocalProjectVolumes(
    apps: Array<{ id: string; name: string }>,
    databases: Array<{ name: string; autoImported?: boolean }>,
  ): Promise<string[]> {
    if (apps.length === 0 && databases.length === 0) return [];
    const prefixes = [
      ...apps.map((a) => appVolumePrefix(a.name, a.id)),
      ...databases.filter((d) => !d.autoImported).map((d) => dbVolumePrefix(d.name)),
    ];
    if (prefixes.length === 0) return [];
    const { stdout } = await execFileAsync(
      'docker',
      ['volume', 'ls', '--format', '{{.Name}}'],
      { timeout: 15_000 },
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((v) => prefixes.some((p) => v.startsWith(p)));
  }

  /**
   * Export local docker volumes into transfers/<local-id>/<volume>.tar.gz
   * (streaming `docker run busybox tar`, no agent task) and return the
   * transfer id a remote VOLUME_IMPORT can download from.
   */
  private async exportLocalVolumes(volumes: string[]): Promise<string> {
    const transferId = this.agent.newLocalTransferId();
    const dir = this.agent.transferDir(transferId);
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      for (const vol of volumes) {
        await runCommandToFile(
          'docker',
          ['run', '--rm', '-v', `${vol}:/data:ro`, 'busybox', 'tar', '-czf', '-', '-C', '/data', '.'],
          path.join(dir, `${path.basename(vol)}.tar.gz`),
          1_800_000,
        );
      }
    } catch (err) {
      await this.agent.cleanupTransfers(transferId);
      throw err;
    }
    return transferId;
  }

  /**
   * VOLUME_EXPORT completion handler for the remote→local migration leg.
   * The agent uploaded each <volume>.tar.gz under its taskId; untar them
   * into local docker volumes, then enqueue the deferred DEPLOY tasks.
   * FAILED export → deploys are dropped (data-less deploys on a migration
   * the user expects to carry data would be worse) and logged.
   */
  async onVolumeExportForLocalImport(task: AgentTaskCompletion): Promise<void> {
    const marker = task.payload?.migrateLocalImport;
    if (!marker) return; // ordinary VOLUME_EXPORT, not ours
    if (task.status === 'FAILED') {
      this.logger.error(
        `Migration volume export ${task.id} FAILED (${task.error ?? 'unknown error'}) — deferred deploys dropped; re-run the migration.`,
      );
      return;
    }

    const dir = this.agent.transferDir(task.id);
    for (const vol of marker.volumes ?? []) {
      const file = path.join(dir, `${path.basename(String(vol))}.tar.gz`);
      try {
        if (!fs.existsSync(file)) {
          throw new Error('tar missing from the export upload');
        }
        // Idempotent — succeeds when the volume already exists.
        await execFileAsync('docker', ['volume', 'create', String(vol)], { timeout: 15_000 });
        await runCommandWithInputFile(
          'docker',
          ['run', '--rm', '-i', '-v', `${vol}:/data`, 'busybox', 'tar', '-xzf', '-', '-C', '/data'],
          file,
          1_800_000,
        );
      } catch (e: any) {
        this.logger.error(`Migration: importing volume "${vol}" locally failed: ${e?.message || e}`);
      }
    }

    for (const d of marker.deploys ?? []) {
      try {
        await this.agent.enqueueTask(d.serverId, d.type, d.payload);
      } catch (e: any) {
        this.logger.error(`Migration: deferred deploy enqueue failed: ${e?.message || e}`);
      }
    }
  }

  /**
   * Service-mesh view of a project: every app + database, the hostname they
   * can be reached at *from inside* the shared docker network, and ready-made
   * connection-string snippets the user can paste into another app's env vars.
   *
   * Network: kryptalis_proj_<projectId-stripped>. Every container is named
   * by its slug + id-suffix so siblings can resolve each other by DNS.
   */
  async getServiceMesh(projectId: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        applications: {
          select: {
            id: true, name: true, status: true, port: true,
            containerName: true, containerPort: true, framework: true,
          },
        },
        databases: {
          select: { id: true, name: true, type: true, port: true, username: true },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'svc';
    const networkName = `kryptalis_proj_${projectId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;

    const apps = project.applications.map((a) => {
      const slug = slugify(a.name);
      const host = a.containerName || `kryptalis-${slug}`;
      const port = a.containerPort || a.port || 80;
      return {
        id: a.id,
        name: a.name,
        kind: 'app' as const,
        status: a.status,
        framework: a.framework,
        host,
        port,
        url: `http://${host}:${port}`,
      };
    });

    const dbs = project.databases.map((d) => {
      const slug = slugify(d.name);
      const host = `kryptalis-db-${slug}`;
      const port = d.port;
      const protocol =
        d.type === 'POSTGRESQL' ? 'postgres' :
        d.type === 'MYSQL' ? 'mysql' :
        d.type === 'MARIADB' ? 'mysql' :
        d.type === 'MONGODB' ? 'mongodb' :
        d.type === 'REDIS' ? 'redis' : 'tcp';
      return {
        id: d.id,
        name: d.name,
        kind: 'database' as const,
        dbType: d.type,
        host,
        port,
        username: d.username,
        url: `${protocol}://${d.username}:<PASSWORD>@${host}:${port}/${slug}`,
      };
    });

    // Env-var suggestions: "if you link database X to app Y, paste this".
    const envSuggestions: { from: { id: string; name: string }; to: { id: string; name: string }; envVar: string; value: string }[] = [];
    for (const db of dbs) {
      const envName =
        db.dbType === 'POSTGRESQL' ? 'DATABASE_URL' :
        db.dbType === 'MYSQL' || db.dbType === 'MARIADB' ? 'DATABASE_URL' :
        db.dbType === 'MONGODB' ? 'MONGO_URL' :
        db.dbType === 'REDIS' ? 'REDIS_URL' : 'DB_URL';
      for (const app of apps) {
        envSuggestions.push({
          from: { id: db.id, name: db.name },
          to: { id: app.id, name: app.name },
          envVar: envName,
          value: db.url,
        });
      }
    }

    return {
      projectId,
      networkName,
      apps,
      databases: dbs,
      envSuggestions,
      hint: 'Containers in this project share a docker network and can reach each other by these hostnames. Use them in env vars instead of IPs.',
    };
  }

  // ── Members ───────────────────────────────────────────────────────

  async listMembers(projectId: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(
    projectId: string,
    actorId: string,
    payload: { email?: string; userId?: string; role: ProjectRole },
  ) {
    const actorRole = await assertProjectAccess(
      this.prisma,
      actorId,
      projectId,
      'ADMIN',
    );
    if (payload.role === 'OWNER' && actorRole !== 'OWNER') {
      throw new BadRequestException('Only the OWNER can grant OWNER role');
    }
    let targetUserId = payload.userId;
    if (!targetUserId && payload.email) {
      const user = await this.prisma.user.findUnique({
        where: { email: payload.email },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('User not found');
      targetUserId = user.id;
    }
    if (!targetUserId) throw new BadRequestException('email or userId required');

    const result = await this.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: targetUserId } },
      create: {
        projectId,
        userId: targetUserId,
        role: payload.role,
        invitedById: actorId,
      },
      update: { role: payload.role },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    // Notify the user they've been added (fire-and-forget — a failed
    // email shouldn't break the add). Only on first add, not on
    // role updates, to avoid spamming.
    try {
      const wasUpdate = result.createdAt.getTime() < Date.now() - 5000;
      if (!wasUpdate) {
        const [project, actor] = await Promise.all([
          this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
          this.prisma.user.findUnique({ where: { id: actorId }, select: { name: true } }),
        ]);
        if (project && actor && result.user.email) {
          await this.notifications.sendUserInvited(
            result.user.email,
            project.name,
            actor.name,
            '',
          );
        }
      }
    } catch {}

    return result;
  }

  async updateMember(
    projectId: string,
    actorId: string,
    memberId: string,
    role: ProjectRole,
  ) {
    const actorRole = await assertProjectAccess(
      this.prisma,
      actorId,
      projectId,
      'ADMIN',
    );
    const member = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === role) return member; // no-op
    if (member.role === 'OWNER' && actorRole !== 'OWNER') {
      throw new BadRequestException('Only the OWNER can modify the OWNER');
    }
    if (role === 'OWNER' && actorRole !== 'OWNER') {
      throw new BadRequestException('Only the OWNER can grant OWNER role');
    }
    // never allow demoting the last OWNER — a project always needs at least one
    if (member.role === 'OWNER' && role !== 'OWNER') {
      const owners = await this.prisma.projectMember.count({
        where: { projectId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new BadRequestException(
          'Cannot demote the last OWNER. Promote another member to OWNER first.',
        );
      }
    }
    return this.prisma.projectMember.update({
      where: { id: memberId },
      data: { role },
    });
  }

  async removeMember(projectId: string, actorId: string, memberId: string) {
    const actorRole = await assertProjectAccess(
      this.prisma,
      actorId,
      projectId,
      'ADMIN',
    );
    const member = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === 'OWNER') {
      // can't remove the last OWNER
      const owners = await this.prisma.projectMember.count({
        where: { projectId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new BadRequestException(
          'Cannot remove the last OWNER. Transfer ownership first.',
        );
      }
      if (actorRole !== 'OWNER') {
        throw new BadRequestException('Only OWNERs can remove an OWNER');
      }
    }
    if (member.userId === actorId && actorRole === 'OWNER') {
      const owners = await this.prisma.projectMember.count({
        where: { projectId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new BadRequestException(
          'You are the last OWNER. Transfer ownership first.',
        );
      }
    }
    await this.prisma.projectMember.delete({ where: { id: memberId } });
    return { message: 'Member removed' };
  }

  async getMyRole(projectId: string, userId: string) {
    const role = await getProjectRole(this.prisma, userId, projectId);
    return { role };
  }

  /**
   * Transfer project ownership: actor (current OWNER) hands off OWNER to another
   * existing member, and downgrades themself to ADMIN.
   * Works only if actor is OWNER. Target must already be a member (any role).
   */
  async transferOwnership(projectId: string, actorId: string, targetUserId: string) {
    if (actorId === targetUserId) {
      throw new BadRequestException('You already are the OWNER');
    }
    const actorRole = await getProjectRole(this.prisma, actorId, projectId);
    if (actorRole !== 'OWNER') {
      throw new ForbiddenException('Only the OWNER can transfer ownership');
    }
    const target = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: targetUserId },
    });
    if (!target) {
      throw new BadRequestException('Target user must already be a project member');
    }
    // Run as a transaction so we never end up with zero OWNERs.
    await this.prisma.$transaction([
      this.prisma.projectMember.update({
        where: { id: target.id },
        data: { role: 'OWNER' },
      }),
      this.prisma.projectMember.updateMany({
        where: { projectId, userId: actorId, role: 'OWNER' },
        data: { role: 'ADMIN' },
      }),
      // sync the legacy Project.userId field to point at the new OWNER for backward compat
      this.prisma.project.update({
        where: { id: projectId },
        data: { userId: targetUserId },
      }),
    ]);
    return { message: 'Ownership transferred' };
  }
}
