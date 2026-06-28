import { describe, it, expect } from 'vitest';
import { makeTarHeader, pickRootForImage, buildFixWebPermsScript, isWwwDataRoot } from './docker-fs';

/** Parse a NUL/space-terminated octal field out of a tar header. */
function readOctal(header: Buffer, offset: number, length: number): number {
  const raw = header.subarray(offset, offset + length).toString('ascii');
  const trimmed = raw.replace(/[\0 ]+$/g, '').trim();
  return parseInt(trimmed, 8);
}

function readString(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? length : nul).toString('utf-8');
}

/** Recompute the ustar checksum (checksum field treated as 8 spaces). */
function computeChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

describe('makeTarHeader', () => {
  it('is exactly 512 bytes', () => {
    expect(makeTarHeader('a.txt', 0).length).toBe(512);
  });

  it('encodes the entry name at offset 0', () => {
    const h = makeTarHeader('hello.bin', 1234);
    expect(readString(h, 0, 100)).toBe('hello.bin');
  });

  it('encodes the size field in octal for a given size', () => {
    for (const size of [0, 1, 511, 512, 513, 50 * 1024 * 1024, 1_073_741_823]) {
      const h = makeTarHeader('f', size);
      expect(readOctal(h, 124, 12)).toBe(size);
    }
  });

  it('writes a regular-file typeflag and ustar magic', () => {
    const h = makeTarHeader('f', 42);
    expect(String.fromCharCode(h[156])).toBe('0');
    expect(readString(h, 257, 6)).toBe('ustar');
    expect(h.subarray(263, 265).toString('ascii')).toBe('00');
  });

  it('has a valid checksum', () => {
    const h = makeTarHeader('some-file.tar.gz', 987654);
    expect(readOctal(h, 148, 8)).toBe(computeChecksum(h));
  });

  it('mode field is 0644', () => {
    const h = makeTarHeader('f', 1);
    expect(readOctal(h, 100, 8)).toBe(0o644);
  });

  it('rejects names over 100 chars', () => {
    expect(() => makeTarHeader('x'.repeat(101), 1)).toThrow(/too long/i);
  });

  it('rejects negative or non-integer sizes', () => {
    expect(() => makeTarHeader('f', -1)).toThrow(/size/i);
    expect(() => makeTarHeader('f', 1.5)).toThrow(/size/i);
  });
});

describe('pickRootForImage', () => {
  it('maps known images to their web roots', () => {
    expect(pickRootForImage('prestashop/prestashop:8')).toBe('/var/www/html');
    expect(pickRootForImage('nginx:alpine')).toBe('/usr/share/nginx/html');
  });

  it('falls back to / for unknown images', () => {
    expect(pickRootForImage('redis:7')).toBe('/');
    expect(pickRootForImage(null)).toBe('/');
  });

  it('maps phpmyadmin to /var/www/html', () => {
    expect(pickRootForImage('phpmyadmin:latest')).toBe('/var/www/html');
    expect(pickRootForImage('dockcontrol-phpmyadmin-abc')).toBe('/var/www/html');
  });
});

describe('isWwwDataRoot', () => {
  it('true only for www-data docroots', () => {
    expect(isWwwDataRoot('/var/www/html')).toBe(true);
    // non-www-data roots — chowning these to 33:33 would break the container
    expect(isWwwDataRoot('/var/lib/grafana')).toBe(false);
    expect(isWwwDataRoot('/data')).toBe(false);
    expect(isWwwDataRoot('/')).toBe(false);
  });
});

describe('buildFixWebPermsScript', () => {
  it('renders dirs→775, files→664, chown -R owner (all single-quoted)', () => {
    const s = buildFixWebPermsScript('/var/www/html', 0o775, 0o664, '33:33');
    expect(s).toContain("find -P '/var/www/html'");
    expect(s).toContain('-type d -exec chmod 775 {} +');
    expect(s).toContain('-type f -exec chmod 664 {} +');
    expect(s).toContain("chown -R '33:33' '/var/www/html'");
    // managed secret files are pruned from the chmod
    expect(s).toContain('-name .dockcontrol.env -prune');
    expect(s).toContain('-name docker-compose.override.yml -prune');
  });

  it('omits chown when no owner is given (chmod-only)', () => {
    const s = buildFixWebPermsScript('/srv', 0o775, 0o664);
    expect(s).not.toContain('chown');
    expect(s).toContain('chmod 775');
  });

  it('masks off setuid/sticky high bits in the octal', () => {
    // 0o4775 must render as 775 (the mask is & 0o777).
    const s = buildFixWebPermsScript('/x', 0o4775, 0o2664, '0:0');
    expect(s).toContain('chmod 775');
    expect(s).toContain('chmod 664');
    expect(s).not.toContain('chmod 4775');
  });
});
