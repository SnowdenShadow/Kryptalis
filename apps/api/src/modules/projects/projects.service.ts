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
import {
  assertCapability,
  listEffectivePermissions,
} from '../../common/rbac/project-permissions';
import { sanitizePermissions, permissionsForRole } from '../../common/rbac/permissions';
import type { ProjectRole } from '@prisma/client';
import { AgentService, AgentTaskCompletion } from '../agent/agent.service';
import { appVolumePrefix, dbVolumePrefix } from '../agent/volume-naming.util';
import { slugify, remoteAppSlug, RESERVED_HOST_PORTS } from '../applications/applications.helpers';
import { ApplicationOpsService } from '../applications/application-ops.service';
import { ApplicationsService } from '../applications/applications.service';
import { DatabasesService } from '../databases/databases.service';
import { renderDbCompose as renderDbComposeShared } from '../databases/db-configs';
import { runCommandToFile, runCommandWithInputFile } from '../databases/db-dump.util';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import { MailServerService } from '../email/mail-server.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { isLocalHost } from '../deployment-target/deployment-target.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

/** Zero-initialised resource-usage accumulator (bytes + summed CPU %). */
function emptyUsage() {
  return {
    cpuPercent: 0,
    memoryUsed: 0,
    memoryLimit: 0,
    networkIn: 0,
    networkOut: 0,
    blockRead: 0,
    blockWrite: 0,
    containers: 0,
  };
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
    private databases: DatabasesService,
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
    // A project is a purely logical grouping — it has no server. The machine is
    // chosen per app/database at their own create time (auto in LOCAL mode).
    const project = await this.prisma.project.create({
      data: {
        ...dto,
        userId,
        members: {
          create: { userId, role: 'OWNER' },
        },
      },
    });
    return project;
  }

  async findAll(userId: string) {
    const ids = await listAccessibleProjectIds(this.prisma, userId);
    if (ids.length === 0) return [];
    return this.prisma.project.findMany({
      where: { id: { in: ids } },
      include: {
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
        // Per-app teardown is delegated to applications.remove() (which
        // resolves each app's own server), so we only need id + name here.
        applications: { select: { id: true, name: true, server: { select: { host: true } } } },
        databases: { select: { id: true, name: true, autoImported: true } },
        domains: { select: { id: true, domain: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    // A project has no server; the dedicated docker network only exists on the
    // API host when at least one of its apps runs locally.
    const isLocal = project.applications.some((a) => isLocalHost(a.server?.host));

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
    //
    // Delegate standalone teardown to DatabasesService.remove(), which resolves
    // each DB's OWN server (resolveDbServer) and tears it down local-or-remote
    // accordingly. The previous inline copy derived local-vs-remote from the
    // PROJECT's server and enqueued the REMOVE to project.serverId — so a DB
    // placed on a DIFFERENT server than its project (per-DB placement, allowed
    // by databases.create) leaked its container + volume on the wrong host and
    // was never removed. Best-effort per DB: one failure must not abort the
    // rest of the project teardown.
    for (const db of project.databases) {
      if (db.autoImported) continue;
      try {
        await this.databases.remove(userId, db.id);
      } catch (err: any) {
        this.logger.warn(`project remove: database "${db.name}" cleanup failed: ${err?.message || err}`);
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
   *   5. ONLY on success: flip every application.serverId + database.serverId
   *      (a project has no serverId of its own), then regenerate Caddy.
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
  ) {
    await assertProjectAccess(this.prisma, userId, projectId, 'OWNER');

    const projectFull = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        applications: { select: { id: true, name: true, status: true, serverId: true, hostPort: true } },
        databases: {
          select: { id: true, name: true, type: true, username: true, password: true, port: true, autoImported: true, serverId: true },
        },
        domains: { select: { id: true } },
      },
    });
    if (!projectFull) throw new NotFoundException('Project not found');
    const project = projectFull;

    const target = await this.prisma.server.findUnique({ where: { id: targetServerId } });
    if (!target) throw new NotFoundException('Target server not found');
    if (target.status !== 'ONLINE') {
      throw new BadRequestException(`Target server "${target.name}" is ${target.status} — must be ONLINE`);
    }

    // A project has no server — every app/DB carries its own. "Migrate the
    // project" moves them ALL to the target. The volume-transfer machinery is
    // single-source, so require the project's infra to share ONE source server
    // (the normal case); apps deliberately split across servers must be moved
    // one at a time via the per-app move.
    const sourceIds = new Set<string>([
      ...project.applications.map((a) => a.serverId),
      ...project.databases.filter((d) => !d.autoImported).map((d) => d.serverId),
    ]);
    sourceIds.delete(targetServerId); // already-on-target items need no move
    if (sourceIds.size === 0) {
      throw new BadRequestException('Project is already on this server');
    }
    if (sourceIds.size > 1) {
      throw new BadRequestException(
        'This project\'s apps/databases span multiple servers — move them individually instead.',
      );
    }
    const oldServerId = [...sourceIds][0];
    const sourceServer = await this.prisma.server.findUnique({
      where: { id: oldServerId },
      select: { id: true, host: true, name: true },
    });

    const sourceLocal = isLocalHost(sourceServer?.host);
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
        const task = await this.agent.enqueueAndWait(
          oldServerId,
          'VOLUME_LIST',
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
      return this.deferRemoteToLocal(userId, projectId, project, target, oldServerId, targetServerId, volumes, warnings);
    }

    // ── 4. Deploy on the target via the REAL deploy path ──────────────
    const queued: string[] = [];
    let deployFailed = false;

    for (const app of project.applications) {
      try {
        await this.reassignCollidingPort(app, targetServerId, warnings);
        // Re-point placement to the target BEFORE deploying so resolveAppServer
        // inside ops.redeploy ships the stack to the new host. This is NOT the
        // success flip — the database.serverId rows still point at the source
        // (flipped only after every deploy succeeds), so a deploy failure stays
        // recoverable on the old server.
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
      // Do NOT flip the DB placements. Revert any per-app placement we changed
      // and restart the source stack so the user is left where they started.
      await this.rollbackToSource(userId, project, oldServerId, warnings);
      const msg = `Project migration FAILED — left running on ${sourceServer?.name || oldServerId}. ` +
        `Source volumes are KEPT for recovery. See warnings.`;
      this.appendMailWarning(project, warnings);
      return { status: 'failed', message: msg, queued, warnings, flipped: false };
    }

    // Success: flip every database.serverId so resolveDbServer / connHost
    // follow the move (the apps were already re-pointed before their deploy),
    // then regenerate Caddy.
    await this.prisma.database.updateMany({
      where: { projectId, serverId: oldServerId },
      data: { serverId: targetServerId },
    });
    this.proxy.regenerate().catch(() => {});

    const status = degraded ? 'partial' : 'ok';
    const base = `Project apps migrated from ${sourceServer?.name || oldServerId} → ${target.name}.`;
    const volNote = volumes.length > 0
      ? ' Docker volumes were transferred; source volumes are preserved on the old server for recovery.'
      : ' No Docker volumes were present to transfer.';
    const message = status === 'partial'
      ? `${base} Completed with warnings — check them. Source volumes are KEPT on the old server for recovery.`
      : `${base}${volNote}`;

    this.appendMailWarning(project, warnings);
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
    // for recovery (purgeVolumes:false). Re-point every app + DB to the target.
    for (const app of project.applications) {
      await this.prisma.application.update({ where: { id: app.id }, data: { serverId: targetServerId } });
    }
    await this.prisma.database.updateMany({
      where: { projectId, serverId: oldServerId },
      data: { serverId: targetServerId },
    });
    this.proxy.regenerate().catch(() => {});

    this.appendMailWarning(project, warnings);
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
   * Re-render the compose YAML for a managed database during project
   * migration. Thin wrapper over the shared DB_CONFIGS renderer
   * (databases/db-configs.ts) — the single source of truth both modules use,
   * so the two can no longer drift. The raw db.name is used for the container
   * name + db name (NEVER slugified). Returns null for unknown types.
   */
  private renderDbCompose(db: {
    name: string; type: string; username: string; password: string; port: number;
  }): string | null {
    // Delegate to the shared DB_CONFIGS templates (databases/db-configs.ts) so
    // this migration path can never drift from the databases-module renderer
    // again. We decrypt the stored password here — the template module is
    // dependency-free and works on the plaintext.
    return renderDbComposeShared(
      { name: db.name, type: db.type, username: db.username, port: db.port },
      this.encryption.decrypt(db.password),
    );
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
      where: { id: { not: app.id }, hostPort: { not: null }, serverId: targetServerId },
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

  // ── Resource usage (aggregated across the project's apps) ───────────

  /**
   * Current resource consumption of the whole project: the latest metric
   * sample per app (summed into project totals) plus a per-app breakdown.
   * Reads ContainerMetric — populated by the agent heartbeat (remote) and the
   * local docker-stats collector. VIEWER+ on the project.
   *
   * "Latest per app" sums every container of that app (a PHP nginx app has a
   * web + -fpm sidecar, a compose stack several) at its most recent timestamp,
   * so multi-container apps aren't under-counted.
   */
  async getResourceUsage(projectId: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    const apps = await this.prisma.application.findMany({
      where: { projectId },
      select: { id: true, name: true, displayName: true, status: true, framework: true },
    });
    if (apps.length === 0) {
      return { projectId, totals: emptyUsage(), apps: [] };
    }

    // One recent window is enough to find each container's latest sample.
    const since = new Date(Date.now() - 10 * 60_000);
    const rows = await this.prisma.containerMetric.findMany({
      where: { applicationId: { in: apps.map((a) => a.id) }, timestamp: { gte: since } },
      orderBy: { timestamp: 'desc' },
    });

    // Keep the newest row per (app, container), then sum per app.
    const seen = new Set<string>();
    const perApp = new Map<string, ReturnType<typeof emptyUsage>>();
    for (const r of rows) {
      const key = `${r.applicationId}:${r.containerName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const acc = perApp.get(r.applicationId!) ?? emptyUsage();
      acc.cpuPercent += r.cpuPercent;
      acc.memoryUsed += Number(r.memoryUsed);
      acc.memoryLimit += Number(r.memoryLimit);
      acc.networkIn += Number(r.networkIn);
      acc.networkOut += Number(r.networkOut);
      acc.blockRead += Number(r.blockRead);
      acc.blockWrite += Number(r.blockWrite);
      acc.containers += 1;
      perApp.set(r.applicationId!, acc);
    }

    const appUsage = apps.map((a) => ({
      id: a.id,
      name: a.displayName || a.name,
      status: a.status,
      framework: a.framework,
      usage: perApp.get(a.id) ?? emptyUsage(),
    }));

    const totals = emptyUsage();
    for (const u of perApp.values()) {
      totals.cpuPercent += u.cpuPercent;
      totals.memoryUsed += u.memoryUsed;
      totals.memoryLimit += u.memoryLimit;
      totals.networkIn += u.networkIn;
      totals.networkOut += u.networkOut;
      totals.blockRead += u.blockRead;
      totals.blockWrite += u.blockWrite;
      totals.containers += u.containers;
    }
    // Round the summed CPU to one decimal (float sums drift).
    totals.cpuPercent = Math.round(totals.cpuPercent * 10) / 10;

    return { projectId, totals, apps: appUsage };
  }

  /**
   * Historical project consumption: CPU % and memory summed across ALL the
   * project's containers, bucketed over time (24h/7d/30d). One series for the
   * whole project — the "is my project heavier this week?" view.
   */
  async getResourceHistory(projectId: string, userId: string, period = '24h') {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    const apps = await this.prisma.application.findMany({
      where: { projectId },
      select: { id: true },
    });
    if (apps.length === 0) return [];

    const periodMs: Record<string, number> = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const ms = periodMs[period] || periodMs['24h'];
    const since = new Date(Date.now() - ms);
    const rows = await this.prisma.containerMetric.findMany({
      where: { applicationId: { in: apps.map((a) => a.id) }, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
      select: { cpuPercent: true, memoryUsed: true, timestamp: true },
    });
    if (rows.length === 0) return [];

    // Bucket size: 24h raw-ish (5m), 7d → 1h, 30d → 1h capped at 720 pts.
    let bucketMs = ms <= periodMs['24h'] ? 5 * 60 * 1000 : 60 * 60 * 1000;
    if (Math.ceil(ms / bucketMs) > 720) bucketMs = Math.ceil(ms / 720);

    // Sum every container in a bucket → project-wide CPU% + memory bytes.
    const buckets = new Map<number, { start: number; cpu: number; mem: number }>();
    for (const r of rows) {
      const slot = Math.floor(r.timestamp.getTime() / bucketMs);
      const acc = buckets.get(slot) ?? { start: slot * bucketMs, cpu: 0, mem: 0 };
      acc.cpu += r.cpuPercent;
      acc.mem += Number(r.memoryUsed);
      buckets.set(slot, acc);
    }
    return Array.from(buckets.values())
      .sort((a, b) => a.start - b.start)
      .map((b) => ({
        timestamp: new Date(b.start),
        cpuPercent: Math.round(b.cpu * 10) / 10,
        memoryUsed: b.mem,
      }));
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

    // Guard against the "I added my own email and it demoted me" foot-gun.
    // Adding YOURSELF here is always a mistake: you're already a member (that's
    // how you got to this screen), and the upsert below would OVERWRITE your
    // real role with the one picked in the dialog — an OWNER who re-adds
    // themselves as DEVELOPER silently loses control of the project. Changing
    // your own role isn't a thing you do from "Add member" — refuse it.
    if (targetUserId === actorId) {
      throw new BadRequestException(
        "You're already a member of this project — you can't add or re-role yourself here. Use \"Transfer ownership\" to hand OWNER to someone else.",
      );
    }

    // If the target is ALREADY a member, this is a role change, not an add —
    // route it through the same protections updateMember enforces (can't touch
    // an OWNER unless you are one, can't demote the last OWNER). Without this,
    // "Add member" is an unguarded backdoor around every updateMember rule.
    const existing = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: targetUserId },
      select: { id: true, role: true },
    });
    if (existing) {
      if (existing.role === payload.role) return existing as any; // no-op
      if (existing.role === 'OWNER' && actorRole !== 'OWNER') {
        throw new BadRequestException('Only the OWNER can modify the OWNER');
      }
      if (existing.role === 'OWNER' && payload.role !== 'OWNER') {
        const owners = await this.prisma.projectMember.count({
          where: { projectId, role: 'OWNER' },
        });
        if (owners <= 1) {
          throw new BadRequestException(
            'Cannot demote the last OWNER. Promote another member to OWNER first.',
          );
        }
      }
    }

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

  /** Caller's effective fine-grained permissions on this project (for the UI
   *  to gate actions). Any member can read their own. */
  async getMyPermissions(projectId: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    return listEffectivePermissions(this.prisma, userId, projectId);
  }

  // ── Custom roles ────────────────────────────────────────────────────

  /** List the project's reusable custom roles + how many members use each. */
  async listCustomRoles(projectId: string, userId: string) {
    await assertProjectAccess(this.prisma, userId, projectId, 'VIEWER');
    return this.prisma.projectCustomRole.findMany({
      where: { projectId },
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Create a custom role. ADMIN+ (roles:manage is rank-gated). Permissions
   *  are sanitized against the catalog; a role can never carry a permission
   *  above its baseRole's preset (no privilege escalation through the grid). */
  async createCustomRole(
    projectId: string,
    userId: string,
    dto: { name: string; baseRole?: ProjectRole; permissions?: string[] },
  ) {
    await assertCapability(this.prisma, userId, projectId, 'roles:manage');
    const name = (dto.name || '').trim();
    if (!name) throw new BadRequestException('Role name is required');
    if (name.length > 40) throw new BadRequestException('Role name too long (max 40)');
    const baseRole: ProjectRole = dto.baseRole && dto.baseRole !== 'OWNER' ? dto.baseRole : 'DEVELOPER';
    const permissions = this.cappedPermissions(dto.permissions, baseRole);
    try {
      return await this.prisma.projectCustomRole.create({
        data: { projectId, name, baseRole, permissions },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException('A role with that name already exists');
      throw e;
    }
  }

  async updateCustomRole(
    projectId: string,
    userId: string,
    roleId: string,
    dto: { name?: string; baseRole?: ProjectRole; permissions?: string[] },
  ) {
    await assertCapability(this.prisma, userId, projectId, 'roles:manage');
    const role = await this.prisma.projectCustomRole.findFirst({ where: { id: roleId, projectId } });
    if (!role) throw new NotFoundException('Custom role not found');
    const baseRole: ProjectRole =
      dto.baseRole && dto.baseRole !== 'OWNER' ? dto.baseRole : (role.baseRole as ProjectRole);
    const data: any = { baseRole };
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Role name is required');
      data.name = name;
    }
    if (dto.permissions !== undefined) {
      data.permissions = this.cappedPermissions(dto.permissions, baseRole);
    }
    // Keep members' rank in sync when the baseRole changes.
    try {
      const updated = await this.prisma.projectCustomRole.update({ where: { id: roleId }, data });
      if (dto.baseRole && dto.baseRole !== role.baseRole) {
        await this.prisma.projectMember.updateMany({
          where: { projectId, customRoleId: roleId },
          data: { role: baseRole },
        });
      }
      return updated;
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException('A role with that name already exists');
      throw e;
    }
  }

  async deleteCustomRole(projectId: string, userId: string, roleId: string) {
    await assertCapability(this.prisma, userId, projectId, 'roles:manage');
    const role = await this.prisma.projectCustomRole.findFirst({ where: { id: roleId, projectId } });
    if (!role) throw new NotFoundException('Custom role not found');
    // FK is SetNull → affected members revert to their base `role`.
    await this.prisma.projectCustomRole.delete({ where: { id: roleId } });
    return { message: 'Custom role deleted' };
  }

  /**
   * Assign (or clear) a custom role on a member. ADMIN+ (members:manage).
   * Clearing (roleId=null) reverts the member to their plain `role`. Assigning
   * also syncs the member's `role` to the custom role's baseRole so the
   * rank-only checks (assertProjectAccess) stay correct.
   */
  async assignCustomRole(
    projectId: string,
    actorId: string,
    memberId: string,
    roleId: string | null,
  ) {
    await assertCapability(this.prisma, actorId, projectId, 'members:manage');
    const member = await this.prisma.projectMember.findFirst({ where: { id: memberId, projectId } });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === 'OWNER') {
      throw new BadRequestException("The OWNER's role can't be changed to a custom role.");
    }
    if (roleId === null) {
      return this.prisma.projectMember.update({
        where: { id: memberId },
        data: { customRoleId: null },
      });
    }
    const role = await this.prisma.projectCustomRole.findFirst({ where: { id: roleId, projectId } });
    if (!role) throw new NotFoundException('Custom role not found');
    return this.prisma.projectMember.update({
      where: { id: memberId },
      data: { customRoleId: roleId, role: role.baseRole as ProjectRole },
    });
  }

  /** Sanitize + cap a permission list to what the baseRole's preset allows, so
   *  a custom role can never grant more than its base built-in role. */
  private cappedPermissions(input: unknown, baseRole: ProjectRole): string[] {
    const requested = sanitizePermissions(input);
    const allowed = new Set(permissionsForRole(baseRole));
    return requested.filter((p) => allowed.has(p));
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
