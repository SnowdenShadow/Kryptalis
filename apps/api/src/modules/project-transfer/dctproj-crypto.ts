import * as crypto from 'crypto';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';

/**
 * Crypto for the cross-install project transfer archive (`.dctproj`).
 *
 * Unlike the backup engine — which derives its key from the install's own
 * BACKUP_ENCRYPTION_KEY (and is therefore only decryptable by the SAME
 * install) — a `.dctproj` archive must be decryptable by a DIFFERENT
 * DockControl install. So the key is derived from a USER PASSPHRASE that the
 * operator types on BOTH ends:
 *
 *   key = scrypt(passphrase, salt, 32)            // 32-byte AES key
 *   envelope = [16 salt][12 iv][ciphertext][16 GCM tag]
 *
 * A fresh random salt+iv per call means the same passphrase never produces a
 * reused (key, iv) pair across files. AES-256-GCM authenticates the data, so
 * a wrong passphrase OR any tampering fails the tag check on decrypt — we
 * surface that as one clear error.
 *
 * These functions are intentionally pure (no Nest deps) so they unit-test
 * without a DB or a running app.
 */

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
// scrypt cost params. N=2^15 is a sane interactive default (~tens of ms);
// r/p left at the Node defaults. Stored implicitly by being fixed here — the
// archive format is versioned, so changing these means a v2.
const SCRYPT_N = 1 << 15;
const SCRYPT_OPTS: crypto.ScryptOptions = { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase || passphrase.length === 0) {
    throw new Error('A passphrase is required to encrypt or decrypt a project archive.');
  }
  return crypto.scryptSync(passphrase, salt, KEY_LEN, SCRYPT_OPTS);
}

/** Encrypt an in-memory buffer (small payloads like the manifest). */
export function encryptBuffer(plain: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, body, tag]);
}

/** Decrypt a buffer produced by {@link encryptBuffer}. Throws on wrong
 *  passphrase or tampering (GCM tag mismatch). */
export function decryptBuffer(envelope: Buffer, passphrase: string): Buffer {
  if (envelope.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('Archive payload is too short to be a valid encrypted envelope.');
  }
  const salt = envelope.subarray(0, SALT_LEN);
  const iv = envelope.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = envelope.subarray(envelope.length - TAG_LEN);
  const body = envelope.subarray(SALT_LEN + IV_LEN, envelope.length - TAG_LEN);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase or corrupted archive.');
  }
}

/**
 * Encrypt a file on disk to `outPath`, streaming (never holds the whole file
 * in memory). Output layout matches {@link encryptBuffer}:
 *   [16 salt][12 iv][ciphertext...][16 tag]
 */
export async function encryptFileTo(inPath: string, outPath: string, passphrase: string): Promise<void> {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const out = fs.createWriteStream(outPath);
  out.write(salt);
  out.write(iv);
  // Stream body through the cipher but keep the stream open so we can append
  // the auth tag after the ciphertext.
  await pipeline(fs.createReadStream(inPath), cipher, out, { end: false });
  const tag = cipher.getAuthTag();
  await new Promise<void>((resolve, reject) => {
    out.end(tag, () => resolve());
    out.once('error', reject);
  });
}

/**
 * Decrypt a file produced by {@link encryptFileTo} to `outPath`, streaming.
 * Throws on wrong passphrase / tampering.
 */
export async function decryptFileTo(inPath: string, outPath: string, passphrase: string): Promise<void> {
  const stat = await fs.promises.stat(inPath);
  if (stat.size < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('Archive file is too short to be a valid encrypted envelope.');
  }
  const fd = await fs.promises.open(inPath, 'r');
  // Decrypt to a temp file and only promote it to outPath AFTER the GCM tag is
  // verified (decipher.final passes). GCM emits real plaintext as it streams,
  // so writing straight to outPath would leave authentic plaintext on disk for
  // a tampered-but-correct-key input even though the tag check later throws.
  const tmpOut = `${outPath}.part`;
  try {
    const header = Buffer.alloc(SALT_LEN + IV_LEN);
    await fd.read(header, 0, SALT_LEN + IV_LEN, 0);
    const salt = header.subarray(0, SALT_LEN);
    const iv = header.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = Buffer.alloc(TAG_LEN);
    await fd.read(tag, 0, TAG_LEN, stat.size - TAG_LEN);

    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const bodyStart = SALT_LEN + IV_LEN;
    const bodyEnd = stat.size - TAG_LEN; // exclusive
    try {
      if (bodyEnd > bodyStart) {
        await pipeline(fs.createReadStream(inPath, { start: bodyStart, end: bodyEnd - 1 }), decipher, fs.createWriteStream(tmpOut));
      } else {
        // Empty-body archive: still verify the tag (final throws on mismatch),
        // then write an empty output. Avoids a raw ERR_OUT_OF_RANGE from an
        // inverted read range.
        decipher.final();
        await fs.promises.writeFile(tmpOut, Buffer.alloc(0));
      }
    } catch {
      await fs.promises.unlink(tmpOut).catch(() => undefined);
      throw new Error('Wrong passphrase or corrupted archive.');
    }
    // Tag verified — promote the temp file to the real output atomically.
    if (process.platform === 'win32') {
      await fs.promises.unlink(outPath).catch(() => undefined);
    }
    await fs.promises.rename(tmpOut, outPath);
  } finally {
    await fd.close();
    await fs.promises.unlink(tmpOut).catch(() => undefined);
  }
}

/** Streaming SHA-256 of a file (hex). Mirrors backups.service.sha256File. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** SHA-256 of a buffer (hex). */
export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
