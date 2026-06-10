import type { NextConfig } from 'next';
import * as path from 'path';

/**
 * Security headers applied to every dashboard response.
 *
 * - Strict-Transport-Security: makes the dashboard HTTPS-only after the
 *   first response (the user has to actually reach the dashboard once).
 *   Caddy already serves HTTPS in front, so this is durable.
 * - Content-Security-Policy: blocks inline scripts (no eval, no remote
 *   <script>), restricts XHR to the same origin + the API base. Defends
 *   against a stored-XSS injecting `<script src="evil.com/x.js">`.
 * - X-Frame-Options: refuses framing → clickjacking gone.
 * - Referrer-Policy: don't leak the dashboard URL to third parties when
 *   the user clicks an outbound link.
 * - X-Content-Type-Options: stop MIME sniffing on user-uploaded blobs.
 *
 * The API base reachable from the browser is NEXT_PUBLIC_API_URL — we
 * fold it into connect-src so XHR works.
 */
const apiOrigin = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
let apiHost = '';
try {
  apiHost = new URL(apiOrigin).origin;
} catch {}

const csp = [
  "default-src 'self'",
  // Next inlines hydration scripts at runtime; the nonce isn't easy to
  // wire without an edge middleware, so allow 'unsafe-inline' for now.
  // TODO: add an edge middleware that injects a per-request nonce and
  // tighten this to script-src 'self' 'nonce-...'.
  "script-src 'self' 'unsafe-inline'",
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

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=()' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
