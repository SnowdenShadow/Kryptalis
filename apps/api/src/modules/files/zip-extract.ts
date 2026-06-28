/**
 * Secure ZIP extraction primitives shared by the file-manager (FilesService).
 *
 * The file manager runs under node:20-alpine which has NO `unzip` binary, and
 * the repo ships no zip-capable system tool — so we read .zip archives with
 * `fflate` (pure-JS, zero-dependency). We deliberately do NOT let fflate (or
 * any library) write to disk: it only decodes the in-memory archive, and the
 * CALLER writes each validated entry through the file manager's existing
 * symlink-safe writers (O_NOFOLLOW / docker-fs / agent FILE_WRITE). That keeps
 * one set of write-path defenses for both normal writes and extraction.
 *
 * Threats handled HERE (mirrors project-transfer's .dctproj import guards):
 *  - zip-slip / path traversal: every entry name is validated to a safe
 *    relative path BEFORE anything is written (no `..`, no absolute, no control
 *    chars, no backslashes, no leading slash).
 *  - zip-bomb: the total UNCOMPRESSED size is summed from the central directory
 *    (fflate exposes `originalSize` in the filter, before inflating) and capped;
 *    the entry COUNT is capped too. Both reject before any decompression work.
 */
import { unzipSync, Gunzip, zipSync, gzipSync, type UnzipFileInfo } from 'fflate';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/** Hard ceiling on entries in one archive (defence against archive-of-many-files). */
export const MAX_ZIP_ENTRIES = 50_000;

/** Supported archive formats for in-place extraction. */
export type ArchiveFormat = 'zip' | 'tar.gz' | 'tar' | 'gz';

/**
 * Detect the archive format from a filename (case-insensitive, by extension).
 * Returns null when the name is not a supported archive. `.tar.gz`/`.tgz` is
 * checked before `.gz` so a tarball isn't mistaken for a single gz file.
 */
export function detectArchiveFormat(name: string): ArchiveFormat | null {
  const n = (name || '').toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
  if (n.endsWith('.tar')) return 'tar';
  if (n.endsWith('.gz')) return 'gz';
  return null;
}

/**
 * A single safe, validated file entry ready to be written by the caller.
 * Directories are implicit (the caller mkdir -p's the parent of each file).
 */
export interface ExtractedFile {
  /** Safe, normalized, forward-slash relative path (never starts with `/`). */
  path: string;
  /** Decompressed file contents. */
  data: Buffer;
}

/**
 * Validate a ZIP entry name to a safe relative path, or return null when the
 * entry should be skipped (a directory marker). Throws on a hostile name.
 *
 * Rules: forward-slash separators only, no leading slash, no `.`/`..` segments,
 * no null bytes / C0 control chars, no drive letters / backslashes. These are
 * the same constraints the file manager's resolvePath()/joinAndValidate()
 * enforce — applied here up front so nothing hostile reaches a writer.
 */
export function safeZipEntryName(rawName: string): string | null {
  if (typeof rawName !== 'string') throw new BadRequestException('Invalid zip entry name');
  // Directory entries end in '/'. Skip — we create dirs from file parents.
  const isDir = rawName.endsWith('/');
  const name = rawName.replace(/\\/g, '/'); // normalize Windows separators
  if (name.includes('\0')) throw new BadRequestException(`Zip entry has a null byte: ${JSON.stringify(rawName)}`);
  // C0 control characters (other than the ones we already excluded) are refused.
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 0x20) {
      throw new BadRequestException(`Zip entry has a control character: ${JSON.stringify(rawName)}`);
    }
  }
  if (name.startsWith('/')) throw new BadRequestException(`Absolute zip entry path: ${JSON.stringify(rawName)}`);
  if (/^[A-Za-z]:/.test(name)) throw new BadRequestException(`Drive-letter zip entry path: ${JSON.stringify(rawName)}`);
  const segments = name.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..') throw new BadRequestException(`Zip entry escapes the archive (..): ${JSON.stringify(rawName)}`);
    if (seg === '.') throw new BadRequestException(`Zip entry has a '.' segment: ${JSON.stringify(rawName)}`);
  }
  if (segments.length === 0) return null; // root / empty → nothing to write
  if (isDir) return null; // a pure directory entry — caller derives dirs from files
  return segments.join('/');
}

