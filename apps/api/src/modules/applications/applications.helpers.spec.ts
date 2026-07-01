import { describe, it, expect } from 'vitest';
import {
  readComposeContainerInfo,
  parseDockerStatsJson,
  parseStatSize,
  parseStatPercent,
  parseStatPair,
} from './applications.helpers';

describe('docker stats parsing', () => {
  it('parseStatPercent handles "%" and bad input', () => {
    expect(parseStatPercent('12.34%')).toBe(12.34);
    expect(parseStatPercent('0.00%')).toBe(0);
    expect(parseStatPercent('bad')).toBe(0);
  });

  it('parseStatSize handles IEC + SI suffixes and edge cases', () => {
    expect(parseStatSize('340MiB')).toBe(340 * 1024 * 1024);
    expect(parseStatSize('2.1GB')).toBe(2_100_000_000);
    expect(parseStatSize('1kB')).toBe(1000);
    expect(parseStatSize('0B')).toBe(0);
    expect(parseStatSize('--')).toBe(0);
    expect(parseStatSize('')).toBe(0);
    expect(parseStatSize('garbage')).toBe(0);
  });

  it('parseStatPair splits "A / B"', () => {
    expect(parseStatPair('340MiB / 512MiB')).toEqual([340 * 1024 * 1024, 512 * 1024 * 1024]);
    expect(parseStatPair('2.1MB / 800kB')).toEqual([2_100_000, 800_000]);
  });

  it('parseDockerStatsJson maps fields and skips unparseable lines', () => {
    const raw = [
      JSON.stringify({ Name: 'dockcontrol-shop', CPUPerc: '12.34%', MemUsage: '340MiB / 512MiB', NetIO: '2.1MB / 800kB', BlockIO: '15MB / 3MB' }),
      'not-json',
      JSON.stringify({ Name: 'dockcontrol-api', CPUPerc: '1%', MemUsage: '10MiB / 20MiB', NetIO: '0B / 0B', BlockIO: '0B / 0B' }),
    ].join('\n');
    const out = parseDockerStatsJson(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      name: 'dockcontrol-shop',
      cpuPercent: 12.34,
      memoryUsed: 340 * 1024 * 1024,
      memoryLimit: 512 * 1024 * 1024,
      blockRead: 15_000_000,
      blockWrite: 3_000_000,
    });
  });

  it('parseDockerStatsJson tolerates empty input', () => {
    expect(parseDockerStatsJson('')).toEqual([]);
    expect(parseDockerStatsJson('   ')).toEqual([]);
  });
});

describe('readComposeContainerInfo — port extraction', () => {
  it('splits a "host:container" publish into published vs container port', () => {
    const c = 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:9000"\n';
    const info = readComposeContainerInfo(c, 'fallback');
    expect(info.publishedHostPort).toBe(8080);
    expect(info.containerPort).toBe(9000);
  });

  it('handles an IP-prefixed "ip:host:container" publish', () => {
    const c = 'services:\n  web:\n    image: nginx\n    ports:\n      - "127.0.0.1:8080:9000"\n';
    const info = readComposeContainerInfo(c, 'fallback');
    expect(info.publishedHostPort).toBe(8080);
    expect(info.containerPort).toBe(9000);
  });

  it('treats a bare "9000" as a container port with no fixed published host port', () => {
    const c = 'services:\n  web:\n    image: nginx\n    ports:\n      - "9000"\n';
    const info = readComposeContainerInfo(c, 'fallback');
    expect(info.publishedHostPort).toBeNull();
    expect(info.containerPort).toBe(9000);
  });

  it('reads the long-form { published, target } mapping', () => {
    const c = 'services:\n  web:\n    image: nginx\n    ports:\n      - target: 9000\n        published: 8080\n';
    const info = readComposeContainerInfo(c, 'fallback');
    expect(info.publishedHostPort).toBe(8080);
    expect(info.containerPort).toBe(9000);
  });

  it('returns nulls when no ports are declared', () => {
    const c = 'services:\n  web:\n    image: nginx\n';
    const info = readComposeContainerInfo(c, 'fallback');
    expect(info.publishedHostPort).toBeNull();
    expect(info.containerPort).toBeNull();
    expect(info.containerName).toBe('fallback-web');
  });

  it('uses container_name when present', () => {
    const c = 'services:\n  web:\n    image: nginx\n    container_name: my-app\n    ports:\n      - "8080:9000"\n';
    const info = readComposeContainerInfo(c, 'fallback');
    expect(info.containerName).toBe('my-app');
  });

  it('is resilient to invalid YAML', () => {
    const info = readComposeContainerInfo(':::not yaml', 'fb');
    expect(info.containerName).toBe('fb');
    expect(info.containerPort).toBeNull();
    expect(info.publishedHostPort).toBeNull();
  });
});
