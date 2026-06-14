import { describe, it, expect } from 'vitest';
import { checkImportedComposeSafety } from './dctproj-compose-guard';

const yamlDoc = (services: string) => `services:\n${services}`;

describe('checkImportedComposeSafety', () => {
  it('accepts a safe compose (named volume → abs container path)', () => {
    const c = yamlDoc(`  web:\n    image: nginx\n    volumes:\n      - data:/var/www\n`);
    expect(checkImportedComposeSafety(c)).toEqual([]);
  });

  it('rejects a host bind-mount of /', () => {
    const c = yamlDoc(`  web:\n    image: nginx\n    volumes:\n      - /:/host\n`);
    const out = checkImportedComposeSafety(c);
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(' ')).toMatch(/named volume|host/i);
  });

  it('rejects mounting the docker socket', () => {
    const c = yamlDoc(`  evil:\n    image: alpine\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`);
    expect(checkImportedComposeSafety(c).length).toBeGreaterThan(0);
  });

  it('rejects privileged: true', () => {
    const c = yamlDoc(`  x:\n    image: alpine\n    privileged: true\n`);
    expect(checkImportedComposeSafety(c).join(' ')).toMatch(/privileged/i);
  });

  it('rejects cap_add', () => {
    const c = yamlDoc(`  x:\n    image: alpine\n    cap_add:\n      - SYS_ADMIN\n`);
    expect(checkImportedComposeSafety(c).join(' ')).toMatch(/cap_add/i);
  });

  it('rejects network_mode: host and pid: host', () => {
    expect(checkImportedComposeSafety(yamlDoc(`  x:\n    image: a\n    network_mode: host\n`)).length).toBeGreaterThan(0);
    expect(checkImportedComposeSafety(yamlDoc(`  x:\n    image: a\n    pid: host\n`)).length).toBeGreaterThan(0);
  });

  it('rejects long-form bind mount', () => {
    const c = yamlDoc(`  x:\n    image: a\n    volumes:\n      - type: bind\n        source: /etc\n        target: /etc\n`);
    expect(checkImportedComposeSafety(c).join(' ')).toMatch(/bind/i);
  });

  it('rejects a top-level volume that binds a host path via driver_opts', () => {
    const c = `services:\n  x:\n    image: a\nvolumes:\n  v:\n    driver_opts:\n      type: none\n      o: bind\n      device: /host/path\n`;
    expect(checkImportedComposeSafety(c).join(' ')).toMatch(/driver_opts|host-path/i);
  });

  it('reports invalid YAML rather than throwing', () => {
    const out = checkImportedComposeSafety('::: not yaml :::\n  - [');
    expect(Array.isArray(out)).toBe(true);
  });

  it('returns [] for empty/undefined input', () => {
    expect(checkImportedComposeSafety(undefined)).toEqual([]);
    expect(checkImportedComposeSafety('')).toEqual([]);
  });
});