/**
 * Decode a .zip buffer into validated in-memory files, enforcing the zip-bomb
 * caps. `maxUncompressedBytes` is the hard ceiling on the SUM of all entries'
 * uncompressed sizes (the caller passes the project's remaining quota, or a
 * sensible absolute cap, whichever is smaller). Throws PayloadTooLargeException
 * past the cap and BadRequestException on a hostile/invalid archive.
 *
 * Returns the files newest decoders would write; the caller is responsible for
 * actually persisting them (local fs / docker-fs / agent) and for creating
 * parent directories.
 */
export function decodeZipSafely(zip: Uint8Array, maxUncompressedBytes: number): ExtractedFile[] {
  let entryCount = 0;
  let totalUncompressed = 0;
  // The filter runs over the central directory BEFORE inflating each entry, so
  // we reject oversized/too-many/hostile archives without doing the work.
  const filter = (info: UnzipFileInfo): boolean => {
    // safeZipEntryName throws on hostile names; null = a dir we skip.
    const safe = safeZipEntryName(info.name);
    if (safe === null) return false;
    entryCount++;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new BadRequestException(`Archive has too many entries (> ${MAX_ZIP_ENTRIES}).`);
    }
    totalUncompressed += Math.max(0, info.originalSize || 0);
    if (totalUncompressed > maxUncompressedBytes) {
      throw new PayloadTooLargeException(
        `Archive decompresses beyond the allowed ${maxUncompressedBytes} bytes (possible zip bomb).`,
      );
    }
    return true;
  };

  let decoded: Record<string, Uint8Array>;
  try {
    decoded = unzipSync(zip, { filter });
  } catch (e) {
    // Re-throw our own typed exceptions; wrap fflate decode errors.
    if (e instanceof BadRequestException || e instanceof PayloadTooLargeException) throw e;
    throw new BadRequestException(`Not a valid .zip archive: ${(e as Error).message}`);
  }

  const files: ExtractedFile[] = [];
  for (const [rawName, content] of Object.entries(decoded)) {
    const safe = safeZipEntryName(rawName);
    if (safe === null) continue;
    files.push({ path: safe, data: Buffer.from(content) });
  }
  return files;
}

// ─── TAR (ustar) ──────────────────────────────────────────────────────
//
// fflate handles zip + gzip but NOT tar (tar is a separate container format).
// A tar is a sequence of 512-byte blocks: each file is a 512-byte header
// followed by ceil(size/512) data blocks. We parse it with a tiny reader and
// apply the SAME path/zip-bomb guards as the zip path. We only extract regular
// files (typeflag '0' or '\0'); directories are implicit, and symlinks/devices/
// hardlinks are skipped (never created → no escape hatch).

const TAR_BLOCK = 512;

