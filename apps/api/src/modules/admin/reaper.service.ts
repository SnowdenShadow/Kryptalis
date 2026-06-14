import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PrismaService } from '../../prisma/prisma.service';

const exec = promisify(execFile);

/**
 * Docker reaper.
 *
 * Garbage-collects docker artefacts (images, volumes, networks, stopped
 * containers) that USED to belong to a DockControl app/db/project but whose
 * owning DB row no longer exists. The compose `down -v --rmi local` we
 * now run on delete handles the happy path; the reaper exists for:
 *
 *   1. Historical accumulation — apps deleted before the cleanup logic
 *      landed left orphans (the user saw 9× `enopya-*-web:latest` images
 *      and 6× `wordpress-*_default` networks).
 *   2. Crashed/partial deletes — if `down` timed out or the dashboard
 *      was killed mid-delete, artefacts can linger.
 *   3. Manual `docker rm` outside the platform — operator did it by hand,
 *      the file dir is gone but the volume isn't.
 *
 * Strategy: **inventory live state, intersect with the DB, delete the
 * difference.** We NEVER remove anything we can't tie back to a known
 * DockControl naming convention — leaves user-launched containers alone.
 *
 * Naming conventions matched (all from applications.service.ts /
 * marketplace templates.ts):
 *
 *   containers:  dockcontrol-<slug>(-<appId12>)? | dockcontrol-db-<dbname>
 *   images:      <slug>-<appId12>-* | dockcontrol-<slug>(-<appId12>)?
 *   volumes:     <slug>-<appId12>_* | wordpress-<id>_wp_* etc.
 *   networks:    dockcontrol_proj_<projectId-stripped> | <slug>-<id>_default
 *
 * The `appId12` is the prefix DB primary keys share — knowing it lets us
 * answer "is this artefact owned by a still-alive row?" without any
 * label parsing or compose project introspection. Adding labels on every
 * deploy would be cleaner long-term but would not help the existing
 * orphans, which is the immediate pain.
 */
