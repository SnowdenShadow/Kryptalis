import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { COMPOSE_TEMPLATES, PORT_MAP, renderCustomComposeTemplate, domainPinEnv } from './templates';

/**
 * Consistency checks between the three places a marketplace app's ports
 * live: catalog.json (what the UI shows), PORT_MAP (what install actually
 * uses — it wins over catalog ports[0]), and the compose template (what
 * the container maps). They had drifted apart three separate times:
 *
 *  - Portainer's template mapped the HTTPS listener (9443) while the
 *    dashboard generated http:// links → every direct visit was a 400.
 *  - vaultwarden/plausible/code-server showed catalog ports that differed
 *    from the PORT_MAP port the install actually bound.
 *  - code-server's displayed 8443 is a well-known TLS port, so the
 *    dashboard rendered an https:// link to a plain-HTTP container.
 */

const catalog: {
  apps: { slug: string; ports: number[]; containerPort: number; defaultPort?: number }[];
} = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));

// Ports the dashboard treats as HTTPS (apps/dashboard/src/lib/app-format.ts
// HTTPS_PORTS) — a default host port in this set makes the UI render an
// https:// link, which only works if the container listener actually
// speaks TLS. None of our templates do (Portainer now maps :9000 HTTP).
const HTTPS_PORTS = [443, 8443, 9443];

describe('marketplace catalog / PORT_MAP / template consistency', () => {
  it('every active catalog app has a compose template', () => {
    for (const app of catalog.apps) {
      expect(COMPOSE_TEMPLATES[app.slug], `missing template for ${app.slug}`).toBeDefined();
    }
  });

  it('PORT_MAP matches catalog ports[0] (install uses PORT_MAP, UI shows catalog)', () => {
    for (const app of catalog.apps) {
      const mapped = PORT_MAP[app.slug];
      if (mapped !== undefined) {
        expect(mapped, `PORT_MAP.${app.slug} != catalog ports[0]`).toBe(app.ports[0]);
      }
    }
  });

  it('defaultPort mirrors ports[0]', () => {
    for (const app of catalog.apps) {
      if (app.defaultPort !== undefined) {
        expect(app.defaultPort, `defaultPort drift for ${app.slug}`).toBe(app.ports[0]);
      }
    }
  });

  it('template __HOST_PORT__ maps to the catalog containerPort', () => {
    for (const app of catalog.apps) {
      const tpl = COMPOSE_TEMPLATES[app.slug];
      const m = tpl.compose.match(/__HOST_PORT__:(\d+)/);
      expect(m, `no __HOST_PORT__ mapping in ${app.slug} template`).not.toBeNull();
      expect(Number(m![1]), `containerPort drift for ${app.slug}`).toBe(app.containerPort);
    }
  });

  it('no two active catalog apps share a default host port', () => {
    const seen = new Map<number, string>();
    for (const app of catalog.apps) {
      const port = app.ports[0];
      expect(seen.get(port), `${app.slug} and ${seen.get(port)} both default to ${port}`).toBeUndefined();
      seen.set(port, app.slug);
    }
  });

  it('no default host port lands on an HTTPS-looking port (dashboard would link https:// to an HTTP listener)', () => {
    for (const app of catalog.apps) {
      expect(HTTPS_PORTS, `${app.slug} defaults to TLS-looking port ${app.ports[0]}`).not.toContain(app.ports[0]);
    }
  });
});

