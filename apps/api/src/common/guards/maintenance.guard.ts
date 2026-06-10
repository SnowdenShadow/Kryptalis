import {
  CanActivate,
  ExecutionContext,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { SystemConfigService } from '../../modules/system/system-config.service';

/**
 * Read-only HTTP verbs are never blocked by maintenance mode.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Route prefixes that must keep working during maintenance:
 *  - /api/auth/*      → admins must still be able to log in to turn it off
 *  - /api/health      → uptime probes / load balancers
 *  - /api/agent/*     → remote agents keep reporting
 *  - /api/webhooks/*  → git providers retry budgets are finite
 */
export const MAINTENANCE_EXEMPT_PREFIXES = [
  '/api/auth',
  '/api/health',
  '/api/agent',
  '/api/webhooks',
] as const;

/**
 * Pure decision helper (unit-tested): should this request bypass the
 * maintenance gate regardless of who sent it?
 */
export function isMaintenanceExempt(method: string, path: string): boolean {
  if (SAFE_METHODS.has((method || '').toUpperCase())) return true;
  const clean = (path || '').split('?')[0];
  return MAINTENANCE_EXEMPT_PREFIXES.some(
    (p) => clean === p || clean.startsWith(`${p}/`),
  );
}

/**
 * Global maintenance-mode gate (registered via APP_GUARD in AppModule).
 *
 * When the `maintenance_mode` SystemSetting is truthy, write requests
 * (POST/PATCH/PUT/DELETE) from non-admins get a 503. Reads always pass,
 * the exempt prefixes above always pass, and ADMIN/SUPERADMIN bearer
 * tokens always pass.
 *
 * The flag is cached in process memory and refreshed through
 * SystemConfigService.onChange — zero DB queries on the request path.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate, OnModuleInit, OnModuleDestroy {
  private enabled = false;
  private unsubscribe: (() => void) | null = null;
  // Bare JwtService instance — we only need verify() with an explicit
  // secret, so no JwtModule wiring is required at the AppModule level.
  private readonly jwt = new JwtService({});

  constructor(
    private readonly systemConfig: SystemConfigService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.refresh();
    this.unsubscribe = this.systemConfig.onChange((keys) => {
      if (keys.includes('maintenance_mode')) this.refresh();
    });
  }

  onModuleDestroy() {
    if (this.unsubscribe) this.unsubscribe();
  }

  private refresh() {
    this.enabled = this.systemConfig.getBool('maintenance_mode');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.enabled) return true;
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (isMaintenanceExempt(req.method, req.path ?? req.url)) return true;

    // Admins ride through. The JWT signature is verified with the same
    // secret the passport strategy uses, so a forged role claim is dead
    // on arrival; per-route guards still do full authn/authz after us.
    const auth = req.headers?.authorization;
    if (auth?.startsWith('Bearer ')) {
      try {
        const payload = this.jwt.verify(auth.slice(7), {
          secret: this.config.get<string>('JWT_SECRET')!,
        });
        if (payload?.role === 'ADMIN' || payload?.role === 'SUPERADMIN') {
          return true;
        }
      } catch {
        // fall through to 503 — an invalid token is not an admin.
      }
    }

    throw new ServiceUnavailableException({
      statusCode: 503,
      message:
        'The platform is in maintenance mode. Write operations are temporarily disabled — please try again later.',
      code: 'MAINTENANCE_MODE',
    });
  }
}
