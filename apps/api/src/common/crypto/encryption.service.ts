import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Symmetric encryption at rest for sensitive columns (git provider tokens,
 * DKIM private keys, tenant DB passwords, app webhook HMAC secrets, TOTP
 * secrets, etc.).
 *
 * Algorithm: AES-256-GCM with a per-blob random 12-byte IV and 16-byte tag.
 * Key derivation: scrypt(ENCRYPTION_KEY, salt='dockcontrol-v1', 32 bytes).
 * Storage layout (base64-url):
 *   v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 *
 * The 'v1' prefix lets us rotate algorithms later without ambiguity. Plain
 * strings with no prefix are treated as legacy plaintext for backward-compat:
 * the decrypt helper returns them as-is and the column gets re-encrypted on
 * next write.
 *
 * SECURITY: ENCRYPTION_KEY MUST be at least 32 chars and stable across
 * restarts (rotating the key without re-encrypting kills every encrypted
 * column). Validated at bootstrap.
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger(EncryptionService.name);
  private key!: Buffer;
  private static SALT = Buffer.from('dockcontrol-v1');

  constructor(private config: ConfigService) {}

  onModuleInit() {
    const raw = this.config.get<string>('ENCRYPTION_KEY');
    if (!raw || raw.length < 32) {
      throw new Error(
        'ENCRYPTION_KEY must be set and at least 32 characters long. ' +
          'It encrypts sensitive columns at rest — losing/rotating it will lock you out of git providers, DKIM, etc.',
      );
    }
    this.key = crypto.scryptSync(raw, EncryptionService.SALT, 32);
    this.logger.log('Encryption service ready (AES-256-GCM)');
  }

  /**
   * Encrypt arbitrary UTF-8 text. Empty/null returns as-is so callers can
   * write `enc.encrypt(maybeEmpty)` without a guard.
   */
  encrypt(plaintext: string | null | undefined): string {
    if (plaintext == null || plaintext === '') return plaintext as string;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  }

  /**
   * Decrypt a payload previously produced by encrypt(). For backward-compat
   * with legacy plaintext columns, anything that doesn't match the v1 prefix
   * is returned as-is. (A migration job should iterate rows and re-encrypt.)
   */
  decrypt(payload: string | null | undefined): string {
    if (payload == null || payload === '') return payload as string;
    if (!payload.startsWith('v1.')) return payload; // legacy plaintext
    const [, ivB64, tagB64, ctB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error('Malformed encrypted payload.');
    }
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const ct = Buffer.from(ctB64, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf-8');
  }

  /**
   * Sha256 a string and return hex. Used for refresh-token storage,
   * password-reset token lookup, etc. Non-reversible by design.
   */
  hash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  /**
   * Constant-time equality. Avoids timing oracles when comparing
   * user-supplied tokens to stored hashes.
   */
  timingSafeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }
}
