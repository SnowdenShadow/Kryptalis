import { describe, it, expect, vi } from 'vitest';
import {
  newVerificationToken,
  verificationRecord,
  txtContainsToken,
  checkDomainVerification,
  VERIFY_TXT_PREFIX,
} from './domain-verification';

describe('domain-verification (H-3)', () => {
  it('mints a non-empty, unique-ish token', () => {
    const a = newVerificationToken();
    const b = newVerificationToken();
    expect(a.length).toBeGreaterThan(20);
    expect(a).not.toBe(b);
  });

  it('builds the TXT record name/value', () => {
    const r = verificationRecord('example.com', 'TOK');
    expect(r.name).toBe(`${VERIFY_TXT_PREFIX}.example.com`);
    expect(r.value).toBe('dockcontrol-verify=TOK');
  });

  it('txtContainsToken matches the exact value, incl. split TXT chunks', () => {
    expect(txtContainsToken([['dockcontrol-verify=TOK']], 'TOK')).toBe(true);
    expect(txtContainsToken([['dockcontrol-', 'verify=TOK']], 'TOK')).toBe(true);
    expect(txtContainsToken([['dockcontrol-verify=OTHER']], 'TOK')).toBe(false);
    expect(txtContainsToken(null, 'TOK')).toBe(false);
  });

  it('checkDomainVerification finds the token under the prefixed name', async () => {
    const resolver = () => ({
      resolveTxt: vi.fn(async (h: string) =>
        h === `${VERIFY_TXT_PREFIX}.example.com` ? [['dockcontrol-verify=TOK']] : [],
      ),
    });
    expect(await checkDomainVerification('example.com', 'TOK', resolver)).toBe(true);
  });

  it('falls back to the apex TXT record', async () => {
    const resolver = () => ({
      resolveTxt: vi.fn(async (h: string) =>
        h === 'example.com' ? [['dockcontrol-verify=TOK']] : Promise.reject(new Error('NXDOMAIN')),
      ),
    });
    expect(await checkDomainVerification('example.com', 'TOK', resolver)).toBe(true);
  });

  it('returns false when the token is absent / DNS fails', async () => {
    const resolver = () => ({ resolveTxt: vi.fn(async () => { throw new Error('ENOTFOUND'); }) });
    expect(await checkDomainVerification('example.com', 'TOK', resolver)).toBe(false);
  });
});
