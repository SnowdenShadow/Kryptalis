import * as dns from 'dns';

/**
 * Shared SSRF screen for every server-side fetch whose host comes (even
 * partly) from user input: notification/monitoring webhooks, the S3 backup
 * endpoint, and the one-shot git PAT clone host. Previously each module had its
 * own screen of varying quality — the webhook one was strong (IPv4
 * decimal/octal normalization via WHATWG URL, embedded-IPv4-in-IPv6, DNS
 * re-resolution), the S3 one was absent, and the git PAT one was weaker
 * (no DNS re-resolution, partial IPv6). This is the single source of truth.
 *
 * Two layers, both needed:
 *   1. screenUrlLiteral()  — synchronous, screens the URL string itself
 *      (scheme + any IP literal, including IPv4 smuggled inside IPv6).
 *   2. screenResolvedHost() — async, resolves a hostname at dispatch and runs
 *      every A/AAAA back through layer 1. Closes the DNS-rebinding hole where a
 *      public name resolves (or is rebound) to a private address between
 *      validation and connection.
 *
 * Pure functions (no Nest deps) so they unit-test in isolation and can't drift
 * between call sites.
 */

export interface SsrfScreenOptions {
  /** Allowed URL schemes (lowercased, with trailing colon). Default http/https. */
  allowedSchemes?: string[];
}

const DEFAULT_SCHEMES = ['http:', 'https:'];

/**
 * Screen a URL STRING. Returns a human-readable violation, or null when the
 * literal is allowed. Does NOT resolve DNS — pair with screenResolvedHost for
 * hostnames.
 */
export function screenUrlLiteral(raw: string, opts: SsrfScreenOptions = {}): string | null {
  const allowed = opts.allowedSchemes ?? DEFAULT_SCHEMES;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (!allowed.includes(url.protocol)) {
    return `unsupported scheme "${url.protocol}" (allowed: ${allowed.join(', ')})`;
  }
  // WHATWG URL already normalizes decimal/octal/hex IPv4 forms
  // (http://2130706433, http://0x7f.1, …) to dotted-quad in url.hostname, so
  // the range checks below see the canonical form.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'loopback host is not allowed';
  }
  // IPv4 literal → block loopback/private/link-local/this-host ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8 private
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
      (a === 192 && b === 168) || // 192.168.0.0/16 private
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local incl. 169.254.169.254 metadata
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
      a === 0 // 0.0.0.0/8 "this host"
    ) {
      return `private/loopback/link-local address ${host} is not allowed`;
    }
    return null;
  }
  // IPv6 literal → default-DENY, allowing only clearly-public addresses. An
  // IPv4 can be smuggled inside IPv6 (::ffff:127.0.0.1 mapped, ::a.b.c.d compat,
  // 64:ff9b::a.b.c.d NAT64), so extract any embedded IPv4 and re-screen it.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return 'loopback address is not allowed';
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'unique-local address (fc00::/7) is not allowed';
    if (/^fe[89ab][0-9a-f]:/.test(host)) return 'link-local address (fe80::/10) is not allowed';
    const embeddedV4 = extractEmbeddedV4(host);
    if (embeddedV4) {
      const v4err = screenUrlLiteral(`http://${embeddedV4}`, opts);
      if (v4err) return `embedded IPv4 ${embeddedV4}: ${v4err}`;
      return null;
    }
    return 'IPv6 literal hosts are not allowed';
  }
  return null;
}

/**
 * Resolve a hostname and run EVERY returned address through screenUrlLiteral.
 * Returns a violation string, or null when every resolved address is public (or
 * the host was itself an IP literal already screened). Closes DNS rebinding.
 */
export async function screenResolvedHost(raw: string, _opts: SsrfScreenOptions = {}): Promise<string | null> {
  let url: URL;
  try { url = new URL(raw); } catch { return 'not a valid URL'; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // IP literals were already fully screened by screenUrlLiteral().
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    // Unresolvable — let the real fetch fail naturally rather than guess.
    return null;
  }
  for (const { address } of addrs) {
    // Re-screen the resolved ADDRESS for private/loopback ranges only. We wrap
    // it in a fixed http:// literal purely to reuse screenUrlLiteral's range
    // logic, so we must NOT forward the caller's allowedSchemes here (the
    // original URL's scheme was already validated by screenUrlLiteral); doing
    // so would falsely reject every address under an https-only policy.
    const v = screenUrlLiteral(`http://${address.includes(':') ? `[${address}]` : address}`);
    if (v) return `resolves to ${address}: ${v}`;
  }
  return null;
}

/**
 * Full screen: literal first, then DNS re-resolution. Returns a violation
 * string or null. Convenience wrapper for call sites that want both layers.
 */
export async function screenSsrf(raw: string, opts: SsrfScreenOptions = {}): Promise<string | null> {
  const literal = screenUrlLiteral(raw, opts);
  if (literal) return literal;
  return screenResolvedHost(raw, opts);
}

/**
 * Extract a dotted-quad IPv4 embedded in an IPv6 literal — IPv4-mapped
 * (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), and NAT64 (64:ff9b::a.b.c.d),
 * including the all-hex spelling of the last 32 bits (::ffff:7f00:0001).
 * Returns the dotted string, or null when there's no embedded IPv4.
 */
export function extractEmbeddedV4(host: string): string | null {
  const dotted = host.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) return dotted[1];
  const mapped = host.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const compat = host.match(/^(?:0{0,4}:){1,6}([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const hx = mapped || compat;
  if (hx) {
    const hi = parseInt(hx[1], 16);
    const lo = parseInt(hx[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}
