import { describe, it, expect } from 'vitest';
import { readComposeContainerInfo } from './applications.helpers';

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
