import 'reflect-metadata';
import { describe, it, expect } from 'vitest';

import { NotificationsService } from './notifications.service';

/**
 * SSRF screen for outbound alert webhooks. validateWebhookUrl() must reject
 * every loopback/private/link-local/metadata target — including IPv4 smuggled
 * inside an IPv6 literal (the gap a previous pass left open) — and various
 * numeric-IP encodings, while allowing genuine public http(s) URLs.
 */
function makeService(): NotificationsService {
  const config = { get: () => undefined };
  const prisma = {};
  const systemConfig = {
    get: () => undefined,
    getNumber: () => undefined,
    onChange: () => () => {},
  };
  return new NotificationsService(config as any, prisma as any, systemConfig as any);
}

describe('NotificationsService — webhook SSRF screen', () => {
  const svc = makeService();
  const validate = (u: string) => (svc as any).validateWebhookUrl(u) as string | null;

  const blocked = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://127.0.0.1/',
    'http://localhost/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.0.1/',
    'http://0.0.0.0/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f000001/', // hex 127.0.0.1
    'http://[::1]/',
    'http://[::]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    // IPv4 smuggled inside IPv6 — the previously-open bypass.
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:7f00:1]/', // hex spelling of 127.0.0.1
    'http://[64:ff9b::127.0.0.1]/', // NAT64-wrapped loopback
    // Unclassifiable IPv6 literal → default-deny.
    'http://[2001:db8::1]/',
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(validate(url)).not.toBeNull();
    });
  }

  const allowed = [
    'http://example.com/hook',
    'https://hooks.slack.com/services/T000/B000/xxxx',
    'https://discord.com/api/webhooks/123/abc',
    'http://8.8.8.8/notify', // public IPv4 literal
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(validate(url)).toBeNull();
    });
  }

  it('rejects non-http(s) schemes', () => {
    expect(validate('file:///etc/passwd')).not.toBeNull();
    expect(validate('gopher://127.0.0.1/')).not.toBeNull();
  });
});
