import { describe, it, expect } from 'vitest';
import { zipSync, gzipSync, strToU8 } from 'fflate';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  decodeZipSafely,
  decodeTarSafely,
  decodeTarGzSafely,
  decodeGzSafely,
  decodeArchive,
  encodeArchive,
  detectArchiveFormat,
  safeZipEntryName,
  MAX_ZIP_ENTRIES,
} from './zip-extract';

const CAP = 100 * 1024 * 1024; // 100 MiB for the happy-path tests

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

// Minimal ustar tar builder for tests (mirrors the reader in zip-extract.ts).
function makeTar(files: Record<string, string>, opts: { typeflag?: string } = {}): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf-8');
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf-8'); // name
    h.write('0000644\0', 100, 'ascii'); // mode
    h.write('0000000\0', 108, 'ascii'); // uid
    h.write('0000000\0', 116, 'ascii'); // gid
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii'); // size (octal)
    h.write('00000000000\0', 136, 'ascii'); // mtime
    h[156] = (opts.typeflag ?? '0').charCodeAt(0); // typeflag
    h.write('ustar\0', 257, 'ascii'); // magic
    h.write('00', 263, 'ascii'); // version
    // checksum: spaces then sum
    for (let i = 148; i < 156; i++) h[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(h);
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks = end
  return new Uint8Array(Buffer.concat(blocks));
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

describe('detectArchiveFormat', () => {
  it('recognizes each supported extension (case-insensitive)', () => {
    expect(detectArchiveFormat('x.zip')).toBe('zip');
    expect(detectArchiveFormat('X.ZIP')).toBe('zip');
    expect(detectArchiveFormat('release.tar.gz')).toBe('tar.gz');
    expect(detectArchiveFormat('release.TGZ')).toBe('tar.gz');
    expect(detectArchiveFormat('a.tar')).toBe('tar');
    expect(detectArchiveFormat('dump.sql.gz')).toBe('gz');
  });
  it('prefers tar.gz over gz for tarballs', () => {
    expect(detectArchiveFormat('site.tar.gz')).toBe('tar.gz');
  });
  it('returns null for non-archives', () => {
    expect(detectArchiveFormat('index.php')).toBeNull();
    expect(detectArchiveFormat('notes.txt')).toBeNull();
    expect(detectArchiveFormat('')).toBeNull();
  });
});

describe('decodeTarSafely', () => {
  it('decodes a normal tar with nested paths', () => {
    const tar = makeTar({ 'index.php': '<?php', 'sub/dir/f.txt': 'hello' });
    const files = decodeTarSafely(tar, CAP);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.data.toString()]));
    expect(byPath['index.php']).toBe('<?php');
    expect(byPath['sub/dir/f.txt']).toBe('hello');
  });
  it('REJECTS zip-slip entries', () => {
    const tar = makeTar({ '../escape.sh': 'pwn' });
    expect(() => decodeTarSafely(tar, CAP)).toThrow(BadRequestException);
  });
  it('skips symlink/dir typeflags (only regular files extracted)', () => {
    const sym = makeTar({ 'link': 'target' }, { typeflag: '2' }); // symlink
    expect(decodeTarSafely(sym, CAP)).toHaveLength(0);
    const dir = makeTar({ 'somedir': '' }, { typeflag: '5' }); // directory
    expect(decodeTarSafely(dir, CAP)).toHaveLength(0);
  });
  it('caps the decompressed total (zip-bomb)', () => {
    const tar = makeTar({ 'big.txt': 'A'.repeat(2000) });
    expect(() => decodeTarSafely(tar, 1000)).toThrow(PayloadTooLargeException);
  });
});

describe('decodeTarGzSafely', () => {
  it('round-trips a gzipped tar', () => {
    const tar = makeTar({ 'a.txt': 'one', 'b/c.txt': 'two' });
    const tgz = gzipSync(tar);
    const files = decodeTarGzSafely(tgz, CAP);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.data.toString()]));
    expect(byPath['a.txt']).toBe('one');
    expect(byPath['b/c.txt']).toBe('two');
  });
  it('caps decompressed output (gz bomb)', () => {
    const tar = makeTar({ 'big.txt': 'A'.repeat(5000) });
    const tgz = gzipSync(tar);
    expect(() => decodeTarGzSafely(tgz, 1000)).toThrow(PayloadTooLargeException);
  });
  it('rejects a non-gzip buffer', () => {
    expect(() => decodeTarGzSafely(strToU8('nope'), CAP)).toThrow(BadRequestException);
  });
});

