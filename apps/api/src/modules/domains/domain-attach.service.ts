import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Single source of truth for "wire an application to a domain". Used by every
 * code path that links an app to a domain — marketplace install, custom-image
 * install, git-deploy app creation, manual attach from the dashboard.
 *
 * Two attach modes, picked by `customPort`:
 *
 *   - **Clean URL** (customPort=false) — app takes the domain's `:443` slot
 *     (Domain.applicationId). At most ONE clean-URL app per domain.
 *
 *   - **Port-pinned** (customPort=true) — app registers a DomainPortBinding
 *     row `(domain, port) → app`. Multiple port-pinned apps can co-host on
 *     the same domain as long as each lives on its own port.
 *
 * Conflict policy is consistent across all modes:
 *
 *   - same-project conflict on the same slot → auto-replace
 *     (the user is clearly swapping the previous tenant)
 *   - cross-project conflict → refuse with a clear pointer to the owner
 *   - cross-mode collision (e.g. port-pinned binding on the same port the
 *     clean-URL app already uses) → refuse, surface the conflict
 */
@Injectable()
export class DomainAttachService {
  constructor(private prisma: PrismaService) {}

  /**
   * Attach `applicationId` to `domainId` according to the rules above.
   * Idempotent: re-attaching the same app to the same slot is a no-op.
   *
   * @returns the link kind that was created/refreshed, for the caller to log.
   */
  async attach(opts: {
    applicationId: string;
    domainId: string;
    projectId: string;
    customPort: boolean;
    port: number;
  }): Promise<{ kind: 'main' | 'binding'; replaced?: string }> {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new BadRequestException(`port must be 1-65535 (got ${opts.port})`);
    }

    const domain = await this.prisma.domain.findUnique({
      where: { id: opts.domainId },
      include: {
        application: { select: { id: true, name: true, projectId: true, port: true } },
        portBindings: {
          include: { application: { select: { id: true, name: true, projectId: true } } },
        },
      },
    });
    if (!domain) throw new NotFoundException('Domain not found');

    if (opts.customPort) {
      // ── port-pinned path ────────────────────────────────────────
      // Refuse if the port is the clean-URL app's port too — Caddy can't
      // route both to the same port, the conflict is real.
      if (domain.application && domain.application.port === opts.port && domain.application.id !== opts.applicationId) {
        throw new ConflictException(
          `Port ${opts.port} on ${domain.domain} is the main app "${domain.application.name}"'s port. Pick a different port.`,
        );
      }

      const occupied = domain.portBindings.find(
        (b) => b.port === opts.port && b.applicationId !== opts.applicationId,
      );
      if (occupied) {
        if (occupied.application.projectId === opts.projectId) {
          await this.prisma.domainPortBinding.delete({ where: { id: occupied.id } });
          await this.prisma.domainPortBinding.create({
            data: {
              domainId: opts.domainId,
              applicationId: opts.applicationId,
              port: opts.port,
            },
          });
          return { kind: 'binding', replaced: occupied.application.name };
        }
        throw new ConflictException(
          `Port ${opts.port} on ${domain.domain} is already used by "${occupied.application.name}" in another project.`,
        );
      }

      // Idempotent: if this app already holds this (domain, port), no-op.
      const existing = domain.portBindings.find(
        (b) => b.port === opts.port && b.applicationId === opts.applicationId,
      );
      if (!existing) {
        await this.prisma.domainPortBinding.create({
          data: {
            domainId: opts.domainId,
            applicationId: opts.applicationId,
            port: opts.port,
          },
        });
      }
      return { kind: 'binding' };
    }

    // ── clean-URL path ──────────────────────────────────────────
    if (domain.applicationId && domain.applicationId !== opts.applicationId) {
      if (domain.application?.projectId === opts.projectId) {
        // Same project — replace the incumbent. Caller's app is clearly
        // meant to be the new main app.
        const replacedName = domain.application.name;
        await this.prisma.domain.update({
          where: { id: opts.domainId },
          data: { applicationId: opts.applicationId },
        });
        return { kind: 'main', replaced: replacedName };
      }
      throw new ConflictException(
        `Domain ${domain.domain} is serving "${domain.application?.name}" in another project on :443. Detach it from /dashboard/applications/${domain.applicationId} first.`,
      );
    }

    // Also surface a sane error if the user tries to grab :443 while another
    // app of theirs is port-bound to the same physical port the new app uses —
    // it'd never reach the user since Docker can't bind it twice.
    const portColliding = domain.portBindings.find(
      (b) => b.port === opts.port && b.applicationId !== opts.applicationId,
    );
    if (portColliding) {
      throw new ConflictException(
        `Port ${opts.port} on ${domain.domain} is already taken by "${portColliding.application.name}" (port binding). Pick a different host port for the new app.`,
      );
    }

    if (domain.applicationId !== opts.applicationId) {
      await this.prisma.domain.update({
        where: { id: opts.domainId },
        data: { applicationId: opts.applicationId },
      });
    }
    return { kind: 'main' };
  }

  /**
   * Detach an application from a domain — opposite of attach(). Removes both
   * the clean-URL slot (if held) and every port binding the app has on this
   * domain. Used when the user unlinks a domain from an app.
   */
  async detachAll(applicationId: string, domainId: string): Promise<void> {
    await this.prisma.domain.updateMany({
      where: { id: domainId, applicationId },
      data: { applicationId: null },
    });
    await this.prisma.domainPortBinding.deleteMany({
      where: { domainId, applicationId },
    });
  }
}
