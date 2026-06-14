import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  encryptBuffer,
  decryptBuffer,
  encryptFileTo,
  decryptFileTo,
  sha256File,
  sha256Buffer,
} from './dctproj-crypto';

const PASS = 'correct-horse-battery-staple';
const tmpFiles: string[] = [];
function tmp(name: string): string {
  const p = path.join(os.tmpdir(), `dctproj-test-${crypto.randomBytes(6).toString('hex')}-${name}`);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

describe('dctproj-crypto — buffer envelope', () => {
  it('round-trips a buffer with the right passphrase', () => {
    const plain = Buffer.from(JSON.stringify({ secret: 'value', n: 42 }));
    const env = encryptBuffer(plain, PASS);
    // envelope must be longer than plaintext (salt+iv+tag overhead) and differ
    expect(env.length).toBeGreaterThan(plain.length);
    expect(env.equals(plain)).toBe(false);
    const back = decryptBuffer(env, PASS);
    expect(back.equals(plain)).toBe(true);
  });

  it('rejects the WRONG passphrase', () => {
    const env = encryptBuffer(Buffer.from('hello'), PASS);
    expect(() => decryptBuffer(env, 'not-the-passphrase')).toThrow(/wrong passphrase or corrupted/i);
  });

  it('rejects a TAMPERED ciphertext (flipped byte)', () => {
    const env = encryptBuffer(Buffer.from('hello world'), PASS);
    // flip a byte in the ciphertext region (after 16 salt + 12 iv)
    env[30] = env[30] ^ 0xff;
    expect(() => decryptBuffer(env, PASS)).toThrow(/wrong passphrase or corrupted/i);
  });

  it('rejects an empty passphrase on encrypt and decrypt', () => {
    expect(() => encryptBuffer(Buffer.from('x'), '')).toThrow(/passphrase is required/i);
    const env = encryptBuffer(Buffer.from('x'), PASS);
    expect(() => decryptBuffer(env, '')).toThrow(/passphrase is required/i);
  });

  it('rejects a truncated envelope', () => {
    expect(() => decryptBuffer(Buffer.from('too-short'), PASS)).toThrow(/too short/i);
  });

  it('produces a different envelope each call (random salt/iv)', () => {
    const a = encryptBuffer(Buffer.from('same'), PASS);
    const b = encryptBuffer(Buffer.from('same'), PASS);
    expect(a.equals(b)).toBe(false);
  });
});

describe('dctproj-crypto — streaming file envelope', () => {
  it('round-trips a file with the right passphrase', async () => {
    const src = tmp('src.bin');
    const enc = tmp('enc.bin');
    const dec = tmp('dec.bin');
    const data = crypto.randomBytes(200_000); // > one chunk
    fs.writeFileSync(src, data);

    await encryptFileTo(src, enc, PASS);
    expect(fs.statSync(enc).size).toBeGreaterThan(fs.statSync(src).size);
    await decryptFileTo(enc, dec, PASS);
    expect(fs.readFileSync(dec).equals(data)).toBe(true);
  });

  it('file decrypt rejects the wrong passphrase', async () => {
    const src = tmp('src2.bin');
    const enc = tmp('enc2.bin');
    const dec = tmp('dec2.bin');
    fs.writeFileSync(src, crypto.randomBytes(50_000));
    await encryptFileTo(src, enc, PASS);
    await expect(decryptFileTo(enc, dec, 'wrong')).rejects.toThrow(/wrong passphrase or corrupted/i);
  });

  it('file decrypt rejects a tampered archive', async () => {
    const src = tmp('src3.bin');
    const enc = tmp('enc3.bin');
    const dec = tmp('dec3.bin');
    fs.writeFileSync(src, crypto.randomBytes(50_000));
    await encryptFileTo(src, enc, PASS);
    // flip a byte in the ciphertext body
    const buf = fs.readFileSync(enc);
    buf[100] = buf[100] ^ 0xff;
    fs.writeFileSync(enc, buf);
    await expect(decryptFileTo(enc, dec, PASS)).rejects.toThrow(/wrong passphrase or corrupted/i);
  });
});

describe('dctproj-crypto — sha256', () => {
  it('hashes a file and a buffer identically', async () => {
    const f = tmp('hash.bin');
    const data = Buffer.from('integrity check payload');
    fs.writeFileSync(f, data);
    const fileHash = await sha256File(f);
    const bufHash = sha256Buffer(data);
    expect(fileHash).toBe(bufHash);
    expect(fileHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
