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
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/** Hard ceiling on entries in one archive (defence against archive-of-many-files). */
export const MAX_ZIP_ENTRIES = 50_000;

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
