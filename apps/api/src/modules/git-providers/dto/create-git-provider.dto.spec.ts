import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { ValidationPipe, type ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { CreateGitProviderDto } from './create-git-provider.dto';

// Mirror the GLOBAL pipe config from main.ts so this test catches exactly what
// the live API enforces.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const meta: ArgumentMetadata = { type: 'body', metatype: CreateGitProviderDto, data: '' };

describe('CreateGitProviderDto — global ValidationPipe', () => {
  it('accepts a GitHub body with an EMPTY baseUrl (regression: the dashboard always sends baseUrl:"")', async () => {
    // The dashboard git form initializes baseUrl to '' for every provider. With
    // @IsOptional (skips only null/undefined) the '' would still hit @IsUrl and
    // 400 EVERY GitHub/GitLab/Bitbucket connection. @ValidateIf must skip it.
    const body = { provider: 'GITHUB', name: 'work', token: 'ghp_x', baseUrl: '' };
    const out = await pipe.transform(body, meta);
    expect(out).toMatchObject({ provider: 'GITHUB', name: 'work', token: 'ghp_x' });
  });

  it('accepts a body with no baseUrl at all', async () => {
    const body = { provider: 'GITLAB', name: 'gl', token: 'glpat' };
    const out = await pipe.transform(body, meta);
    expect(out).toMatchObject(body);
  });

  it('accepts GITEA with a valid https baseUrl', async () => {
    const body = { provider: 'GITEA', name: 'g', token: 't', baseUrl: 'https://git.acme.com' };
    const out = await pipe.transform(body, meta);
    expect(out).toMatchObject(body);
  });

  it('rejects a NON-empty malformed baseUrl', async () => {
    const body = { provider: 'GITEA', name: 'g', token: 't', baseUrl: 'http s://bad url' };
    await expect(pipe.transform(body, meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-https baseUrl', async () => {
    const body = { provider: 'GITEA', name: 'g', token: 't', baseUrl: 'http://git.acme.com' };
    await expect(pipe.transform(body, meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown provider', async () => {
    const body = { provider: 'SVN', name: 'x', token: 't' };
    await expect(pipe.transform(body, meta)).rejects.toBeInstanceOf(BadRequestException);
  });
});
