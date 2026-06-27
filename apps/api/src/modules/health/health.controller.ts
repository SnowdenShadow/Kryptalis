import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Liveness + readiness probes for Docker / compose / k8s. Never authenticated.
 * Both are exempt from the global throttler so a sick container can't be
 * accidentally starved into restart by the rate limiter answering 429.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // High limit so a misbehaving prober can't DoS the API,
  // but easily covers the 15 s healthcheck interval.
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Get()
  @ApiOperation({ summary: 'Liveness probe (no auth, no DB)' })
  ping() {
    // LIVENESS: process is alive enough to answer HTTP. Deliberately does NOT
    // touch the database — a transient DB outage must NOT crash-loop the API
    // container (the orchestrator restarts on liveness failure). The compose
    // healthcheck uses THIS endpoint.
    return { ok: true, ts: new Date().toISOString() };
  }

  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (no auth) — verifies the DB is reachable' })
  async ready() {
    // READINESS: "can this instance actually serve requests?" — checks the DB
    // with a trivial `SELECT 1`. A wedged/unreachable DB returns 503 so a load
    // balancer can route away from this instance WITHOUT the orchestrator
    // restarting it (that's liveness's job). Kept separate from `/health` on
    // purpose — see the liveness note above.
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: 'up', ts: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({ ok: false, db: 'down' });
    }
  }
}
