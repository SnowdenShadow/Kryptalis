import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainAttachService } from '../domains/domain-attach.service';
import { assertProjectAccess } from '../../common/rbac/project-access';
import { ReverseProxyService } from '../reverse-proxy/reverse-proxy.service';
import {
  execFileAsync,
  slugify,
  resolveAppDir,
  parseComposePorts,
  parseDockerfileExposed,
  remapComposePorts,
  RESERVED_HOST_PORTS,
  findComposePath,
  assertAppOwnership,
} from './applications.helpers';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Networking & port concerns for applications: free-port suggestion,
 * compose/Dockerfile port listing, host-port remapping, URL mode, and
 * domain port bindings. Split out of ApplicationsService.
 */
@Injectable()
export class ApplicationNetworkService {
  constructor(
    private prisma: PrismaService,
    private proxy: ReverseProxyService,
    private domainAttach: DomainAttachService,
  ) {}

  /**
   * Suggest the next free host port for a project's server. Walks
   * upward from 8080, skipping reserved system ports + any hostPort
   * already used by another app on the same server. Caps at 9999 so
   * we never return a port too close to the 65535 ceiling.
   */
  async suggestNextFreePort(userId: string, projectId: string): Promise<{ port: number }> {
    await assertProjectAccess(this.prisma, userId, projectId, 'DEVELOPER');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { serverId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const taken = await this.prisma.application.findMany({
      where: {
        hostPort: { not: null },
        project: { serverId: project.serverId },
      },
      select: { hostPort: true },
    });
    const used = new Set<number>(taken.map((a) => a.hostPort!).filter((n) => !!n));
    for (let p = 8080; p <= 9999; p++) {
      if (RESERVED_HOST_PORTS.has(p)) continue;
      if (used.has(p)) continue;
      return { port: p };
    }
    throw new ConflictException('No free host port available in 8080-9999.');
  }

  // ── ports ──────────────────────────────────────────────────────────

  async listPorts(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    const appDir = resolveAppDir(slugify(app.name), id);
    const composePath = findComposePath(appDir);
    const fromCompose = composePath
      ? parseComposePorts(fs.readFileSync(composePath, 'utf-8'))
      : [];
    const dockerfilePath = path.join(appDir, 'Dockerfile');
    const exposed = fs.existsSync(dockerfilePath)
      ? parseDockerfileExposed(fs.readFileSync(dockerfilePath, 'utf-8'))
      : [];
    return { compose: fromCompose, dockerfileExposed: exposed, appPort: app.port };
  }

  async remapPorts(userId: string, id: string, mapping: Record<string, number>) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    if (!mapping || typeof mapping !== 'object') {
      throw new BadRequestException('mapping required');
    }
    // detect host port conflict across other apps — a host port is a shared host resource.
    // Compare against BOTH the canonical app.port AND every value of portMapping (which can
    // expose several ports per app).
    const wanted = new Set<number>(
      Object.values(mapping).filter((n): n is number => Number.isFinite(n)),
    );
    const otherApps = await this.prisma.application.findMany({
      where: { id: { not: id } },
      select: { name: true, port: true, portMapping: true },
    });
    for (const o of otherApps) {
      const usedByOther: number[] = [];
      if (o.port) usedByOther.push(o.port);
      if (o.portMapping && typeof o.portMapping === 'object') {
        for (const v of Object.values(o.portMapping as Record<string, number>)) {
          if (Number.isFinite(v)) usedByOther.push(Number(v));
        }
      }
      for (const p of usedByOther) {
        if (wanted.has(p)) {
          throw new BadRequestException(`Port ${p} already used by ${o.name}`);
        }
      }
    }
    const appDir = resolveAppDir(slugify(app.name), id);
    const composePath = findComposePath(appDir);
    if (!composePath) throw new BadRequestException('No compose file');
    const content = fs.readFileSync(composePath, 'utf-8');
    const updated = remapComposePorts(content, mapping);
    fs.writeFileSync(composePath, updated);
    // canonical app port = first remapped host port (used by the dashboard URL)
    // Any explicit remap means the user is picking a port → customPort=true.
    const firstHost = wanted.values().next().value;
    await this.prisma.application.update({
      where: { id },
      data: {
        portMapping: mapping,
        ...(firstHost && firstHost !== app.port ? { port: firstHost } : {}),
        customPort: true,
      },
    });
    // Recreate the container so the new port binding takes effect. Compose's
    // `up -d` is idempotent — it stops/recreates ONLY services whose config
    // changed (i.e. the port-mapped one) and leaves the rest alone. Without
    // this the file is rewritten but the running container keeps the old
    // port until the next manual restart, which is the "ça fait rien" UX.
    try {
      await execFileAsync('docker', ['compose', 'up', '-d', '--remove-orphans'], {
        cwd: appDir,
        timeout: 120_000,
      });
    } catch (err: any) {
      // Surface the failure but don't roll back the DB — the file is correct
      // on disk; the user can hit "Redeploy" to retry.
      throw new BadRequestException(
        `Ports written but docker compose up failed: ${err?.stderr || err?.message || 'unknown'}`,
      );
    }
    this.proxy.regenerate().catch(() => {});
    return { message: 'Ports remapped and container restarted', mapping };
  }

  /**
   * Toggle how the app's URL is exposed:
   *   - customPort=false → Caddy serves https://<domain> on :443 (clean URL)
   *   - customPort=true  → 308-redirect to https://<domain>:<port> (port-pinned)
   * Updates the DB row and asks Caddy to regenerate so the change takes effect
   * within seconds. The user can flip back and forth without touching the
   * compose file.
   */
  async setUrlMode(userId: string, id: string, customPort: boolean) {
    await assertAppOwnership(this.prisma, userId, id);
    const updated = await this.prisma.application.update({
      where: { id },
      data: { customPort: !!customPort },
      select: { id: true, customPort: true, port: true },
    });
    this.proxy.regenerate().catch(() => {});
    return updated;
  }

  /**
   * Add a (domain, port) → this app binding. Lets the user co-host this app
   * on a domain that already serves another app on a different port. Delegates
   * to DomainAttachService so the conflict rules stay consistent with what
   * the marketplace / git-deploy use.
   */
  async addPortBinding(userId: string, appId: string, domainId: string, port: number) {
    const app = await assertAppOwnership(this.prisma, userId, appId);
    await this.domainAttach.attach({
      applicationId: appId,
      domainId,
      projectId: app.projectId,
      customPort: true,
      port,
    });
    this.proxy.regenerate().catch(() => {});
    return this.prisma.domainPortBinding.findUnique({
      where: { domainId_port: { domainId, port } },
    });
  }

  /** Remove one port binding. Ownership check goes through the bound app. */
  async removePortBinding(userId: string, bindingId: string) {
    const binding = await this.prisma.domainPortBinding.findUnique({
      where: { id: bindingId },
    });
    if (!binding) throw new NotFoundException('Binding not found');
    await assertAppOwnership(this.prisma, userId, binding.applicationId);
    await this.prisma.domainPortBinding.delete({ where: { id: bindingId } });
    this.proxy.regenerate().catch(() => {});
    return { message: 'Binding removed' };
  }
}
