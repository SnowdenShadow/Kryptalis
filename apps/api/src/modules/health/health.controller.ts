import { Controller, Get } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

/**
 * Liveness probe for Docker / compose / k8s. Never authenticated — it just
 * tells the orchestrator "process is alive enough to answer HTTP". We
 * exempt it from the global throttler so a sick container can't be
 * accidentally starved into restart by the rate limiter answering 429.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  // High limit so a misbehaving prober can't DoS the API,
  // but easily covers the 15 s healthcheck interval.
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Get()
  @ApiOperation({ summary: 'Liveness probe (no auth)' })
  ping() {
    return { ok: true, ts: new Date().toISOString() };
  }
}
