import {
  Controller,
  Post,
  Param,
  Body,
  Req,
  Headers,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ApplicationsService } from './applications.service';

type RawRequest = Request & { rawBody?: Buffer };

function timingSafeStrEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
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
  ) {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: { project: { select: { userId: true } } },
    });
    if (!app) throw new NotFoundException('Application not found');
    if (!app.webhookSecret) throw new ForbiddenException('Webhooks disabled');
    if (!app.autoDeploy) return { skipped: true, reason: 'autoDeploy disabled' };

    // Decrypt the at-rest HMAC key for in-memory verification. Never logged.
    const secret = this.encryption.decrypt(app.webhookSecret);

    // HMAC the EXACT raw bytes the provider signed — never the re-stringified body.
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));

    let verified = false;
    if (ghSig) {
      const h = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      verified = timingSafeStrEq(`sha256=${h}`, ghSig);
    } else if (glToken) {
      verified = timingSafeStrEq(glToken, secret);
    } else if (bbSig) {
      const h = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      verified = timingSafeStrEq(h, bbSig) || timingSafeStrEq(`sha256=${h}`, bbSig);
    } else if (ghLegacy) {
      const h = crypto.createHmac('sha1', secret).update(raw).digest('hex');
      verified = timingSafeStrEq(`sha1=${h}`, ghLegacy);
    }
    if (!verified) {
      // Note: bbEvent alone is NOT proof of authenticity. We previously accepted it;
      // an attacker could trigger redeploys by posting an empty payload. Always fail-closed.
      throw new ForbiddenException('Invalid signature');
    }

    // Optional branch filter — only redeploy if push targets the configured branch
    const ref: string | undefined = body?.ref;
    if (ref && app.gitBranch && !ref.endsWith(`/${app.gitBranch}`)) {
      return { skipped: true, reason: `branch mismatch (${ref})` };
    }

    // bbEvent kept just to log/skip non-push events
    if (bbEvent && !bbEvent.startsWith('repo:push')) {
      return { skipped: true, reason: `event ${bbEvent}` };
    }

    await this.apps.redeploy(app.project.userId, id);
    return { triggered: true };
  }
}