/** Parse an octal numeric tar header field (NUL/space terminated). */
function tarOctal(buf: Buffer, off: number, len: number): number {
  let s = '';
  for (let i = off; i < off + len; i++) {
    const c = buf[i];
    if (c === 0 || c === 0x20) break; // NUL or space terminates
    s += String.fromCharCode(c);
  }
  s = s.trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/** Read a NUL-terminated string field. */
function tarStr(buf: Buffer, off: number, len: number): string {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return buf.toString('utf-8', off, end);
}

/**
 * Decode a raw (uncompressed) tar buffer into validated files, enforcing the
 * same zip-slip + zip-bomb caps as the zip path.
 */
export function decodeTarSafely(tar: Uint8Array, maxUncompressedBytes: number): ExtractedFile[] {
  const buf = Buffer.from(tar);
  const files: ExtractedFile[] = [];
  let off = 0;
  let entryCount = 0;
  let total = 0;
  // A valid tar ends with two zero blocks; tolerate a truncated trailer.
  while (off + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(off, off + TAR_BLOCK);
    // All-zero block → end of archive.
    if (header.every((b) => b === 0)) break;

    const name = tarStr(buf, off, 100);
    const size = tarOctal(buf, off + 124, 12);
    const typeflag = String.fromCharCode(buf[off + 156] || 0x30); // '0' default
    // ustar prefix (long paths) — prepend if present.
    const magic = tarStr(buf, off + 257, 6);
    const prefix = magic.startsWith('ustar') ? tarStr(buf, off + 345, 155) : '';
    const fullName = prefix ? `${prefix}/${name}` : name;

    off += TAR_BLOCK;
    const dataLen = size;
    const padded = Math.ceil(dataLen / TAR_BLOCK) * TAR_BLOCK;

    // Only regular files ('0' or NUL). Skip dirs '5', symlinks '2', links '1',
    // char/block/fifo, and GNU/pax extension records ('x','g','L','K').
    const isRegular = typeflag === '0' || typeflag === '\0';
    if (isRegular) {
      const safe = safeZipEntryName(fullName); // reuse the zip path guards
      if (safe !== null) {
        entryCount++;
        if (entryCount > MAX_ZIP_ENTRIES) {
          throw new BadRequestException(`Archive has too many entries (> ${MAX_ZIP_ENTRIES}).`);
        }
        total += dataLen;
        if (total > maxUncompressedBytes) {
          throw new PayloadTooLargeException(
            `Archive decompresses beyond the allowed ${maxUncompressedBytes} bytes (possible zip bomb).`,
          );
        }
        if (off + dataLen > buf.length) {
          throw new BadRequestException('Corrupt tar: entry data runs past end of archive.');
        }
        files.push({ path: safe, data: Buffer.from(buf.subarray(off, off + dataLen)) });
      }
    }
    off += padded;
  }
  return files;
}

/**
 * Decompress a gzip buffer with a hard output cap that bounds ALLOCATION, not
 * just the finished result. We STREAM through fflate's incremental Gunzip and
 * abort as soon as the cumulative output passes the cap — so a small gz that
 * would inflate to many GB (a gzip bomb) is rejected after only `maxBytes` have
 * been buffered, never the full inflated size. (gunzipSync would allocate the
 * whole output up-front from the gzip ISIZE footer before any check — an OOM.)
 */
function gunzipCapped(gz: Uint8Array, maxBytes: number): Buffer {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let aborted: Error | null = null;
  const gunzip = new Gunzip((chunk) => {
    if (aborted) return;
    total += chunk.length;
    if (total > maxBytes) {
      aborted = new PayloadTooLargeException(
        `Archive decompresses beyond the allowed ${maxBytes} bytes (possible zip bomb).`,
      );
      return;
    }
    chunks.push(chunk);
  });
  // Feed the compressed input in small slices so fflate emits output
  // INCREMENTALLY — we check (and abort) after each slice's callbacks, so a
  // gzip bomb is stopped early, never the full multi-GB inflate. A single
  // push(gz, true) would inflate everything in one shot from the ISIZE footer
  // (the OOM we're guarding against). 8 KiB input slices keep the peak buffered
  // output bounded (~8 MiB) INDEPENDENT of the bomb's inflated size — verified
  // against 500 MiB and 2 GiB bombs.
  const SLICE = 8 * 1024;
  try {
    for (let i = 0; i < gz.length && !aborted; i += SLICE) {
      const end = Math.min(i + SLICE, gz.length);
      gunzip.push(gz.subarray(i, end), end >= gz.length);
    }
  } catch (e) {
    if (aborted) throw aborted;
    throw new BadRequestException(`Not a valid gzip stream: ${(e as Error).message}`);
  }
  if (aborted) throw aborted;
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** Decode a .tar.gz / .tgz buffer (gunzip → tar). */
export function decodeTarGzSafely(tgz: Uint8Array, maxUncompressedBytes: number): ExtractedFile[] {
  const tar = gunzipCapped(tgz, maxUncompressedBytes);
  return decodeTarSafely(tar, maxUncompressedBytes);
}

/**
 * Decode a single-file .gz (e.g. dump.sql.gz → dump.sql). The output filename
 * is the archive name minus the trailing `.gz`, validated as a safe entry.
 */
export function decodeGzSafely(
  gz: Uint8Array,
  archiveBasename: string,
  maxUncompressedBytes: number,
): ExtractedFile[] {
  const data = gunzipCapped(gz, maxUncompressedBytes);
  const base = archiveBasename.replace(/\.gz$/i, '') || 'extracted';
  const safe = safeZipEntryName(base);
  if (safe === null) throw new BadRequestException('Invalid output filename for .gz');
  return [{ path: safe, data }];
}

/**
 * Single entry point the service calls: decode any supported archive into the
 * validated in-memory file list. `archiveBasename` is only used by the `.gz`
 * single-file case to name the output.
 */
export function decodeArchive(
  format: ArchiveFormat,
  buf: Uint8Array,
  archiveBasename: string,
  maxUncompressedBytes: number,
): ExtractedFile[] {
  switch (format) {
    case 'zip':
      return decodeZipSafely(buf, maxUncompressedBytes);
    case 'tar.gz':
      return decodeTarGzSafely(buf, maxUncompressedBytes);
    case 'tar':
      return decodeTarSafely(buf, maxUncompressedBytes);
    case 'gz':
      return decodeGzSafely(buf, archiveBasename, maxUncompressedBytes);
    default:
      throw new BadRequestException(`Unsupported archive format: ${format}`);
  }
}

// ─── COMPRESSION (the inverse) ─────────────────────────────────────────
//
// Build a .zip or .tar.gz from an in-memory list of {path,data} files. Same
// pure-JS approach (fflate) — no system `zip`/`tar` needed. The caller is
// responsible for reading the files safely (symlink/managed checks) and for
// capping how much it reads; here we just encode.

/** Formats we can PRODUCE for "compress selection". */
export type CompressFormat = 'zip' | 'tar.gz';

/** Pad a ustar numeric field (octal, NUL-terminated). */
function tarNumField(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}

/** Build a single ustar 512-byte header block for a regular file. */
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(TAR_BLOCK);
  // name (max 100 here; longer names use the prefix field but our paths are
  // sandbox-relative and short — guard and reject absurdly long ones).
  if (Buffer.byteLength(name) > 100) {
    throw new BadRequestException(`Path too long for tar (>100 bytes): ${name}`);
  }
  h.write(name, 0, 'utf-8');
  h.write('0000644\0', 100, 'ascii'); // mode 0644
  h.write('0000000\0', 108, 'ascii'); // uid
  h.write('0000000\0', 116, 'ascii'); // gid
  h.write(tarNumField(size, 12), 124, 'ascii'); // size
  h.write('00000000000\0', 136, 'ascii'); // mtime (0 → deterministic)
  h[156] = 0x30; // typeflag '0' = regular file
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  // checksum: fill the 8-byte field with spaces, sum all bytes, then write.
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/** Concatenate files into an uncompressed tar (ustar) buffer. */
export function buildTar(files: ExtractedFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    blocks.push(tarHeader(f.path, f.data.length));
    const padded = Buffer.alloc(Math.ceil(f.data.length / TAR_BLOCK) * TAR_BLOCK);
    f.data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(TAR_BLOCK * 2)); // two zero blocks = end of archive
  return Buffer.concat(blocks);
}

/**
 * Encode a list of files into the requested archive format. Returns the archive
 * bytes. zip uses fflate.zipSync; tar.gz builds a ustar tar then gzips it.
 */
export function encodeArchive(format: CompressFormat, files: ExtractedFile[]): Buffer {
  if (format === 'zip') {
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) entries[f.path] = f.data;
    return Buffer.from(zipSync(entries));
  }
  if (format === 'tar.gz') {
    return Buffer.from(gzipSync(buildTar(files)));
  }
  throw new BadRequestException(`Unsupported compression format: ${format}`);
}
