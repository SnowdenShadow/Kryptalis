import {
  Controller,
  Post,
  Param,
  Body,
  Req,
  Headers,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ApplicationsService } from './applications.service';

type RawRequest = Request & { rawBody?: Buffer };

export function timingSafeStrEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Normalize a git ref / branch field to a bare branch name.
//   refs/heads/main → main, refs/tags/v1 → undefined (not a branch), main → main
export function refToBranch(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/tags/')) return undefined; // a tag, not a branch
  if (ref.startsWith('refs/')) return undefined; // other ref namespaces
  return ref;
}

// Extract the pushed branch per provider:
//   - GitHub / GitLab: top-level body.ref = refs/heads/<branch>
//   - Bitbucket:       body.push.changes[].new.name where new.type === 'branch'
// Returns the first branch found, or undefined when none (e.g. tag push).
export function extractPushBranch(body: any): string | undefined {
  const fromRef = refToBranch(body?.ref);
  if (fromRef) return fromRef;
  const changes = body?.push?.changes;
  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (c?.new?.type === 'branch' && typeof c.new.name === 'string') {
        return c.new.name;
      }
    }
  }
  return undefined;
}

// ── Replay protection (in-memory, no DB) ───────────────────────────────
// A provider delivery id is unique per delivery; replaying the same id is a
// replay attack. We remember seen ids for a short TTL and reject repeats.
// Bounded, self-pruning Map keyed deliveryId → expiry (epoch ms). Best-effort
// only (lost on restart / not shared across instances) but enough to blunt
// naive replays without a migration.
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const seenDeliveries = new Map<string, number>();

function pruneDeliveries(now: number): void {
  for (const [k, exp] of seenDeliveries) {
    if (exp <= now) seenDeliveries.delete(k);
  }
}

// Returns true if this delivery id was already seen (a replay). Records it
// otherwise. Caller scopes the id by app to avoid cross-app collisions.
export function isReplay(deliveryId: string | undefined): boolean {
  if (!deliveryId) return false; // no header → can't dedup, don't break delivery
  const now = Date.now();
  pruneDeliveries(now);
  const exp = seenDeliveries.get(deliveryId);
  if (exp && exp > now) return true;
  seenDeliveries.set(deliveryId, now + DEDUP_TTL_MS);
  return false;
}

@ApiTags('Webhooks')
@Controller('webhooks/applications')
export class ApplicationWebhooksController {
  constructor(
    private prisma: PrismaService,
    private apps: ApplicationsService,
    private encryption: EncryptionService,
  ) {}

  @Post(':id')
  @ApiOperation({ summary: 'Git push webhook — auto-redeploy' })
  async receive(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: RawRequest,
    @Headers('x-hub-signature-256') ghSig?: string,
    @Headers('x-gitlab-token') glToken?: string,
    @Headers('x-event-key') bbEvent?: string,
    @Headers('x-hub-signature') ghLegacy?: string,
    @Headers('x-bitbucket-signature') bbSig?: string,
    @Headers('x-github-delivery') ghDelivery?: string,
    @Headers('x-gitlab-event-uuid') glDelivery?: string,
    @Headers('x-request-uuid') bbDelivery?: string,
  ) {
    // ── Signature verification FIRST (fail-closed, no existence oracle) ──
    // We must not reveal whether the app exists or how it's configured to an
    // unauthenticated caller. Both "no such app / no secret" and "bad
    // signature" return an identical ForbiddenException so existence can't be
    // probed via the response (NotFound vs Forbidden vs skipped). The
    // autoDeploy-disabled skip is intentionally deferred until AFTER the
    // signature checks out so it can't be used as an oracle either.
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: { project: { select: { userId: true } } },
    });

    let verified = false;
    if (app?.webhookSecret) {
      // Decrypt the at-rest HMAC key for in-memory verification. Never logged.
      const secret = this.encryption.decrypt(app.webhookSecret);

      // HMAC the EXACT raw bytes the provider signed — never the re-stringified body.
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));

      if (ghSig) {
        const h = crypto.createHmac('sha256', secret).update(raw).digest('hex');
        verified = timingSafeStrEq(`sha256=${h}`, ghSig);
      } else if (glToken) {
        // NOTE: GitLab sends a shared plaintext token (X-Gitlab-Token), not an
        // HMAC over the body — so this only proves the token, not payload
        // integrity. A MITM with the token could tamper the body. This is a
        // known GitLab design limit; deeper mitigation (e.g. requiring a
        // signed proxy / IP allowlist on the webhook origin host) is deferred.
        verified = timingSafeStrEq(glToken, secret);
      } else if (bbSig) {
        const h = crypto.createHmac('sha256', secret).update(raw).digest('hex');
        verified = timingSafeStrEq(h, bbSig) || timingSafeStrEq(`sha256=${h}`, bbSig);
      } else if (ghLegacy) {
        const h = crypto.createHmac('sha1', secret).update(raw).digest('hex');
        verified = timingSafeStrEq(`sha1=${h}`, ghLegacy);
      }
    }

    if (!verified) {
      // Uniform response for "no app", "webhooks disabled", and "bad
      // signature". bbEvent alone is NOT proof of authenticity — an attacker
      // could otherwise trigger redeploys by posting an empty payload. Always
      // fail-closed.
      throw new ForbiddenException('Invalid signature');
    }

    // app is guaranteed non-null here (verified ⇒ app?.webhookSecret was truthy).

    // ── Replay protection ──────────────────────────────────────────────
    // Scope the provider delivery id by app so two apps can't collide.
    const deliveryHeader = ghDelivery ?? glDelivery ?? bbDelivery;
    if (deliveryHeader && isReplay(`${id}:${deliveryHeader}`)) {
      return { skipped: true, reason: 'duplicate delivery' };
    }

    // autoDeploy skip only AFTER signature verification (not an oracle).
    if (!app!.autoDeploy) return { skipped: true, reason: 'autoDeploy disabled' };

    // Optional branch filter — only redeploy if push targets the configured
    // branch. Extract the branch per-provider (GitHub/GitLab from refs/heads,
    // Bitbucket from push.changes[].new.name). Compare the EXACT branch name so
    // a tag push (refs/tags/main) does NOT match branch 'main'.
    if (app!.gitBranch) {
      const branch = extractPushBranch(body);
      if (branch !== app!.gitBranch) {
        return { skipped: true, reason: `branch mismatch (${branch ?? 'none'})` };
      }
    }

    // bbEvent kept just to log/skip non-push events
    if (bbEvent && !bbEvent.startsWith('repo:push')) {
      return { skipped: true, reason: `event ${bbEvent}` };
    }

    // A push that lands WHILE a deploy is already running is a benign no-op,
    // not a delivery failure. redeploy() throws ConflictException (409) in that
    // case; if we let it propagate, the git provider records the webhook
    // delivery as FAILED and burns its finite retry budget re-sending the same
    // push. Swallow it into a `skipped` 200 instead — the running deploy will
    // already build whatever was pushed (or the next push re-triggers).
    try {
      await this.apps.redeploy(app!.project.userId, id);
    } catch (err) {
      if (err instanceof ConflictException) {
        return { skipped: true, reason: 'deploy already in progress' };
      }
      throw err;
    }
    return { triggered: true };
  }
}
