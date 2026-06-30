import { describe, it, expect } from 'vitest';
import { screenUrlLiteral, extractEmbeddedV4 } from './ssrf-guard';

describe('screenUrlLiteral', () => {
  it('allows a normal public https URL', () => {
    expect(screenUrlLiteral('https://example.com/x')).toBeNull();
    expect(screenUrlLiteral('https://203.0.113.10:9000')).toBeNull();
  });

  it('rejects an unsupported scheme', () => {
    expect(screenUrlLiteral('ftp://example.com')).toMatch(/scheme/i);
    expect(screenUrlLiteral('file:///etc/passwd')).toMatch(/scheme/i);
  });

  it('honours a custom allowedSchemes list', () => {
    expect(screenUrlLiteral('http://example.com', { allowedSchemes: ['https:'] })).toMatch(/scheme/i);
    expect(screenUrlLiteral('https://example.com', { allowedSchemes: ['https:'] })).toBeNull();
  });

  it('blocks localhost and *.localhost', () => {
    expect(screenUrlLiteral('http://localhost/x')).toMatch(/loopback/i);
    expect(screenUrlLiteral('http://foo.localhost/x')).toMatch(/loopback/i);
  });

  it('blocks IPv4 loopback / private / link-local / metadata / CGNAT / 0.0.0.0', () => {
    for (const h of [
      '127.0.0.1', '127.5.5.5', '10.0.0.1', '172.16.9.9', '172.31.0.1',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    ]) {
      expect(screenUrlLiteral(`http://${h}/`), h).toMatch(/not allowed/i);
    }
  });

  it('normalizes decimal/octal/hex IPv4 (WHATWG URL) and still blocks them', () => {
    // 2130706433 === 127.0.0.1, 0x7f000001 === 127.0.0.1
    expect(screenUrlLiteral('http://2130706433/')).toMatch(/not allowed/i);
    expect(screenUrlLiteral('http://0x7f000001/')).toMatch(/not allowed/i);
  });

  it('blocks IPv6 loopback / ULA / link-local', () => {
    expect(screenUrlLiteral('http://[::1]/')).toMatch(/loopback/i);
    expect(screenUrlLiteral('http://[fc00::1]/')).toMatch(/unique-local/i);
    expect(screenUrlLiteral('http://[fe80::1]/')).toMatch(/link-local/i);
  });

  it('blocks IPv4 smuggled inside IPv6 (mapped/compat/NAT64)', () => {
    expect(screenUrlLiteral('http://[::ffff:127.0.0.1]/')).toMatch(/127\.0\.0\.1|not allowed/i);
    expect(screenUrlLiteral('http://[64:ff9b::10.0.0.1]/')).toMatch(/10\.0\.0\.1|not allowed/i);
  });

  it('default-denies an unclassifiable IPv6 literal', () => {
    expect(screenUrlLiteral('http://[2001:db8::1]/')).toMatch(/IPv6 literal/i);
  });

  it('returns a violation for a non-URL', () => {
    expect(screenUrlLiteral('not a url')).toMatch(/valid URL/i);
  });
});

describe('extractEmbeddedV4', () => {
  it('pulls the dotted tail from mapped/NAT64 forms', () => {
    expect(extractEmbeddedV4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(extractEmbeddedV4('64:ff9b::10.0.0.1')).toBe('10.0.0.1');
  });
  it('decodes the all-hex mapped tail', () => {
    expect(extractEmbeddedV4('::ffff:7f00:1')).toBe('127.0.0.1');
  });
  it('returns null when there is no embedded IPv4', () => {
    expect(extractEmbeddedV4('2001:db8::1')).toBeNull();
  });
});
