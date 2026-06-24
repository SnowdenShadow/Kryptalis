import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { CreateApplicationDto } from './create-application.dto';

// Mirror the GLOBAL pipe config from main.ts so this test catches exactly what
// the live API enforces.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const meta: ArgumentMetadata = { type: 'body', metatype: CreateApplicationDto, data: '' };

describe('CreateApplicationDto — global ValidationPipe', () => {
  it('accepts a PHP_SITE body and does NOT reject the internal undecorated fields', async () => {
    // Regression: under target ES2022 (useDefineForClassFields) a plain
    // `restoreVolumes?: …` field declaration emitted a real own-property set to
    // undefined, which forbidNonWhitelisted then rejected on EVERY create with
    // "property restoreVolumes should not exist" — even though the client never
    // sent it. The fix is `declare` (type-only, no emit). This is the exact
    // payload the dashboard PHP-site form sends.
    const body = { name: 'Test', projectId: 'cmqsnaosn0007oi013kvrw2zx', framework: 'PHP_SITE', phpVersion: '8.3' };
    const out = await pipe.transform(body, meta);
    expect(out).toMatchObject(body);
    // The internal fields must be genuinely absent, not present-as-undefined.
    expect(Object.prototype.hasOwnProperty.call(out, 'restoreVolumes')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'loadImages')).toBe(false);
  });

  it('still rejects a genuinely unknown property (whitelist intact)', async () => {
    const body: any = { name: 'X', projectId: 'p1', framework: 'DOCKER', bogusField: 1 };
    await expect(pipe.transform(body, meta)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an unsupported phpVersion', async () => {
    const body: any = { name: 'X', projectId: 'p1', framework: 'PHP_SITE', phpVersion: '5.6' };
    await expect(pipe.transform(body, meta)).rejects.toMatchObject({ status: 400 });
  });

  it('accepts a plain Docker app with no phpVersion', async () => {
    const body = { name: 'svc', projectId: 'p1', framework: 'DOCKER', dockerImage: 'nginx:1.27' };
    const out = await pipe.transform(body, meta);
    expect(out).toMatchObject(body);
  });
});
