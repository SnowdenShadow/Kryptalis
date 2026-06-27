import { Injectable, Logger } from '@nestjs/common';
import { Prisma, AppStatus, Application } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ApplicationRepository — the single write boundary for the `Application`
 * aggregate.
 *
 * Before this existed, `application` rows were created and mutated directly via
 * `prisma.application.{create,update,updateMany,delete}` from five different
 * modules (agent, applications×4 services, marketplace, projects), with ~47
 * ad-hoc `data: { status: ... }` writes scattered across the deploy/ops/
 * marketplace paths. That made the lifecycle invariant (which status
 * transitions are legal, and the side-data that must travel with each) live in
 * no single place.
 *
 * This repository centralizes the command side:
 *  - `create` / `update` / `updateMany` / `deleteById` wrap the Prisma calls so
 *    every write goes through one seam.
 *  - `setStatus` is the lifecycle helper the deploy/ops/marketplace paths use
 *    instead of a bare `update({ data: { status } })`. It logs every transition
 *    (so the status history is greppable in one format) and accepts the extra
 *    columns that legitimately change with a status flip (containerName, port,
 *    phpVersion…).
 *
 * Reads are intentionally NOT funnelled here yet — they carry far less
 * invariant risk than writes, and forcing 20+ read sites through a repository
 * method would be churn for little gain. `findById` is provided for the common
 * case; everything else keeps using Prisma directly for now.
 *
 * Registered @Global (see ApplicationRepositoryModule) so the five writer
 * modules can inject it without each importing ApplicationsModule — mirroring
 * how CryptoService / NotificationsService are shared.
 */
@Injectable()
export class ApplicationRepository {
  private readonly logger = new Logger(ApplicationRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Reads (opt-in convenience; direct Prisma reads still allowed) ──

  findById(id: string): Promise<Application | null> {
    return this.prisma.application.findUnique({ where: { id } });
  }

  // ── Writes (the boundary) ─────────────────────────────────────────

  create(
    data: Prisma.ApplicationCreateInput | Prisma.ApplicationUncheckedCreateInput,
  ): Promise<Application> {
    return this.prisma.application.create({ data });
  }

  /**
   * Generic update escape-hatch. Prefer {@link setStatus} for status flips so
   * the transition is logged consistently; use this for non-status column
   * changes (env, container metadata, git fields, soft fields, …). Accepts both
   * the checked (relation) and unchecked (scalar FK) update shapes, mirroring
   * `prisma.application.update`.
   */
  update(
    id: string,
    data: Prisma.ApplicationUpdateInput | Prisma.ApplicationUncheckedUpdateInput,
  ): Promise<Application> {
    return this.prisma.application.update({ where: { id }, data });
  }

  updateMany(
    where: Prisma.ApplicationWhereInput,
    data: Prisma.ApplicationUpdateManyMutationInput,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.application.updateMany({ where, data });
  }

  deleteById(id: string): Promise<Application> {
    return this.prisma.application.delete({ where: { id } });
  }

  /**
   * Flip an application's status, optionally with the columns that change
   * alongside it (e.g. a DEPLOYING→RUNNING flip that also stamps
   * containerName/containerPort/port, or a PHP_SITE deploy that sets
   * phpVersion). This is the one place the deploy/ops/marketplace lifecycle
   * goes through, so the status history is uniform and auditable.
   *
   * `extra` is a normal ApplicationUpdateInput minus `status` (which this
   * method owns), so callers keep full type-safety on the side columns.
   */
  setStatus(
    id: string,
    status: AppStatus,
    extra?: Omit<Prisma.ApplicationUncheckedUpdateInput, 'status'>,
  ): Promise<Application> {
    this.logger.debug(`app ${id} → ${status}`);
    return this.prisma.application.update({
      where: { id },
      data: { status, ...(extra ?? {}) },
    });
  }
}
