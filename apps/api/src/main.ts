// BigInt JSON serialization. Using String() instead of Number() preserves
// precision for counters that can exceed Number.MAX_SAFE_INTEGER (network
// byte counters, very large memory totals on TB-class hosts). The dashboard
// reads these via Number() with an explicit guard.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // ── security headers ────────────────────────────────────────────────
  // Helmet sets sane defaults (Content-Type-Options, Frame-Options,
  // Strict-Transport-Security, etc.). We turn off the CSP default because
  // the dashboard is a separate Next.js app — it sets its own CSP.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Body parsing rules:
  //   - /api/files/.../upload  → raw stream (no parser)
  //   - /api/webhooks/...      → JSON, but raw bytes preserved for HMAC
  //   - everything else        → JSON
  const express = await import('express');
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith('/api/files/') && req.path.endsWith('/upload')) {
      next();
      return;
    }
    const opts: any = { limit: '10mb' };
    if (req.path.startsWith('/api/webhooks/') || req.path === '/api/system/updates/webhook') {
      opts.verify = (req2: any, _res2: any, buf: Buffer) => {
        req2.rawBody = Buffer.from(buf);
      };
    }
    express.json(opts)(req, res, next);
  });

  app.setGlobalPrefix('api');

  // ── CORS allowlist ──────────────────────────────────────────────────
  // Refuses arbitrary origins so a malicious page cannot send authenticated
  // XHR from the user's browser. Operators can extend via CORS_ORIGINS as
  // a comma-separated list (e.g. `https://dash.athexis.xyz,https://localhost:3000`).
  const configService = app.get(ConfigService);
  const corsEnv = configService.get<string>('CORS_ORIGINS', '');
  const allowlist = corsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Dev defaults: localhost:3000 (Next dev), 127.0.0.1:3000.
  if (allowlist.length === 0) {
    allowlist.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
      // No origin → same-origin / curl / native — allow.
      if (!origin) return cb(null, true);
      if (allowlist.includes(origin) || allowlist.includes('*')) return cb(null, true);
      return cb(new Error(`Origin ${origin} not in CORS allowlist`), false);
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

  // Swagger docs — disabled in production by default; opt-in via
  // SWAGGER_PUBLIC=true. The route map is sensitive info, no reason to
  // surface it to anonymous Internet traffic.
  const swaggerPublic = configService.get<string>('SWAGGER_PUBLIC', 'false') === 'true';
  if (process.env.NODE_ENV !== 'production' || swaggerPublic) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Kryptalis API')
      .setDescription('The Kryptalis infrastructure platform API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = configService.get<number>('API_PORT', 4000);
  await app.listen(port);
}

bootstrap();
