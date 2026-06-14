import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { COMPOSE_TEMPLATES, PORT_MAP, renderCustomComposeTemplate } from './templates';

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

describe('renderCustomComposeTemplate — volume hardening', () => {
  const base = { image: 'linuxserver/jellyfin:latest', containerPort: 8096 };

  it('emits a safe named volume on a single quoted line', () => {
    const out = renderCustomComposeTemplate({ ...base, volumes: ['media:/data'] });
    expect(out).toContain('    volumes:\n      - "media:/data"');
    // Declares the named volume so compose accepts it.
    expect(out).toContain('volumes: {}');
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
    expect(out).not.toContain('volumes:');
  });
});
