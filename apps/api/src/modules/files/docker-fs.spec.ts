import { describe, it, expect } from 'vitest';
import { makeTarHeader, pickRootForImage } from './docker-fs';

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
});