@Injectable()
export class ReaperService {
  private readonly logger = new Logger(ReaperService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Dry-run scan: returns what WOULD be removed without touching anything.
   * Used by the admin UI to confirm the impact before pulling the trigger.
   */
  async scan(): Promise<ReaperReport> {
    return this.runImpl({ apply: false });
  }

  /** Apply: actually remove every flagged artefact. Returns the same shape. */
  async reap(): Promise<ReaperReport> {
    return this.runImpl({ apply: true });
  }

  private async runImpl(opts: { apply: boolean }): Promise<ReaperReport> {
    const liveAppIds = await this.liveAppIds();
    const liveDbNames = await this.liveDbNames();
    const liveProjectIds = await this.liveProjectIds();

    const containers = await this.findOrphanContainers(liveAppIds, liveDbNames);
    const images = await this.findOrphanImages(liveAppIds);
    const volumes = await this.findOrphanVolumes(liveAppIds);
    const networks = await this.findOrphanNetworks(liveAppIds, liveProjectIds);

    if (opts.apply) {
      // Order matters: containers first (they hold refs to volumes +
      // networks + images). Then volumes (depend on stopped containers
      // being gone). Then networks (need containers detached). Images
      // last (can be tagged by stopped containers we just removed).
      for (const c of containers) {
        try {
          await exec('docker', ['rm', '-f', c.id], { timeout: 30_000 });
        } catch (e: any) { this.logger.warn(`rm container ${c.id}: ${e?.message || e}`); }
      }
      for (const v of volumes) {
        try {
          await exec('docker', ['volume', 'rm', '-f', v.name], { timeout: 15_000 });
        } catch (e: any) { this.logger.warn(`rm volume ${v.name}: ${e?.message || e}`); }
      }
      for (const n of networks) {
        try {
          await exec('docker', ['network', 'rm', n.name], { timeout: 15_000 });
        } catch (e: any) { this.logger.warn(`rm network ${n.name}: ${e?.message || e}`); }
      }
      for (const i of images) {
        try {
          await exec('docker', ['rmi', '-f', i.id], { timeout: 30_000 });
        } catch (e: any) { this.logger.warn(`rmi image ${i.id}: ${e?.message || e}`); }
      }
    }

    return { containers, images, volumes, networks, applied: opts.apply };
  }

  // ── DB-side inventory ────────────────────────────────────────────

  private async liveAppIds(): Promise<Set<string>> {
    const rows = await this.prisma.application.findMany({ select: { id: true, name: true } });
    const out = new Set<string>();
    for (const r of rows) {
      // We match against the first 12 chars of the cuid (used as the
      // appId suffix in containers/volumes/networks) AND against the
      // full id for safety. Slug isn't stored — derived at deploy time
      // from name; the reaper only needs the id prefix to recognize
      // ownership.
      out.add(r.id);
      out.add(r.id.slice(0, 12));
    }
    return out;
  }

  private async liveDbNames(): Promise<Set<string>> {
    const rows = await this.prisma.database.findMany({ select: { name: true } });
    return new Set(rows.map((r) => r.name));
  }

  private async liveProjectIds(): Promise<Set<string>> {
    const rows = await this.prisma.project.findMany({ select: { id: true } });
    const out = new Set<string>();
    for (const r of rows) {
      // The project network name strips non-alphanum from the cuid, so
      // we record both raw + stripped to match docker's network list.
      out.add(r.id);
      out.add(r.id.replace(/[^a-z0-9]/gi, '').toLowerCase());
    }
    return out;
  }

  // ── docker-side inventory ────────────────────────────────────────

  private async findOrphanContainers(
    liveAppIds: Set<string>,
    liveDbNames: Set<string>,
  ): Promise<OrphanContainer[]> {
    const { stdout } = await exec('docker', [
      'ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}',
    ]);
    const out: OrphanContainer[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [id, names, image, status] = line.split('\t');
      const name = (names || '').split(',')[0];
      // App containers: dockcontrol-<slug>-<appId12> or dockcontrol-<slug>
      const appMatch = name.match(/^dockcontrol-(?!db-)([a-z0-9-]+?)(?:-([a-z0-9]{12}))?$/);
      if (appMatch) {
        const idPart = appMatch[2];
        // No id suffix → legacy slug-only deploy. We can't safely link
        // those back to a row without keeping a slug index. Skip them
        // to avoid false positives. Their cleanup needs operator review.
        if (!idPart) continue;
        if (!liveAppIds.has(idPart)) {
          out.push({ id, name, image, status, reason: `appId ${idPart} not in DB` });
        }
        continue;
      }
      // DB containers: dockcontrol-db-<dbname>
      const dbMatch = name.match(/^dockcontrol-db-(.+)$/);
      if (dbMatch && !liveDbNames.has(dbMatch[1])) {
        out.push({ id, name, image, status, reason: `db ${dbMatch[1]} not in DB` });
      }
    }
    return out;
  }

  private async findOrphanImages(liveAppIds: Set<string>): Promise<OrphanImage[]> {
    const { stdout } = await exec('docker', ['images', '--format', '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}']);
    const out: OrphanImage[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [id, repo, tag, size] = line.split('\t');
      // Compose-built images: <slug>-<appId12>-<service>:latest (e.g. "enopya-cmq5fjadj000-web")
      const m = repo.match(/^[a-z0-9-]+-([a-z0-9]{12})-[a-z0-9-]+$/);
      if (m && !liveAppIds.has(m[1])) {
        out.push({ id, repo, tag, size, reason: `appId ${m[1]} not in DB` });
        continue;
      }
      // Custom-deploy images: dockcontrol-<anything>
      const k = repo.match(/^dockcontrol\/([a-z0-9-]+):/);
      if (k) {
        // We don't currently track these by id — skip unless explicitly
        // dangling. Adds a safety floor: never remove images that aren't
        // clearly identifiable as ours-and-orphan.
        continue;
      }
    }
    return out;
  }

  private async findOrphanVolumes(liveAppIds: Set<string>): Promise<OrphanVolume[]> {
    const { stdout } = await exec('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    const out: OrphanVolume[] = [];
    for (const name of stdout.trim().split('\n').filter(Boolean)) {
      // Compose-managed volumes carry the project prefix:
      //   <slug>-<appId12>_<volname>_<appId12>   (templates use __INSTANCE_ID__)
      //   <slug>-<appId12>_<volname>             (generic compose form)
      const m = name.match(/^[a-z0-9-]+-([a-z0-9]{12})_/);
      if (m && !liveAppIds.has(m[1])) {
        out.push({ name, reason: `appId ${m[1]} not in DB` });
      }
    }
    return out;
  }

  private async findOrphanNetworks(
    liveAppIds: Set<string>,
    liveProjectIds: Set<string>,
  ): Promise<OrphanNetwork[]> {
    const { stdout } = await exec('docker', ['network', 'ls', '--format', '{{.Name}}\t{{.Driver}}']);
    const out: OrphanNetwork[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name] = line.split('\t');
      // Compose default networks: <slug>-<appId12>_default
      const m = name.match(/^[a-z0-9-]+-([a-z0-9]{12})_default$/);
      if (m && !liveAppIds.has(m[1])) {
        out.push({ name, reason: `appId ${m[1]} not in DB` });
        continue;
      }
      // Project networks: dockcontrol_proj_<projectIdStripped>
      const p = name.match(/^dockcontrol_proj_([a-z0-9]+)$/);
      if (p && !liveProjectIds.has(p[1])) {
        out.push({ name, reason: `projectId ${p[1]} not in DB` });
      }
    }
    return out;
  }
}

// ── Types ──────────────────────────────────────────────────────────

export interface OrphanContainer {
  id: string; name: string; image: string; status: string; reason: string;
}
export interface OrphanImage {
  id: string; repo: string; tag: string; size: string; reason: string;
}
export interface OrphanVolume { name: string; reason: string; }
export interface OrphanNetwork { name: string; reason: string; }

export interface ReaperReport {
  containers: OrphanContainer[];
  images: OrphanImage[];
  volumes: OrphanVolume[];
  networks: OrphanNetwork[];
  applied: boolean;
}
