import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../paths';

/**
 * Symmetric encryption at rest for sensitive columns (git provider tokens,
 * DKIM private keys, tenant DB passwords, app webhook HMAC secrets, TOTP
 * secrets, etc.).
 *
 * Algorithm: AES-256-GCM with a per-blob random 12-byte IV and 16-byte tag.
 *
 * Key derivation (M-5): scrypt(ENCRYPTION_KEY, salt, 32). The salt is now a
 * per-install random 16 bytes persisted to DATA_DIR/encryption-salt, instead
 * of the old hardcoded 'dockcontrol-v1' shared by every deployment. A constant
 * salt meant identical ENCRYPTION_KEYs produced identical derived keys and let
 * a precomputation attack against weak keys be shared across all installs.
 *
 * Storage layout (base64-url), versioned so we can decrypt old blobs:
 *   v2.<iv>.<tag>.<ct>   ← current; key from the per-install salt
 *   v1.<iv>.<tag>.<ct>   ← legacy; key from the constant 'dockcontrol-v1' salt
 * Plain strings with no prefix are legacy plaintext: decrypt() returns them
 * as-is and the column is re-encrypted (as v2) on next write.
 *
 * Both keys are derived ONCE at init (scrypt is expensive), so per-call cost is
 * unchanged. Old v1 blobs keep decrypting; everything new is v2.
 *
 * SECURITY: ENCRYPTION_KEY MUST be at least 32 chars and stable across
 * restarts. The salt file must also persist (it lives under DATA_DIR, which is
 * already the durable state volume) — losing it makes v2 blobs undecryptable.
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger(EncryptionService.name);
  /** Current key (per-install salt) — used for encrypt() and v2 decrypt. */
  private key!: Buffer;
  /** Legacy key (constant salt) — decrypt-only, for pre-M-5 v1 blobs. */
  private legacyKey!: Buffer;
  private static LEGACY_SALT = Buffer.from('dockcontrol-v1');
  private static SALT_FILE = path.join(DATA_DIR, 'encryption-salt');

  constructor(private config: ConfigService) {}

  onModuleInit() {
    const raw = this.config.get<string>('ENCRYPTION_KEY');
    if (!raw || raw.length < 32) {
      throw new Error(
        'ENCRYPTION_KEY must be set and at least 32 characters long. ' +
          'It encrypts sensitive columns at rest — losing/rotating it will lock you out of git providers, DKIM, etc.',
      );
    }
    const salt = this.loadOrCreateSalt();
    this.key = crypto.scryptSync(raw, salt, 32);
    this.legacyKey = crypto.scryptSync(raw, EncryptionService.LEGACY_SALT, 32);
    this.logger.log('Encryption service ready (AES-256-GCM, per-install salt)');
  }

  /**
   * Load the per-install KDF salt, creating it on first boot. Persisted 0600
   * under DATA_DIR. An ENCRYPTION_SALT_HEX env var overrides the file (for
   * operators who manage the salt out-of-band / want it identical across a
   * replica set). Falls back to the legacy constant salt if the directory is
   * somehow unwritable, so the service still starts (logs a warning).
   */
  private loadOrCreateSalt(): Buffer {
    const fromEnv = this.config.get<string>('ENCRYPTION_SALT_HEX');
    if (fromEnv && /^[0-9a-f]{32,}$/i.test(fromEnv)) {
      return Buffer.from(fromEnv, 'hex');
    }
    try {
      const existing = fs.readFileSync(EncryptionService.SALT_FILE);
      if (existing.length >= 16) return existing;
    } catch {
      // not created yet — fall through to create
    }
    try {
      const salt = crypto.randomBytes(16);
      fs.mkdirSync(path.dirname(EncryptionService.SALT_FILE), { recursive: true });
      fs.writeFileSync(EncryptionService.SALT_FILE, salt, { mode: 0o600 });
      this.logger.log('Generated a per-install encryption salt.');
      return salt;
    } catch (err) {
      this.logger.warn(
        `Could not persist a per-install encryption salt (${(err as Error).message}); ` +
          'falling back to the legacy constant salt. Set ENCRYPTION_SALT_HEX or make DATA_DIR writable.',
      );
      return EncryptionService.LEGACY_SALT;
    }
  }

  /**
   * Encrypt arbitrary UTF-8 text. Empty/null/undefined returns as-is so callers
   * can write `enc.encrypt(maybeEmpty)` without a guard.
   *
   * Overloaded so the return type tells the truth: a definite string in yields
   * a string out (the common case, no caller changes needed), but a possibly
   * null/undefined input yields a possibly null/undefined output — TypeScript
   * then forces those callers to null-check before chaining string operations,
   * instead of silently trusting a `: string` annotation that lies at runtime.
   */
  encrypt<T extends string | null | undefined>(plaintext: T): T extends string ? string : T;
  encrypt(plaintext: string | null | undefined): string | null | undefined {
    if (plaintext == null || plaintext === '') return plaintext;
    const iv = crypto.randomBytes(12);
    // Emit v2 (per-install salt). v1 (constant salt) is decrypt-only.
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v2',
      iv.toString('base64url'),
      tag.toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  }

  /**
   * Decrypt a payload previously produced by encrypt(). Routes by version
   * prefix: v2 uses the per-install-salt key, v1 the legacy constant-salt key.
   * Anything without a known prefix is treated as legacy plaintext and returned
   * as-is (re-encrypted as v2 on next write).
   *
   * Overloaded for the same reason as encrypt(): null/undefined in → same out,
   * so callers passing a nullable DB column are forced to null-check the result.
   */
  decrypt<T extends string | null | undefined>(payload: T): T extends string ? string : T;
  decrypt(payload: string | null | undefined): string | null | undefined {
    if (payload == null || payload === '') return payload;
    const isV2 = payload.startsWith('v2.');
    const isV1 = payload.startsWith('v1.');
    if (!isV2 && !isV1) return payload; // legacy plaintext
    const [, ivB64, tagB64, ctB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error('Malformed encrypted payload.');
    }
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const ct = Buffer.from(ctB64, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', isV2 ? this.key : this.legacyKey, iv);
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
}
