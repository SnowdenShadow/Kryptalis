import type { CookieOptions, Request } from 'express';

/**
 * Refresh-token cookie plumbing, extracted as pure helpers so the policy
 * (flags, name, extraction precedence) is unit-testable without spinning
 * up Nest.
 *
 * The cookie is the PRIMARY refresh-token channel for the dashboard:
 * httpOnly so an XSS can't read it, path-scoped to /api/auth so it only
 * travels to the auth endpoints, SameSite=Strict (the refresh/logout
 * endpoints are POSTs the dashboard issues same-site, never a cross-site
 * navigation — Strict gives the tightest CSRF posture and Lax bought us
 * nothing here). The JSON body keeps echoing the refresh token for older
 * clients — the dashboard simply no longer stores it.
 */
export const REFRESH_COOKIE_NAME = 'dockcontrol_rt';

/** Default aligned with JWT_REFRESH_EXPIRATION's default of 7d. */
export const DEFAULT_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cookie options for the refresh-token cookie.
 *
 * `secure` follows the caller-provided `isHttps` instead of being
 * hard-coded true: a fresh install is reached over plain HTTP before the
 * operator wires TLS, and a Secure cookie would silently never be stored
 * there (refresh loop → permanent logout every 15 min).
 */
export function refreshCookieOptions(
  isHttps: boolean,
  maxAgeMs: number = DEFAULT_REFRESH_TTL_MS,
): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    // Scoped to the auth endpoints only — the cookie never rides along on
    // ordinary API traffic, shrinking both CSRF surface and header bytes.
    path: '/api/auth',
    secure: isHttps,
    maxAge: maxAgeMs,
  };
}

/**
 * Whether the refresh cookie should be marked Secure for this request.
 * True when the request itself arrived over https (direct TLS or via a
 * trusting proxy setting req.secure), OR when PUBLIC_API_URL declares the
 * install is served over https (TLS terminated upstream).
 */
export function isSecureContext(req: Pick<Request, 'secure' | 'protocol'>, publicApiUrl?: string): boolean {
  if (req.secure || req.protocol === 'https') return true;
  return !!publicApiUrl && publicApiUrl.trim().toLowerCase().startsWith('https');
}

/**
 * Parse a JWT-style TTL string ("7d", "15m", …) to milliseconds. Mirrors
 * AuthService.parseTtl so the cookie maxAge stays aligned with the
 * refresh JWT's exp. Falls back to 7 days on anything unparseable.
 */
export function parseTtlMs(ttl: string | undefined): number {
  const m = (ttl || '').match(/^(\d+)([smhdw])$/);
  if (!m) return DEFAULT_REFRESH_TTL_MS;
  const n = parseInt(m[1], 10);
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return n * (multipliers[m[2]] || 24 * 3600 * 1000);
}

/**
 * Refresh-token extraction precedence: httpOnly cookie FIRST (the new,
 * XSS-proof channel), then the JSON body (legacy clients that still hold
 * the token in localStorage). Empty strings are treated as absent.
 */
export function extractRefreshToken(
  cookieToken: string | undefined | null,
  bodyToken: string | undefined | null,
): string | undefined {
  if (typeof cookieToken === 'string' && cookieToken.length > 0) return cookieToken;
  if (typeof bodyToken === 'string' && bodyToken.length > 0) return bodyToken;
  return undefined;
}
