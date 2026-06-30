import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { InstallAppDto } from './install-app.dto';

/**
 * M-2: marketplace install env-var KEYS must be validated. A key with a newline
 * could inject extra lines into the generated .env. The DTO now applies the
 * same SafeEnvVarsConstraint the custom-image install uses.
 */
function validateDto(obj: any) {
  const dto = plainToInstance(InstallAppDto, obj);
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('InstallAppDto.envVars key validation (M-2)', () => {
  const base = { appSlug: 'wordpress', projectId: 'p1' };

  it('accepts normal shell-style env keys', () => {
    expect(validateDto({ ...base, envVars: { WORDPRESS_DB_PASSWORD: 'x', FOO_BAR: '1' } })).toHaveLength(0);
  });

  it('rejects a key containing a newline (.env line injection)', () => {
    const errs = validateDto({ ...base, envVars: { 'X\nPRIVILEGED': 'true' } });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a key with an = or space', () => {
    expect(validateDto({ ...base, envVars: { 'A=B': 'x' } }).length).toBeGreaterThan(0);
    expect(validateDto({ ...base, envVars: { 'A B': 'x' } }).length).toBeGreaterThan(0);
  });

  it('accepts an install with no envVars', () => {
    expect(validateDto({ ...base })).toHaveLength(0);
  });
});
