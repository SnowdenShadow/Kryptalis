import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { EmailOnlyDto } from './email-only.dto';
import { ResetPasswordDto } from './reset-password.dto';

const errs = (cls: any, obj: any) =>
  validateSync(plainToInstance(cls, obj), { whitelist: true, forbidNonWhitelisted: true });

describe('EmailOnlyDto', () => {
  it('accepts a valid email', () => {
    expect(errs(EmailOnlyDto, { email: 'user@example.com' })).toHaveLength(0);
  });
  it('rejects a non-email and a missing field', () => {
    expect(errs(EmailOnlyDto, { email: 'not-an-email' }).length).toBeGreaterThan(0);
    expect(errs(EmailOnlyDto, {}).length).toBeGreaterThan(0);
  });
});

describe('ResetPasswordDto', () => {
  it('accepts token + newPassword (+ optional 2FA)', () => {
    expect(errs(ResetPasswordDto, { token: 'a'.repeat(12), newPassword: 'Abcdef123!xyz' })).toHaveLength(0);
    expect(errs(ResetPasswordDto, { token: 'a'.repeat(12), newPassword: 'Abcdef123!xyz', totpCode: '123456' })).toHaveLength(0);
  });
  it('rejects a short/absent token and rejects unknown fields', () => {
    expect(errs(ResetPasswordDto, { token: 'short', newPassword: 'x' }).length).toBeGreaterThan(0);
    expect(errs(ResetPasswordDto, { token: 'a'.repeat(12), newPassword: 'x', evil: 1 }).length).toBeGreaterThan(0);
  });
});
