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
import { AgentService, AgentTaskCompletion, AgentTaskType } from '../agent/agent.service';
import { appVolumePrefix, dbVolumePrefix } from '../agent/volume-naming.util';
import { slugify, remoteAppSlug, RESERVED_HOST_PORTS } from '../applications/applications.helpers';
import { ApplicationOpsService } from '../applications/application-ops.service';
import { ApplicationsService } from '../applications/applications.service';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { MailServerService } from '../email/mail-server.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);
const PROJ_DATA_DIR = process.env.DOCKCONTROL_DATA_DIR || path.join(process.cwd(), '.dockcontrol');
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
    private ops: ApplicationOpsService,
    private encryption: EncryptionService,
    private applications: ApplicationsService,
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
        // Per-app teardown is delegated to applications.remove() (which
        // resolves each app's own server), so we only need id + name here.
        applications: { select: { id: true, name: true } },
        databases: { select: { id: true, name: true, autoImported: true } },
        domains: { select: { id: true, domain: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const isLocal = isLocalHost(project.server?.host);

    // ── Applications ────────────────────────────────────────────────
    // Delegate to ApplicationsService.remove() — the single source of truth
    // for tearing an app down. It resolves the on-disk dir correctly
    // (resolveAppDir, which knows the real per-instance vs legacy path even
    // after a rename), runs `compose down -v --rmi local` so the WHOLE stack
    // goes (incl. a bundled DB sidecar like PrestaShop's MariaDB), has the
    // belt-and-suspenders `docker rm` under both naming schemes, drops the
    // project network, AND purges the auto-imported DB rows. The previous
    // inline copy here had drifted (it slugged the current name, missing the
    // real dir → leaked the PrestaShop + sidecar containers). Best-effort per
    // app: one failure must not abort the rest of the project teardown.
    for (const app of project.applications) {
      try {
        await this.applications.remove(userId, app.id);
      } catch (err: any) {
        this.logger.warn(`project remove: app "${app.name}" cleanup failed: ${err?.message || err}`);
      }
    }

    // ── Databases (STANDALONE only) ─────────────────────────────────
    // Bundled (auto-imported) DBs live in their parent app's compose stack and
    // were already torn down + their rows purged by applications.remove above
    // — skip them here (a second `docker rm` would be a confusing no-op).
    // Standalone DBs have their OWN DBS_DIR/<name> compose dir + the
    // dockcontrol-db-<name> container; clean those exactly.
    for (const db of project.databases) {
      if (db.autoImported) continue;
      const containerName = `dockcontrol-db-${db.name}`;
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

    // Delete the project's Domain rows explicitly. The FK is SetNull (a
    // domain row must survive its app being deleted), but on PROJECT
    // deletion a kept row is a trap: it disappears from every list (all
    // scoped by project) while its @unique(domain) still blocks
    // re-creating the same hostname — "it exists already" with nothing
    // visible to delete.
    try {
      await this.prisma.domain.deleteMany({ where: { projectId: id } });
    } catch {}

    // Drop the project's dedicated docker network now that every app/db
    // in it is gone. Otherwise `docker network ls` keeps showing
    // dockcontrol_proj_<id> forever and we leak networks on every
    // project delete.
    if (isLocal) {
      const networkName = `dockcontrol_proj_${id.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
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
   * Data-safe, fail-closed ordering (NOTHING is flipped until the move
   * actually succeeds):
   *   1. STOP/REMOVE (purgeVolumes:false) the source stack and AWAIT it, so
   *      the named volumes are quiesced and consistent for export.
   *   2. Discover the source stack's REAL volume names — `docker volume ls`
   *      prefix-filtering when the source is local, an awaited VOLUME_LIST
   *      agent task (exact-prefix match against the live host) when remote.
   *      No more deterministic name-guessing that silently migrated zero
   *      volumes for stacks with non-`_data` volume keys.
   *   3. Transfer the volumes to the target and AWAIT it (export→import for
   *      remote→remote, local export + awaited import for local→remote, the
   *      onVolumeExportForLocalImport handler for remote→local).
   *   4. Deploy on the target through the REAL deploy path — ops.redeploy()
   *      for every app kind (git/image/compose ship the full stack), a proper
   *      compose-carrying DEPLOY for each DB. Never a bare {applicationId}.
   *   5. ONLY on success: flip project.serverId + every database.serverId,
   *      then regenerate Caddy.
   *
   * On ANY deploy failure we do NOT flip (the project still points at the
   * source), RESTART the source stack so the user is left running where they
   * started, and return status `failed`/`partial` — never `ok`. purgeVolumes
   * is FALSE throughout, so the source data is always recoverable.
   *
   * @param includePinned when true, apps explicitly pinned to other servers
   *   are ALSO relocated (and their serverId cleared); default false keeps
   *   them where the user put them.
   */
  async migrate(
    projectId: string,
    userId: string,
    targetServerId: string,
    includePinned = false,
  ) {
    await assertProjectAccess(this.prisma, userId, projectId, 'OWNER');

    const projectFull = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        server: { select: { id: true, host: true, name: true } },
        applications: { select: { id: true, name: true, status: true, serverId: true, hostPort: true } },
        databases: {
          select: { id: true, name: true, type: true, username: true, password: true, port: true, autoImported: true },
        },
        domains: { select: { id: true } },
      },
    });
    if (!projectFull) throw new NotFoundException('Project not found');

    // Per-app placement: apps EXPLICITLY pinned to another server normally
    // stay where the user put them. includePinned relocates them too (and we
    // clear their serverId on success so they inherit the project default).
    const pinnedApps = projectFull.applications.filter((a) => a.serverId && a.serverId !== projectFull.serverId);
    const migratingApps = includePinned
      ? projectFull.applications
      : projectFull.applications.filter((a) => !a.serverId || a.serverId === projectFull.serverId);
    const project = { ...projectFull, applications: migratingApps };

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

    const warnings: string[] = [];
    // `degraded` = a data-affecting step (volume transfer, teardown, deploy)
    // did not fully succeed → status is at best `partial`, never `ok`.
    let degraded = false;

    // ── 1. STOP the source stack and AWAIT it ─────────────────────────
    // REMOVE with purgeVolumes:false stops + removes the containers but KEEPS
    // the named volumes, so the export below reads a consistent on-disk state
    // and the user can recover by flipping back. Awaited so volumes are
    // quiesced before export. Best-effort: an unreachable source (often the
    // reason for migrating) is a warning, not a hard stop.
    for (const app of project.applications) {
      try {
        await this.agent.enqueueAndWait(
          oldServerId,
          'REMOVE',
          {
            slug: remoteAppSlug(app.name, app.id),
            legacySlug: slugify(app.name),
            containerName: `dockcontrol-${slugify(app.name)}`,
            purgeVolumes: false,
          },
          5 * 60_000,
        );
      } catch (e: any) {
        warnings.push(`teardown ${app.name}: ${e?.message || e}`);
        degraded = true;
      }
    }
    for (const db of project.databases) {
      try {
        await this.agent.enqueueAndWait(
          oldServerId,
          'REMOVE',
          {
            // DB names are NEVER slugified — databases.service writes the dir
            // as DBS_DIR/<raw name> and names the container with the raw name.
            slug: `db-${db.name}`,
            containerName: `dockcontrol-db-${db.name}`,
            purgeVolumes: false,
          },
          5 * 60_000,
        );
      } catch (e: any) {
        warnings.push(`teardown db ${db.name}: ${e?.message || e}`);
        degraded = true;
      }
    }

    // ── 2. Discover REAL source volume names ──────────────────────────
    const prefixes = [
      ...project.applications.map((a) => appVolumePrefix(a.name, a.id)),
      ...project.databases.filter((d) => !d.autoImported).map((d) => dbVolumePrefix(d.name)),
    ];
    let volumes: string[] = [];
    try {
      if (prefixes.length === 0) {
        volumes = [];
      } else if (sourceLocal) {
        volumes = await this.listLocalProjectVolumes(project.applications, project.databases);
      } else {
        // Ask the source agent for the host's REAL volume names matching our
        // compose-project prefixes (exact-prefix) — no name guessing.
        // VOLUME_LIST is a Phase-1 agent capability not yet mirrored in the
        // Prisma TaskType enum (schema.prisma is outside this batch — see the
        // deferred note), so the type is asserted at the call site.
        const task = await this.agent.enqueueAndWait(
          oldServerId,
          'VOLUME_LIST' as unknown as AgentTaskType,
          { prefixes },
          2 * 60_000,
        );
        if (task.status === 'FAILED') throw new Error(task.error || 'VOLUME_LIST failed');
        volumes = Array.isArray((task.result as any)?.volumes) ? (task.result as any).volumes : [];
      }
    } catch (e: any) {
      warnings.push(`volume discovery: ${e?.message || e}`);
      degraded = true;
    }

    // ── 3. Transfer volumes to the target and AWAIT it ────────────────
    const remoteToLocal = !sourceLocal && targetLocal;
    if (volumes.length > 0) {
      try {
        if (sourceLocal && !targetLocal) {
          // local → remote: export locally, then awaited import on the target.
          const sourceTaskId = await this.exportLocalVolumes(volumes);
          const imp = await this.agent.enqueueAndWait(
            targetServerId,
            'VOLUME_IMPORT',
            { volumes, sourceTaskId },
            30 * 60_000,
          );
          if (imp.status === 'FAILED') throw new Error(imp.error || 'volume import failed');
        } else if (!sourceLocal && !targetLocal) {
          // remote → remote: export on source (chained import keeps the staged
          // tars alive), then await that import's completion on the target.
          const exp = await this.agent.enqueueAndWait(
            oldServerId,
            'VOLUME_EXPORT',
            {
              volumes,
              onComplete: [{ serverId: targetServerId, type: 'VOLUME_IMPORT', payload: { volumes } }],
            },
            30 * 60_000,
          );
          if (exp.status === 'FAILED') throw new Error(exp.error || 'volume export failed');
          const imp = await this.awaitChainedImport(targetServerId, (exp as any).createdAt);
          if (!imp || imp.status === 'FAILED') {
            throw new Error(imp?.error || 'volume import did not complete');
          }
        }
        // remote → local is handled by deferRemoteToLocal below (the import
        // runs in the VOLUME_EXPORT completion handler after we return).
      } catch (e: any) {
        warnings.push(`volume transfer: ${e?.message || e} — source data NOT moved`);
        degraded = true;
      }
    }

    // remote→local imports run in the VOLUME_EXPORT completion handler AFTER
    // this request returns, so deploying now would race an empty volume. Defer
    // the deploys to that handler and report the move as in-flight.
    if (remoteToLocal && volumes.length > 0 && !degraded) {
      return this.deferRemoteToLocal(userId, projectId, project, target, oldServerId, targetServerId, volumes, warnings, pinnedApps, includePinned);
    }

    // ── 4. Deploy on the target via the REAL deploy path ──────────────
    const queued: string[] = [];
    let deployFailed = false;

    for (const app of project.applications) {
      try {
        await this.reassignCollidingPort(app, targetServerId, warnings);
        // Re-point placement to the target BEFORE deploying so resolveAppServer
        // inside ops.redeploy ships the stack to the new host. This is NOT the
        // success flip — project.serverId still points at the source, so a
        // deploy failure stays recoverable on the old server.
        await this.prisma.application.update({
          where: { id: app.id },
          data: { serverId: targetServerId },
        });
        // ops.redeploy ships the full stack (git re-clone / image re-pull /
        // compose + decrypted env) to the target — never a bare marker.
        await this.ops.redeploy(userId, app.id);
        queued.push(app.name);
      } catch (e: any) {
        warnings.push(`deploy ${app.name}: ${e?.message || e}`);
        deployFailed = true;
        degraded = true;
      }
    }

    for (const db of project.databases) {
      try {
        const composeYaml = this.renderDbCompose(db);
        if (!composeYaml) {
          warnings.push(`deploy db ${db.name}: unsupported type ${db.type} — skipped`);
          degraded = true;
          continue;
        }
        const t = await this.agent.enqueueAndWait(
          targetServerId,
          'DEPLOY',
          { slug: `db-${db.name}`, appName: `db-${db.name}`, compose: composeYaml },
          15 * 60_000,
        );
        if (t.status === 'FAILED') throw new Error(t.error || 'agent db deploy failed');
        queued.push(`db:${db.name}`);
      } catch (e: any) {
        warnings.push(`deploy db ${db.name}: ${e?.message || e}`);
        deployFailed = true;
        degraded = true;
      }
    }

    // ── 5. Flip-after-success, or ROLLBACK ────────────────────────────
    if (deployFailed) {
      // Do NOT flip. Revert any per-app placement we changed and restart the
      // source stack so the user is left running where they started.
      await this.rollbackToSource(userId, project, oldServerId, warnings);
      const msg = `Project migration FAILED — left running on ${project.server?.name || oldServerId}. ` +
        `Source volumes are KEPT for recovery. See warnings.`;
      this.appendMailWarning(project, warnings);
      this.appendPinnedWarning(pinnedApps, includePinned, warnings);
      return { status: 'failed', message: msg, queued, warnings, flipped: false };
    }

    // Success: flip project.serverId + every database.serverId so
    // resolveDbServer / connHost follow the move, then regenerate Caddy.
    await this.prisma.project.update({
      where: { id: projectId },
      data: { serverId: targetServerId },
    });
    if (includePinned && pinnedApps.length > 0) {
      // Relocated pinned apps inherit the project default now.
      await this.prisma.application.updateMany({
        where: { id: { in: pinnedApps.map((a) => a.id) } },
        data: { serverId: null },
      });
    }
    await this.prisma.database.updateMany({
      where: { projectId, serverId: oldServerId },
      data: { serverId: targetServerId },
    });
    this.proxy.regenerate().catch(() => {});

    const status = degraded ? 'partial' : 'ok';
    const base = `Project migrated from ${project.server?.name || oldServerId} → ${target.name}.`;
    const volNote = volumes.length > 0
      ? ' Docker volumes were transferred; source volumes are preserved on the old server for recovery.'
      : ' No Docker volumes were present to transfer.';
    const message = status === 'partial'
      ? `${base} Completed with warnings — check them. Source volumes are KEPT on the old server for recovery.`
      : `${base}${volNote}`;

    this.appendMailWarning(project, warnings);
    this.appendPinnedWarning(pinnedApps, includePinned, warnings);
    return { status, message, queued, warnings, flipped: true };
  }

  /**
   * remote→local leg: the volume import runs in the VOLUME_EXPORT completion
   * handler (onVolumeExportForLocalImport) AFTER this request returns, so we
   * can't await the deploys here. Re-enqueue the export carrying the real
   * deploy descriptors for the handler, flip placement, and report in-flight.
   * Apps deploy as full-stack compose/image/git DEPLOYs (the handler can't
   * call ops.redeploy); DBs as compose DEPLOYs — never bare {applicationId}.
   */
  private async deferRemoteToLocal(
    userId: string,
    projectId: string,
    project: any,
    target: any,
    oldServerId: string,
    targetServerId: string,
    volumes: string[],
    warnings: string[],
    pinnedApps: Array<{ id: string; name: string }>,
    includePinned: boolean,
  ) {
    const deploys: Array<{ serverId: string; type: 'DEPLOY'; payload: any }> = [];
    for (const app of project.applications) {
      const payload = await this.buildRemoteAppDeployPayload(app.id);
      if (payload) deploys.push({ serverId: targetServerId, type: 'DEPLOY', payload });
      else warnings.push(`deploy ${app.name}: no shippable stack (no compose/image/git) — skipped`);
    }
    for (const db of project.databases) {
      const composeYaml = this.renderDbCompose(db);
      if (composeYaml) {
        deploys.push({
          serverId: targetServerId,
          type: 'DEPLOY',
          payload: { slug: `db-${db.name}`, appName: `db-${db.name}`, compose: composeYaml },
        });
      }
    }

    // Enqueue the export FIRST. The placement flip below is committed ONLY
    // if this succeeds — otherwise nothing will ever deploy on the target,
    // so flipping would strand the project on a server running nothing while
    // the source sits stopped. On failure we roll back: restart the source
    // and leave the project pointing at the original server.
    try {
      await this.agent.enqueueTask(oldServerId, 'VOLUME_EXPORT', {
        volumes,
        migrateLocalImport: { volumes, deploys },
      });
    } catch (e: any) {
      warnings.push(`volume transfer: ${e?.message || e} — migration aborted, restoring source`);
      // Placement was never flipped in this branch; the source was only
      // STOPPED. Bring it back up (rollbackToSource reverts any app placement
      // touched and redeploys/STARTs on the source).
      await this.rollbackToSource(userId, project, oldServerId, warnings).catch(() => {});
      this.appendMailWarning(project, warnings);
      this.appendPinnedWarning(pinnedApps, includePinned, warnings);
      return {
        status: 'failed' as const,
        message: `Migration to ${target.name} could not start (volume export failed to enqueue). The project stays on its original server — restarting it there. Source volumes are intact.`,
        queued: [],
        warnings,
        flipped: false,
      };
    }

    // Export enqueued — the deferred deploys ride its completion chain, so
    // flipping placement is now safe and the source volumes are preserved
    // for recovery (purgeVolumes:false).
    await this.prisma.project.update({ where: { id: projectId }, data: { serverId: targetServerId } });
    if (includePinned && pinnedApps.length > 0) {
      await this.prisma.application.updateMany({
        where: { id: { in: pinnedApps.map((a) => a.id) } },
        data: { serverId: null },
      });
    }
    for (const app of project.applications) {
      await this.prisma.application.update({ where: { id: app.id }, data: { serverId: targetServerId } });
    }
    await this.prisma.database.updateMany({
      where: { projectId, serverId: oldServerId },
      data: { serverId: targetServerId },
    });
    this.proxy.regenerate().catch(() => {});

    this.appendMailWarning(project, warnings);
    this.appendPinnedWarning(pinnedApps, includePinned, warnings);
    return {
      status: 'ok' as const,
      message: `Project migrated to ${target.name}. Volumes are transferring; apps and databases deploy on the target once the data arrives. Source volumes are preserved for recovery.`,
      queued: [...project.applications.map((a: any) => a.name), ...project.databases.map((d: any) => `db:${d.name}`)],
      warnings,
      flipped: true,
    };
  }

  /**
   * Poll the target for the VOLUME_IMPORT the agent chained off the export
   * (handleTaskTermination enqueues it on COMPLETED). Scoped to imports
   * created at/after `exportCreatedAt` so a stale import from a PRIOR
   * migration is never mistaken for this one. Returns the terminal task or
   * null on timeout.
   */
  private async awaitChainedImport(targetServerId: string, exportCreatedAt?: Date) {
    const deadline = Date.now() + 30 * 60_000;
    const where: any = { serverId: targetServerId, type: 'VOLUME_IMPORT' };
    if (exportCreatedAt) where.createdAt = { gte: exportCreatedAt };
    while (Date.now() < deadline) {
      const imp = await this.prisma.agentTask.findFirst({
        where,
        orderBy: { createdAt: 'desc' },
      });
      if (imp && (imp.status === 'COMPLETED' || imp.status === 'FAILED')) {
        return imp as any;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  /**
   * Build the full-stack remote DEPLOY payload for an app (compose/image/git),
   * mirroring what ops.redeploy ships to a remote agent. Returns null when the
   * app has nothing shippable. Used by the deferred remote→local leg where we
   * can't call ops.redeploy directly.
   */
  private async buildRemoteAppDeployPayload(appId: string): Promise<any | null> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) return null;
    const base = {
      slug: remoteAppSlug(app.name, app.id),
      appName: app.name,
      applicationId: app.id,
    };
    if (app.dockerComposeFile) {
      return { ...base, compose: app.dockerComposeFile, envVars: this.decryptEnvVars(app.envVars) };
    }
    if (app.dockerImage) {
      return { ...base, dockerImage: app.dockerImage, port: app.port ?? undefined, hostPort: app.hostPort ?? undefined, envVars: this.decryptEnvVars(app.envVars) };
    }
    if (app.gitUrl) {
      return { ...base, gitUrl: app.gitUrl, gitBranch: app.gitBranch || 'main', envVars: this.decryptEnvVars(app.envVars) };
    }
    return null;
  }

  /**
   * Decrypt a stored env-var map. Matches application-env.service: the at-rest
   * shape is `{ __k: 1, v: '<encrypted JSON>' }`; legacy rows are plaintext
   * `{ KEY: VALUE }`.
   */
  private decryptEnvVars(raw: any): Record<string, string> {
    if (!raw) return {};
    if (typeof raw === 'object' && raw.__k === 1 && typeof raw.v === 'string') {
      try {
        return JSON.parse(this.encryption.decrypt(raw.v));
      } catch {
        return {};
      }
    }
    return raw as Record<string, string>;
  }

  /**
   * Re-render the compose YAML for a managed database, matching databases.
   * service's DB_CONFIGS templates. The raw db.name is used for the container
   * name + db name (NEVER slugified). Returns null for unknown types.
   * (Duplicated from databases.service because DB_CONFIGS is module-private;
   * see the deferred note in the batch report.)
   */
  private renderDbCompose(db: {
    name: string; type: string; username: string; password: string; port: number;
  }): string | null {
    const name = db.name;
    const user = db.username;
    const pass = this.encryption.decrypt(db.password);
    const port = db.port;
    switch (db.type) {
      case 'POSTGRESQL':
        return `services:\n  ${name}:\n    image: postgres:16-alpine\n    container_name: dockcontrol-db-${name}\n    restart: unless-stopped\n    ports:\n      - "${port}:5432"\n    environment:\n      POSTGRES_DB: ${name}\n      POSTGRES_USER: ${user}\n      POSTGRES_PASSWORD: ${pass}\n    volumes:\n      - data:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U ${user}"]\n      interval: 5s\n      timeout: 5s\n      retries: 5\nvolumes:\n  data:`;
      case 'MYSQL':
        return `services:\n  ${name}:\n    image: mysql:8\n    container_name: dockcontrol-db-${name}\n    restart: unless-stopped\n    ports:\n      - "${port}:3306"\n    environment:\n      MYSQL_DATABASE: ${name}\n      MYSQL_USER: ${user}\n      MYSQL_PASSWORD: ${pass}\n      MYSQL_ROOT_PASSWORD: ${pass}\n    volumes:\n      - data:/var/lib/mysql\nvolumes:\n  data:`;
      case 'MARIADB':
        return `services:\n  ${name}:\n    image: mariadb:11\n    container_name: dockcontrol-db-${name}\n    restart: unless-stopped\n    ports:\n      - "${port}:3306"\n    environment:\n      MARIADB_DATABASE: ${name}\n      MARIADB_USER: ${user}\n      MARIADB_PASSWORD: ${pass}\n      MARIADB_ROOT_PASSWORD: ${pass}\n    volumes:\n      - data:/var/lib/mysql\nvolumes:\n  data:`;
      case 'REDIS':
        return `services:\n  ${name}:\n    image: redis:7-alpine\n    container_name: dockcontrol-db-${name}\n    restart: unless-stopped\n    ports:\n      - "${port}:6379"\n    command: redis-server${pass ? ` --requirepass ${pass}` : ''}\n    volumes:\n      - data:/data\nvolumes:\n  data:`;
      case 'MONGODB':
        return `services:\n  ${name}:\n    image: mongo:7\n    container_name: dockcontrol-db-${name}\n    restart: unless-stopped\n    ports:\n      - "${port}:27017"\n    environment:\n      MONGO_INITDB_DATABASE: ${name}\n      MONGO_INITDB_ROOT_USERNAME: ${user}\n      MONGO_INITDB_ROOT_PASSWORD: ${pass}\n    volumes:\n      - data:/data/db\nvolumes:\n  data:`;
      case 'KEYDB':
        return `services:\n  ${name}:\n    image: eqalpha/keydb:latest\n    container_name: dockcontrol-db-${name}\n    restart: unless-stopped\n    ports:\n      - "${port}:6379"\n    command: keydb-server${pass ? ` --requirepass ${pass}` : ''} --server-threads 2\n    volumes:\n      - data:/data\nvolumes:\n  data:`;
      case 'DRAGONFLY':
        return `services:\n  ${name}:\n    image: docker.dragonflydb.io/dragonflydb/dragonfly:latest\n    container_name: dockcontrol-db-${name}\n    restart: unless-stopped\n    ports:\n      - "${port}:6379"\n    ulimits:\n      memlock: -1\n    command: ["--logtostderr"${pass ? `, "--requirepass=${pass}"` : ''}]\n    volumes:\n      - data:/data\nvolumes:\n  data:`;
      case 'CLICKHOUSE':
        return `services:\n  ${name}:\n    image: clickhouse/clickhouse-server:latest\n    container_name: dockcontrol-db-${name}\n    restart: unless-stopped\n    ports:\n      - "${port}:8123"\n      - "${port + 1000}:9000"\n    ulimits:\n      nofile:\n        soft: 262144\n        hard: 262144\n    environment:\n      CLICKHOUSE_DB: ${name}\n      CLICKHOUSE_USER: ${user}\n      CLICKHOUSE_PASSWORD: ${pass}\n      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: 1\n    volumes:\n      - data:/var/lib/clickhouse\nvolumes:\n  data:`;
      default:
        return null;
    }
  }

  /**
   * If `app` has a stored hostPort that collides with an app already on the
   * TARGET server, reassign a free non-reserved port scoped to that server and
   * persist it (so two relocated apps don't fight over the same host port).
   */
  private async reassignCollidingPort(
    app: { id: string; name: string; hostPort: number | null },
    targetServerId: string,
    warnings: string[],
  ): Promise<void> {
    if (app.hostPort == null) return;
    const others = await this.prisma.application.findMany({
      where: { id: { not: app.id }, hostPort: { not: null }, project: { serverId: targetServerId } },
      select: { hostPort: true },
    });
    const used = new Set<number>(others.map((o) => o.hostPort!).filter((n) => !!n));
    if (!used.has(app.hostPort)) return;
    const old = app.hostPort;
    let free: number | null = null;
    for (let p = 8080; p <= 9999; p++) {
      if (RESERVED_HOST_PORTS.has(p) || used.has(p)) continue;
      free = p;
      break;
    }
    if (free == null) {
      warnings.push(`port: ${app.name} hostPort ${old} collides on the target and no free port was available`);
      return;
    }
    await this.prisma.application.update({ where: { id: app.id }, data: { hostPort: free } });
    app.hostPort = free;
    warnings.push(`port: ${app.name} hostPort reassigned ${old} → ${free} to avoid a collision on the target`);
  }

  /**
   * Migration rollback: revert per-app placement back to the source and
   * RESTART the source stack so the user keeps running where they started.
   */
  private async rollbackToSource(
    userId: string,
    project: any,
    oldServerId: string,
    warnings: string[],
  ): Promise<void> {
    for (const app of project.applications) {
      try {
        // Revert placement to whatever it was before (pinned apps keep their
        // explicit serverId; inherit-apps go back to null → project default).
        await this.prisma.application.update({
          where: { id: app.id },
          data: { serverId: app.serverId && app.serverId !== oldServerId ? app.serverId : null },
        });
      } catch {}
      try {
        await this.ops.redeploy(userId, app.id);
      } catch (e: any) {
        warnings.push(`rollback restart ${app.name}: ${e?.message || e}`);
      }
    }
    for (const db of project.databases) {
      try {
        await this.agent.enqueueTask(oldServerId, 'START', { slug: `db-${db.name}` });
      } catch (e: any) {
        warnings.push(`rollback restart db ${db.name}: ${e?.message || e}`);
      }
    }
  }

  private appendMailWarning(project: { domains?: Array<{ id: string }> }, warnings: string[]): void {
    const n = project.domains?.length ?? 0;
    if (n > 0) {
      warnings.push(`${n} mailbox(es) for these domains remain on the platform host (mail is not relocated).`);
    }
  }

  private appendPinnedWarning(
    pinnedApps: Array<{ name: string }>,
    includePinned: boolean,
    warnings: string[],
  ): void {
    if (!includePinned && pinnedApps.length > 0) {
      warnings.push(
        `${pinnedApps.length} app(s) pinned to other servers were not migrated (their placement is explicit): ${pinnedApps.map((a) => a.name).join(', ')}`,
      );
    }
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
   * Network: dockcontrol_proj_<projectId-stripped>. Every container is named
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
    const networkName = `dockcontrol_proj_${projectId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;

    const apps = project.applications.map((a) => {
      const slug = slugify(a.name);
      const host = a.containerName || `dockcontrol-${slug}`;
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
      // Container name must match what databases.service ACTUALLY creates:
      // `dockcontrol-db-<raw db.name>` (no slugify). slugify's NFKD strip +
      // slice(0,48) can diverge from the raw name, yielding a hostname that
      // doesn't resolve. Same for the db-name path segment in the URL.
      const host = `dockcontrol-db-${d.name}`;
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
        url: `${protocol}://${d.username}:<PASSWORD>@${host}:${port}/${d.name}`,
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
    //
    // The membership is created directly here — there is NO acceptance
    // token and no /invite/accept flow (that frontend route doesn't even
    // exist). The old call passed an EMPTY token to sendUserInvited, which
    // rendered a dead `/invite/accept?token=` CTA. We send a no-token
    // "you were added" email instead, linking straight to the project.
    try {
      const wasUpdate = result.createdAt.getTime() < Date.now() - 5000;
      if (!wasUpdate) {
        const [project, actor] = await Promise.all([
          this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
          this.prisma.user.findUnique({ where: { id: actorId }, select: { name: true } }),
        ]);
        if (project && actor && result.user.email) {
          await this.notifications.sendUserAddedToProject(
            result.user.email,
            project.name,
            actor.name,
            projectId,
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
