import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STATUS_VARIANT,
  STATUS_COLOR,
  FRAMEWORK_LABELS,
  HTTPS_PORTS,
  makeTimeAgo,
  appUrl,
  publicUrls,
  publicAppUrl,
} from './app-format';

describe('app-format constants', () => {
  it('every STATUS_COLOR status also has a STATUS_VARIANT', () => {
    const missing = Object.keys(STATUS_COLOR).filter((s) => !(s in STATUS_VARIANT));
    expect(missing).toEqual([]);
  });

  it('framework labels are non-empty', () => {
    for (const label of Object.values(FRAMEWORK_LABELS)) {
      expect(label.trim()).not.toBe('');
    }
  });
});

describe('makeTimeAgo', () => {
  // echo t: returns key plus interpolated vars, so assertions stay readable
  const t = vi.fn((k: string, v?: Record<string, string | number>) =>
    v ? `${k}:${Object.values(v).join(',')}` : k,
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
    t.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const timeAgo = () => makeTimeAgo(t);

  it('returns em dash for null without a never key', () => {
    expect(timeAgo()(null)).toBe('—');
  });

  it('uses the custom never key for null when provided', () => {
    const f = makeTimeAgo(t, {
      just: 'x.just',
      min: 'x.min',
      hour: 'x.hour',
      day: 'x.day',
      never: 'x.never',
    });
    expect(f(null)).toBe('x.never');
  });

  it('returns "just now" under 60s', () => {
    expect(timeAgo()('2026-06-10T11:59:30Z')).toBe('apps.timeJust');
  });

  it('returns minutes under an hour', () => {
    expect(timeAgo()('2026-06-10T11:15:00Z')).toBe('apps.timeMin:45');
  });

  it('returns hours under a day', () => {
    expect(timeAgo()('2026-06-10T09:00:00Z')).toBe('apps.timeHour:3');
  });

  it('returns days at 24h and beyond', () => {
    expect(timeAgo()('2026-06-07T12:00:00Z')).toBe('apps.timeDay:3');
  });

  it('boundary: exactly 60s is minutes, exactly 3600s is hours', () => {
    expect(timeAgo()('2026-06-10T11:59:00Z')).toBe('apps.timeMin:1');
    expect(timeAgo()('2026-06-10T11:00:00Z')).toBe('apps.timeHour:1');
  });
});

describe('appUrl', () => {
  it('uses https for well-known TLS ports', () => {
    for (const port of HTTPS_PORTS) {
      expect(appUrl(port, 'example.com')).toBe(`https://example.com:${port}`);
    }
  });

  it('uses http otherwise', () => {
    expect(appUrl(3000, 'example.com')).toBe('http://example.com:3000');
  });

  it('falls back to localhost without window or explicit hostname', () => {
    expect(appUrl(8080)).toBe('http://localhost:8080');
  });
});

describe('publicUrls / publicAppUrl', () => {
  it('clean-URL domain → https without port', () => {
    expect(publicUrls({ domains: [{ domain: 'app.io', sslStatus: 'ACTIVE' }] })).toEqual([
      'https://app.io',
    ]);
  });

  it('custom port pins http://domain:port', () => {
    expect(
      publicUrls({ customPort: true, port: 9000, domains: [{ domain: 'app.io', sslStatus: 'ACTIVE' }] }),
    ).toEqual(['http://app.io:9000']);
  });

  it('port bindings produce http://domain:port entries', () => {
    expect(
      publicUrls({ portBindings: [{ port: 5000, domain: { domain: 'other.io', sslStatus: 'ACTIVE' } }] }),
    ).toEqual(['http://other.io:5000']);
  });

  it('no domains: hostPort wins over port for the fallback URL', () => {
    expect(publicUrls({ hostPort: 8081, port: 3000 }, 'srv.local')).toEqual(['http://srv.local:8081']);
    expect(publicUrls({ port: 3000 }, 'srv.local')).toEqual(['http://srv.local:3000']);
  });

  it('domains and bindings combine; fallback suppressed when any URL exists', () => {
    const urls = publicUrls(
      {
        hostPort: 8081,
        domains: [{ domain: 'app.io', sslStatus: 'ACTIVE' }],
        portBindings: [{ port: 5000, domain: { domain: 'other.io', sslStatus: 'ACTIVE' } }],
      },
      'srv.local',
    );
    expect(urls).toEqual(['https://app.io', 'http://other.io:5000']);
  });

  it('publicAppUrl returns the first URL or null', () => {
    expect(publicAppUrl({ domains: [{ domain: 'app.io', sslStatus: 'ACTIVE' }] })).toBe('https://app.io');
    expect(publicAppUrl({})).toBeNull();
  });
});