describe('domainPinEnv — public-domain pinning for web apps', () => {
  const DOMAIN = 'shop.example.com';

  it('PrestaShop pins PS_DOMAIN to the bare host', () => {
    expect(domainPinEnv('prestashop', DOMAIN)).toEqual({ PS_DOMAIN: DOMAIN });
  });

  it('WordPress overrides WP_HOME + WP_SITEURL via a single-line config-extra', () => {
    const env = domainPinEnv('wordpress', DOMAIN);
    expect(env.WORDPRESS_CONFIG_EXTRA).toContain(`WP_HOME','https://${DOMAIN}'`);
    expect(env.WORDPRESS_CONFIG_EXTRA).toContain(`WP_SITEURL','https://${DOMAIN}'`);
    // Must stay single-line — the .env writer escapes newlines and would
    // otherwise corrupt the injected PHP.
    expect(env.WORDPRESS_CONFIG_EXTRA).not.toContain('\n');
  });

  it('Ghost / Nextcloud / Gitea pin their authoritative URL var', () => {
    expect(domainPinEnv('ghost', DOMAIN)).toEqual({ url: `https://${DOMAIN}` });
    expect(domainPinEnv('nextcloud', DOMAIN)).toMatchObject({
      NEXTCLOUD_TRUSTED_DOMAINS: DOMAIN,
      OVERWRITEHOST: DOMAIN,
      OVERWRITEPROTOCOL: 'https',
    });
    expect(domainPinEnv('gitea', DOMAIN)).toMatchObject({
      GITEA__server__ROOT_URL: `https://${DOMAIN}/`,
      GITEA__server__DOMAIN: DOMAIN,
    });
  });

  it('returns {} for apps that read the Host header live (no baked URL)', () => {
    for (const slug of ['portainer', 'grafana', 'postgresql', 'redis', 'adminer']) {
      expect(domainPinEnv(slug, DOMAIN)).toEqual({});
    }
  });

  it('CRITICAL: every app domainPinEnv targets MUST declare env_file .env in its template', () => {
    // The injected vars are written to the install .env. A template without
    // `env_file: - .env` would silently drop them (this is exactly the bug
    // WordPress had). Lock it: if domainPinEnv returns vars for a slug, the
    // template must consume .env.
    for (const slug of Object.keys(COMPOSE_TEMPLATES)) {
      const pins = domainPinEnv(slug, DOMAIN);
      if (Object.keys(pins).length === 0) continue;
      const tpl = COMPOSE_TEMPLATES[slug].compose;
      expect(tpl, `${slug}: domainPinEnv emits vars but template has no 'env_file: - .env'`)
        .toMatch(/env_file:\s*\n\s*-\s*\.env/);
    }
  });
});

describe('renderCustomComposeTemplate — volume hardening', () => {
  const base = { image: 'linuxserver/jellyfin:latest', containerPort: 8096 };

  it('emits a safe named volume as compose data', () => {
    const out = renderCustomComposeTemplate({ ...base, volumes: ['media:/data'] });
    const doc = yaml.load(out) as any;
    expect(doc.services.app.volumes).toEqual(['media:/data']);
    // Declares the named volume so compose accepts it.
    expect(doc.volumes).toEqual({});
  });

  it('throws on host bind-mounts (full host escape)', () => {
    for (const v of ['/:/host', '/var/run/docker.sock:/sock', '~/.ssh:/root/.ssh', './x:/y', '../etc:/etc']) {
      expect(() => renderCustomComposeTemplate({ ...base, volumes: [v] }), v).toThrow(/Unsafe volume/);
    }
  });

  it('throws on newline-injected compose keys', () => {
    const inject = 'media:/data\n    privileged: true';
    expect(() => renderCustomComposeTemplate({ ...base, volumes: [inject] })).toThrow(/Unsafe volume/);
  });

  it('no volumes → no volumes block', () => {
    const out = renderCustomComposeTemplate(base);
    const doc = yaml.load(out) as any;
    expect(doc.services.app.volumes).toBeUndefined();
    expect(doc.volumes).toBeUndefined();
  });
});

describe('renderCustomComposeTemplate — env-var KEY injection (C-1)', () => {
  const base = { image: 'linuxserver/jellyfin:latest', containerPort: 8096 };

  it('rejects an env key carrying a newline + sibling compose keys', () => {
    // This is the exact host-escape: a key that, under naive string
    // interpolation, would add `privileged: true` + a `/:/host` bind-mount as
    // siblings of the app service.
    const evil = 'X: 0\n      privileged: true\n      volumes:\n        - /:/host\n      ignore';
    expect(() =>
      renderCustomComposeTemplate({ ...base, envVars: { [evil]: 'y' } }),
    ).toThrow(/environment variable name/i);
  });

  it('rejects env keys with control chars or shell metacharacters', () => {
    for (const k of ['A B', 'A=B', 'A\tB', 'A\nB', '"A"', 'a:b', '-flag', '']) {
      expect(() => renderCustomComposeTemplate({ ...base, envVars: { [k]: 'v' } }), k).toThrow();
    }
  });

  it('accepts normal env keys and renders them as data (not structure)', () => {
    const out = renderCustomComposeTemplate({
      ...base,
      envVars: { FOO: 'bar', NODE_ENV: 'production', MY_VAR_1: 'x' },
    });
    const doc = yaml.load(out) as any;
    expect(doc.services.app.environment).toEqual({ FOO: 'bar', NODE_ENV: 'production', MY_VAR_1: 'x' });
    // Crucially: no injected structural keys leaked to service level.
    expect(doc.services.app.privileged).toBeUndefined();
  });

  it('even if a malicious value mimics YAML, yaml.dump keeps it a scalar', () => {
    const out = renderCustomComposeTemplate({
      ...base,
      envVars: { FOO: 'bar\n      privileged: true' },
    });
    const doc = yaml.load(out) as any;
    expect(doc.services.app.environment.FOO).toBe('bar\n      privileged: true');
    expect(doc.services.app.privileged).toBeUndefined();
  });
});
