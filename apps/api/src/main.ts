// BigInt JSON serialization. Using String() instead of Number() preserves
// precision for counters that can exceed Number.MAX_SAFE_INTEGER (network
// byte counters, very large memory totals on TB-class hosts). The dashboard
// reads these via Number() with an explicit guard.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // The API sits behind the Docker reverse proxy (Caddy) — trust exactly one
  // hop so req.ip resolves to the real client IP from X-Forwarded-For. The
  // ThrottlerGuard keys on req.ip; without this every request would share
  // the proxy's IP and rate limits would apply globally instead of per client.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Express doesn't parse cookies by default. Needed since the refresh
  // token now travels in the httpOnly `dockcontrol_rt` cookie (path-scoped
  // to /api/auth) — auth.controller reads req.cookies on refresh/logout.
  app.use(cookieParser());

  // ── security headers ────────────────────────────────────────────────
  // Helmet sets sane defaults (Content-Type-Options, Frame-Options,
  // Strict-Transport-Security, etc.). We turn off the CSP default because
  // the dashboard is a separate Next.js app — it sets its own CSP.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Body parsing rules:
  //   - /api/files/.../upload           → raw stream (no parser)
  //   - /api/agent/transfers/.../upload → raw stream (no parser)
  //   - /api/webhooks/...               → JSON or form-encoded, raw bytes
  //                                       preserved for HMAC verification
  //   - everything else                 → JSON
  const express = await import('express');
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith('/api/files/') && req.path.endsWith('/upload')) {
      next();
      return;
    }
    if (req.path.startsWith('/api/agent/transfers/') && req.path.endsWith('/upload')) {
      next();
      return;
    }
    // Project-transfer import: the body is a raw encrypted .dctproj stream,
    // not JSON — let the controller pipe it to disk itself.
    if (req.path === '/api/projects/transfer/parse') {
      next();
      return;
    }
    const isWebhook =
      req.path.startsWith('/api/webhooks/') || req.path === '/api/system/updates/webhook';
    // Preserve the EXACT bytes the provider signed so the controller can HMAC
    // them. GitHub can deliver as application/json OR
    // application/x-www-form-urlencoded (payload=<json>); without capturing the
    // raw body for the form variant too, form deliveries would HMAC the wrong
    // bytes and always fail verification.
    const verify = isWebhook
      ? (req2: any, _res2: any, buf: Buffer) => {
          req2.rawBody = Buffer.from(buf);
        }
      : undefined;
    const ct: string = (req.headers['content-type'] || '').toLowerCase();
    if (isWebhook && ct.includes('application/x-www-form-urlencoded')) {
      express.urlencoded({ limit: '10mb', extended: true, verify })(req, res, next);
      return;
    }
    const opts: any = { limit: '10mb' };
    if (verify) opts.verify = verify;
    express.json(opts)(req, res, next);
  });

  app.setGlobalPrefix('api');

  // ── CORS allowlist ──────────────────────────────────────────────────
  // Operators set an explicit allowlist via CORS_ORIGINS (comma-separated
  // origins). When unset we accept the local dev origins AND any
  // origin whose hostname matches the PUBLIC_API_URL host — that's where
  // the dashboard is served from in the default install.
  //
  // CRITICAL: when an origin doesn't match, we MUST NOT throw — Express's
  // CORS middleware bubbles the throw into a 500 on the preflight
  // (browser sees ERR_FAILED). We return `false` instead so the browser
  // gets a normal CORS rejection that surfaces as "blocked by CORS
  // policy" with no Access-Control-Allow-Origin header. The server stays
  // healthy and unauthenticated callers (curl, scripts) work because we
  // allow null/empty origin too.
  const configService = app.get(ConfigService);
  const corsEnv = configService.get<string>('CORS_ORIGINS', '');
  const allowlist = corsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Dev defaults: localhost + 127.0.0.1 (Next dev) on :3000.
  if (allowlist.length === 0) {
    allowlist.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }
  // Derive the host from PUBLIC_API_URL (e.g. http://1.2.3.4:4000) and
  // also accept :3000 / :443 / :80 on that same host for the dashboard.
  const publicApi = configService.get<string>('PUBLIC_API_URL', '');
  try {
    const u = new URL(publicApi);
    const host = u.hostname;
    if (host) {
      for (const p of ['http://' + host + ':3000', 'https://' + host, 'http://' + host]) {
        if (!allowlist.includes(p)) allowlist.push(p);
      }
    }
  } catch {}
  // Because we send credentials (cookies) on CORS requests, a literal '*' in
  // the allowlist is dangerous: the origin callback below would reflect ANY
  // Origin back together with Access-Control-Allow-Credentials:true, i.e. any
  // website could make authenticated requests with the user's session. That is
  // never what an operator wants by default, so we strip '*' from the allowlist
  // unless they explicitly opt into the insecure behavior. (The browser-safe
  // bare-'*' semantics — wildcard WITHOUT credentials — isn't expressible here
  // since credentials are on, so the only safe move is to refuse it.)
  const allowInsecureCors =
    configService.get<string>('ALLOW_INSECURE_CORS', 'false') === 'true';
  const wildcard = allowlist.includes('*');
  if (wildcard && !allowInsecureCors) {
    Logger.warn(
      `[cors] Ignoring '*' in CORS_ORIGINS: a wildcard with credentials would ` +
        `reflect any Origin and expose authenticated sessions. Set an explicit ` +
        `origin list, or ALLOW_INSECURE_CORS=true to override (not recommended).`,
      'Bootstrap',
    );
  }
  const honorWildcard = wildcard && allowInsecureCors;
  const effectiveAllowlist = allowlist.filter((o) => o !== '*');
  Logger.debug(`[cors] allowlist: ${effectiveAllowlist.join(', ')}`, 'Bootstrap');
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
      // No origin → same-origin / curl / native — always allow.
      if (!origin) return cb(null, true);
      if (honorWildcard || effectiveAllowlist.includes(origin)) return cb(null, true);
      // Refuse SILENTLY (no thrown error) — browser surfaces it as a CORS
      // block instead of a 500 preflight.
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter — single 5xx capture point with a correlation id.
  // It preserves 4xx response bodies verbatim (ValidationPipe message[] and
  // fields like `code` the dashboard relies on) and only logs/normalizes 5xx.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Swagger docs — disabled in production by default; opt-in via
  // SWAGGER_PUBLIC=true. The route map is sensitive info, no reason to
  // surface it to anonymous Internet traffic.
  const swaggerPublic = configService.get<string>('SWAGGER_PUBLIC', 'false') === 'true';
  if (process.env.NODE_ENV !== 'production' || swaggerPublic) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('DockControl API')
      .setDescription('The DockControl infrastructure platform API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = configService.get<number>('API_PORT', 4000);
  await app.listen(port);

  // Attach the interactive-terminal WebSocket gateway to the SAME HTTP server
  // (path /ws/terminal) — no extra port. Must run AFTER listen() so the
  // underlying http.Server exists.
  const { TerminalGateway } = await import('./modules/terminal/terminal.gateway');
  app.get(TerminalGateway).bind(app.getHttpServer());
}

bootstrap();
