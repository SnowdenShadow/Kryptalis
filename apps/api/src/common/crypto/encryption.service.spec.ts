import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { EncryptionService } from './encryption.service';

// A fixed per-install salt so tests are deterministic without touching disk.
function makeService(key = 'a'.repeat(32), saltHex = 'b'.repeat(32)): EncryptionService {
  const config = {
    get: (name: string) =>
      name === 'ENCRYPTION_SALT_HEX' ? saltHex : name === 'ENCRYPTION_KEY' ? key : undefined,
  } as any;
  const svc = new EncryptionService(config);
  svc.onModuleInit();
  return svc;
}

describe('EncryptionService', () => {
  let svc: EncryptionService;

  beforeEach(() => {
    svc = makeService();
  });

  it('round-trips encrypt/decrypt and emits v2', () => {
    const plain = 'super-secret token with unicode é€';
    const enc = svc.encrypt(plain);
    expect(enc).not.toBe(plain);
    expect(enc.startsWith('v2.')).toBe(true);
    expect(svc.decrypt(enc)).toBe(plain);
  });

  it('still decrypts legacy v1 blobs (constant-salt key) — M-5 backward-compat', () => {
    // Build a v1 blob the way the OLD service did: key = scrypt(KEY, 'dockcontrol-v1').
    const crypto = require('crypto') as typeof import('crypto');
    const KEY = 'a'.repeat(32);
    const legacyKey = crypto.scryptSync(KEY, Buffer.from('dockcontrol-v1'), 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
    const ct = Buffer.concat([cipher.update('legacy-secret', 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const v1 = ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');

    // A v2 service (different salt) must still decrypt the v1 blob via legacyKey.
    expect(svc.decrypt(v1)).toBe('legacy-secret');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(svc.encrypt('x')).not.toBe(svc.encrypt('x'));
  });

  it('returns legacy plaintext as-is on decrypt (no v1/v2 prefix)', () => {
    expect(svc.decrypt('legacy-plaintext')).toBe('legacy-plaintext');
  });

  it('passes through empty/null values on encrypt and decrypt', () => {
    expect(svc.encrypt('')).toBe('');
    expect(svc.encrypt(null)).toBeNull();
    expect(svc.decrypt('')).toBe('');
    expect(svc.decrypt(undefined)).toBeUndefined();
  });

  it('throws on malformed v2 payload', () => {
    expect(() => svc.decrypt('v2.only-one-part')).toThrow('Malformed encrypted payload.');
  });

  it('fails to decrypt with a different key', () => {
    const enc = svc.encrypt('secret');
    const other = makeService('b'.repeat(32));
    expect(() => other.decrypt(enc)).toThrow();
  });

  it('hash is stable, hex-encoded sha256', () => {
    const h1 = svc.hash('token');
    const h2 = svc.hash('token');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.hash('other')).not.toBe(h1);
  });

  it('rejects a missing or short ENCRYPTION_KEY at init', () => {
    expect(() => makeService('short')).toThrow(/ENCRYPTION_KEY/);
    const svc2 = new EncryptionService({ get: () => undefined } as any);
    expect(() => svc2.onModuleInit()).toThrow(/ENCRYPTION_KEY/);
  });
});