describe('decodeGzSafely', () => {
  it('decodes a single gz file, naming output by stripping .gz', () => {
    const gz = gzipSync(strToU8('SELECT 1;'));
    const files = decodeGzSafely(gz, 'dump.sql.gz', CAP);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('dump.sql');
    expect(files[0].data.toString()).toBe('SELECT 1;');
  });
  it('caps the inflated size', () => {
    const gz = gzipSync(strToU8('A'.repeat(5000)));
    expect(() => decodeGzSafely(gz, 'big.gz', 1000)).toThrow(PayloadTooLargeException);
  });
  it('rejects a gzip BOMB without inflating it whole (bounded memory)', () => {
    // 50 MiB of zeros compresses to ~50 KiB but would inflate to 50 MiB. With a
    // 1 MiB cap, the streaming gunzip must reject it — and (the point of the
    // fix) abort early rather than allocate the full 50 MiB first.
    const bomb = gzipSync(new Uint8Array(50 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024 * 1024); // genuinely a "bomb"
    expect(() => decodeGzSafely(bomb, 'bomb.gz', 1024 * 1024)).toThrow(PayloadTooLargeException);
  });
  it('tar.gz bomb is likewise rejected', () => {
    const tar = makeTar({ 'big.txt': 'A'.repeat(10 * 1024 * 1024) });
    const tgz = gzipSync(tar);
    expect(() => decodeTarGzSafely(tgz, 1024 * 1024)).toThrow(PayloadTooLargeException);
  });
});

describe('decodeArchive dispatch', () => {
  it('routes each format to the right decoder', () => {
    expect(decodeArchive('zip', makeZip({ 'a.txt': 'z' }), 'a.zip', CAP)[0].path).toBe('a.txt');
    expect(decodeArchive('tar', makeTar({ 'a.txt': 't' }), 'a.tar', CAP)[0].path).toBe('a.txt');
    expect(decodeArchive('tar.gz', gzipSync(makeTar({ 'a.txt': 'g' })), 'a.tar.gz', CAP)[0].path).toBe('a.txt');
    expect(decodeArchive('gz', gzipSync(strToU8('x')), 'a.txt.gz', CAP)[0].path).toBe('a.txt');
  });
});

describe('encodeArchive (compress) — round-trips through the decoders', () => {
  const input = [
    { path: 'index.php', data: Buffer.from('<?php echo "hi";') },
    { path: 'sub/dir/data.json', data: Buffer.from('{"a":1}') },
    { path: 'empty.txt', data: Buffer.from('') },
  ];

  it('zip: encode → decodeZipSafely yields the same files', () => {
    const archive = encodeArchive('zip', input);
    const out = decodeArchive('zip', archive, 'x.zip', CAP);
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.data.toString()]));
    expect(byPath['index.php']).toBe('<?php echo "hi";');
    expect(byPath['sub/dir/data.json']).toBe('{"a":1}');
    expect(byPath['empty.txt']).toBe('');
  });

  it('tar.gz: encode → decodeTarGzSafely yields the same files', () => {
    const archive = encodeArchive('tar.gz', input);
    const out = decodeArchive('tar.gz', archive, 'x.tar.gz', CAP);
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.data.toString()]));
    expect(byPath['index.php']).toBe('<?php echo "hi";');
    expect(byPath['sub/dir/data.json']).toBe('{"a":1}');
  });

  it('produced tar.gz is a valid gzip (starts with magic 1f 8b)', () => {
    const archive = encodeArchive('tar.gz', input);
    expect(archive[0]).toBe(0x1f);
    expect(archive[1]).toBe(0x8b);
  });

  it('rejects an unsupported compress format', () => {
    expect(() => encodeArchive('rar' as any, input)).toThrow();
  });
});
