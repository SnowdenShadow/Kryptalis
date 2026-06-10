import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Edge middleware — per-request CSP nonce.
 *
 * Replaces the static Content-Security-Policy that used to live in
 * next.config.ts (which needed `script-src 'unsafe-inline'` because Next
 * inlines hydration scripts). Here we mint a fresh nonce on every request,
 * forward it to the React tree via the `x-nonce` request header (official
 * Next.js pattern — Next picks the nonce up from the CSP request header
 * and stamps it on its own inline scripts), and set the response CSP to
 * `script-src 'self' 'nonce-…' 'strict-dynamic'`. A stored XSS can no
 * longer execute: injected inline <script> lacks the nonce, and remote
 * src= is blocked.
 *
 * Auth tokens: the access token lives in localStorage so route protection
 * stays client-side ((dashboard)/layout.tsx) + API JWT guards. The refresh
 * token is an httpOnly cookie scoped to the API's /api/auth path, so it is
 * never visible here either.
 *
 * The non-CSP security headers (HSTS, X-Frame-Options, …) are still set
 * statically in next.config.ts.
 */

// Same connect-src derivation as next.config.ts used: the browser-reachable
// API origin plus its ws(s) twin for live log/metric streams.
const apiOrigin = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
let apiHost = '';
try {
  apiHost = new URL(apiOrigin).origin;
} catch {}

export function middleware(request: NextRequest) {
  // randomUUID is available in the edge runtime; base64-encode to get a
  // CSP-grammar-safe nonce value.
  const nonce = btoa(crypto.randomUUID());

  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonce'd Next bootstrap scripts load the
    // chunks they create; everything without the nonce is dead on arrival.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // ws/wss restricted to the API host — a bare `ws: wss:` allowed an XSS
    // to open WebSockets to ANY host (silent exfiltration channel).
    `connect-src 'self' ${apiHost}${apiHost ? ` ${apiHost.replace(/^http/, 'ws')}` : ' ws: wss:'}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');

  // Forward both headers on the REQUEST so Next's renderer sees them:
  // it reads the nonce out of the CSP header and applies it to the inline
  // scripts it emits; `x-nonce` lets app code read it via headers().
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
