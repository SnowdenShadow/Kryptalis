import type { NextConfig } from 'next';
import * as path from 'path';

/**
 * Security headers applied to every dashboard response.
 *
 * - Strict-Transport-Security: makes the dashboard HTTPS-only after the
 *   first response (the user has to actually reach the dashboard once).
 *   Caddy already serves HTTPS in front, so this is durable.
 * - Content-Security-Policy is NOT set here: it now carries a per-request
 *   nonce (`script-src 'self' 'nonce-…' 'strict-dynamic'`) and is emitted
 *   by src/middleware.ts — a static header can't hold a fresh nonce.
 * - X-Frame-Options: refuses framing → clickjacking gone.
 * - Referrer-Policy: don't leak the dashboard URL to third parties when
 *   the user clicks an outbound link.
 * - X-Content-Type-Options: stop MIME sniffing on user-uploaded blobs.
 */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
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
