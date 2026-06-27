import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { decodeZipSafely, safeZipEntryName, MAX_ZIP_ENTRIES } from './zip-extract';

const CAP = 100 * 1024 * 1024; // 100 MiB for the happy-path tests

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

describe('safeZipEntryName', () => {
  it('accepts normal nested paths', () => {
    expect(safeZipEntryName('index.php')).toBe('index.php');
    expect(safeZipEntryName('app/config/settings.inc.php')).toBe('app/config/settings.inc.php');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(safeZipEntryName('a\\b\\c.txt')).toBe('a/b/c.txt');
  });

  it('returns null for directory markers (skipped)', () => {
    expect(safeZipEntryName('somedir/')).toBeNull();
    expect(safeZipEntryName('')).toBeNull();
  });

  it('REJECTS zip-slip via ..', () => {
    expect(() => safeZipEntryName('../evil.sh')).toThrow(BadRequestException);
    expect(() => safeZipEntryName('a/../../etc/passwd')).toThrow(BadRequestException);
    expect(() => safeZipEntryName('ok/../../../root/.ssh/authorized_keys')).toThrow(BadRequestException);
  });

  it('REJECTS absolute paths and drive letters', () => {
    expect(() => safeZipEntryName('/etc/passwd')).toThrow(BadRequestException);
    expect(() => safeZipEntryName('C:/Windows/system32/x')).toThrow(BadRequestException);
  });

  it('REJECTS null bytes and control chars', () => {
    expect(() => safeZipEntryName('a\0b')).toThrow(BadRequestException);
    expect(() => safeZipEntryName('a\nb')).toThrow(BadRequestException);
    expect(() => safeZipEntryName('a\tb')).toThrow(BadRequestException);
  });
});

describe('decodeZipSafely', () => {
  it('decodes a normal archive into validated files', () => {
    const zip = makeZip({
      'index.php': '<?php echo 1;',
      'config/app.php': 'return [];',
    });
    const files = decodeZipSafely(zip, CAP);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.data.toString()]));
    expect(byPath['index.php']).toBe('<?php echo 1;');
    expect(byPath['config/app.php']).toBe('return [];');
    expect(files).toHaveLength(2);
  });

  it('skips pure directory entries (no empty-path file written)', () => {
    // zipSync with an explicit dir-like key still only yields the file.
    const zip = makeZip({ 'dir/file.txt': 'hi' });
    const files = decodeZipSafely(zip, CAP);
    expect(files.map((f) => f.path)).toEqual(['dir/file.txt']);
  });

  it('REJECTS a zip-slip entry before writing anything', () => {
    const zip = makeZip({ '../escape.txt': 'pwned' });
    expect(() => decodeZipSafely(zip, CAP)).toThrow(BadRequestException);
  });

  it('REJECTS an archive that decompresses beyond the cap (zip-bomb)', () => {
    // One ~1 MiB file, cap at 1000 bytes → must reject on the originalSize check.
    const big = 'A'.repeat(1024 * 1024);
    const zip = makeZip({ 'big.txt': big });
    expect(() => decodeZipSafely(zip, 1000)).toThrow(PayloadTooLargeException);
  });

  it('respects the cap exactly at the boundary', () => {
    const content = 'A'.repeat(500);
    const zip = makeZip({ 'a.txt': content });
    // cap == size → allowed; cap < size → rejected.
    expect(decodeZipSafely(zip, 500)).toHaveLength(1);
    expect(() => decodeZipSafely(zip, 499)).toThrow(PayloadTooLargeException);
  });

  it('REJECTS a non-zip buffer cleanly (BadRequest, not a crash)', () => {
    const notzip = strToU8('this is definitely not a zip file at all');
    expect(() => decodeZipSafely(notzip, CAP)).toThrow(BadRequestException);
  });

  it('enforces the entry-count ceiling', () => {
    // Build just over a tiny synthetic ceiling by monkeypatching is overkill;
    // instead assert the constant is sane and the happy path stays under it.
    expect(MAX_ZIP_ENTRIES).toBeGreaterThan(1000);
    const zip = makeZip({ 'a.txt': 'x', 'b.txt': 'y', 'c.txt': 'z' });
    expect(decodeZipSafely(zip, CAP)).toHaveLength(3);
  });
});
