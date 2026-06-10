import { describe, it, expect } from 'vitest';
import {
  REFRESH_COOKIE_NAME,
  DEFAULT_REFRESH_TTL_MS,
  refreshCookieOptions,
  extractRefreshToken,
  isSecureContext,
  parseTtlMs,
} from './auth-cookie';

describe('refreshCookieOptions', () => {
  it('is httpOnly, lax, scoped to /api/auth', () => {
    const opts = refreshCookieOptions(false);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/api/auth');
  });

  it('secure follows isHttps', () => {
    expect(refreshCookieOptions(true).secure).toBe(true);
    expect(refreshCookieOptions(false).secure).toBe(false);
  });

  it('defaults maxAge to 7 days and honours an explicit TTL', () => {
    expect(refreshCookieOptions(false).maxAge).toBe(DEFAULT_REFRESH_TTL_MS);
    expect(DEFAULT_REFRESH_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(refreshCookieOptions(false, 1234).maxAge).toBe(1234);
  });

  it('exposes the expected cookie name', () => {
    expect(REFRESH_COOKIE_NAME).toBe('kryptalis_rt');
  });
});

describe('extractRefreshToken', () => {
  it('prefers the cookie over the body', () => {
    expect(extractRefreshToken('cookie-token', 'body-token')).toBe('cookie-token');
  });

  it('falls back to the body when no cookie', () => {
    expect(extractRefreshToken(undefined, 'body-token')).toBe('body-token');
    expect(extractRefreshToken(null, 'body-token')).toBe('body-token');
  });

  it('treats empty strings as absent', () => {
    expect(extractRefreshToken('', 'body-token')).toBe('body-token');
    expect(extractRefreshToken('', '')).toBeUndefined();
  });

  it('returns undefined when neither channel has a token', () => {
    expect(extractRefreshToken(undefined, undefined)).toBeUndefined();
  });
});

describe('isSecureContext', () => {
  const httpReq = { secure: false, protocol: 'http' } as any;
  const httpsReq = { secure: true, protocol: 'https' } as any;

  it('true when the request itself is https', () => {
    expect(isSecureContext(httpsReq, '')).toBe(true);
    expect(isSecureContext({ secure: false, protocol: 'https' } as any, '')).toBe(true);
  });

  it('true when PUBLIC_API_URL is https even on a plain-http hop', () => {
    expect(isSecureContext(httpReq, 'https://panel.example.com')).toBe(true);
  });

  it('false for fresh http installs (no TLS anywhere)', () => {
    expect(isSecureContext(httpReq, 'http://1.2.3.4:4000')).toBe(false);
    expect(isSecureContext(httpReq, '')).toBe(false);
    expect(isSecureContext(httpReq, undefined)).toBe(false);
  });
});

describe('parseTtlMs', () => {
  it('parses the JWT-style units', () => {
    expect(parseTtlMs('30s')).toBe(30_000);
    expect(parseTtlMs('15m')).toBe(15 * 60_000);
    expect(parseTtlMs('12h')).toBe(12 * 3_600_000);
    expect(parseTtlMs('7d')).toBe(7 * 24 * 3_600_000);
    expect(parseTtlMs('2w')).toBe(14 * 24 * 3_600_000);
  });

  it('falls back to 7 days on garbage', () => {
    expect(parseTtlMs('')).toBe(DEFAULT_REFRESH_TTL_MS);
    expect(parseTtlMs(undefined)).toBe(DEFAULT_REFRESH_TTL_MS);
    expect(parseTtlMs('7days')).toBe(DEFAULT_REFRESH_TTL_MS);
  });
});
