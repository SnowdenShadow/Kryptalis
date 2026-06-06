// BigInt JSON serialization support
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Body parsing rules:
  //   - /api/files/.../upload  → raw stream (no parser)
  //   - /api/webhooks/...      → JSON, but the raw bytes are preserved on req.rawBody
  //                              so HMAC verification can be done over the exact payload
  //                              the provider signed.
  //   - everything else        → JSON
  const express = await import('express');
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith('/api/files/') && req.path.endsWith('/upload')) {
      next();
      return;
    }
    const opts: any = { limit: '10mb' };
    // Preserve raw bytes for any endpoint that needs HMAC verification over
    // the exact payload the provider signed. Both /api/webhooks/* (per-app
    // git push webhooks) and /api/system/updates/webhook (the platform's
    // self-update push hook) use this.
    if (req.path.startsWith('/api/webhooks/') || req.path === '/api/system/updates/webhook') {
      opts.verify = (req2: any, _res2: any, buf: Buffer) => {
        req2.rawBody = Buffer.from(buf);
      };
    }
    express.json(opts)(req, res, next);
  });

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Kryptalis API')
    .setDescription('The Kryptalis infrastructure platform API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('API_PORT', 4000);
  await app.listen(port);
}

bootstrap();
