import {
  Injectable,
  OnModuleInit,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';

/**
 * Runtime configuration store.
 *
 * Philosophy: `.env` only carries bootstrap secrets (DATABASE_URL,
 * JWT_SECRET, ENCRYPTION_KEY). Everything operational — SMTP creds,
 * public URLs, retention windows, alert dispatch URLs, registration
 * toggle — is editable from the Admin UI and persisted in the DB
 * (SystemSetting). No SSH-and-edit-.env workflow.
 *
 * Resolution order on read:
 *   1. SystemSetting row (DB) — the authoritative answer when set.
 *   2. process.env (fallback) — for legacy installs that pre-date the
 *      Admin UI, and for the bootstrap-secret minimum.
 *   3. Built-in default.
 *
 * Secrets (SMTP_PASS, BACKUP_ENCRYPTION_KEY, etc.) are persisted via
 * the encryption envelope `{ __sec: 1, v: '<aes-256-gcm-blob>' }` so a
 * DB dump doesn't expose them in plaintext.
 *
 * Listeners can subscribe to `onChange()` to react to live updates (the
 * notifications service re-creates its SMTP transport, the monitoring
 * service refreshes intervals, etc.) — no API restart required.
 */
@Injectable()
export class SystemConfigService implements OnModuleInit {
  private readonly logger = new Logger(SystemConfigService.name);
  private cache = new Map<string, any>();
  private readonly listeners = new Set<(keys: string[]) => void>();

  // Keys that are persisted encrypted because they contain credentials
  // or other sensitive material. Reads transparently decrypt; writes
  // transparently encrypt.
  private readonly SECRET_KEYS = new Set([
    'smtp_pass',
    'backup_encryption_key',
    'github_webhook_secret',
    's3_secret_key',
  ]);

  // URL-shaped keys must parse as an http(s) URL when set. Empty/unset is
  // allowed — it reverts to the env fallback / default.
  private readonly URL_KEYS = new Set([
    'public_api_url',
    'public_dashboard_url',
  ]);

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  /**
   * Validate a security-critical setting before it is persisted. This store
   * OUTRANKS the Joi-validated env, so without this an admin could silently
   * weaken security from the UI (e.g. a 4-char backup key, or a malformed
   * public URL that breaks every generated link). Throws BadRequestException
   * with a clear message so the admin UI surfaces it instead of accepting
   * the bad value. Empty values are allowed (they revert to env/default).
   */
  private validateKey(key: string, value: any): void {
    if (value === null || value === undefined || value === '') return;
    if (key === 'backup_encryption_key') {
      const s = typeof value === 'string' ? value : String(value);
      if (s.length < 32) {
        throw new BadRequestException(
          'backup_encryption_key must be at least 32 characters.',
        );
      }
      return;
    }
    if (this.URL_KEYS.has(key)) {
      const s = typeof value === 'string' ? value : String(value);
      let url: URL;
      try {
        url = new URL(s);
      } catch {
        throw new BadRequestException(`${key} must be a valid URL.`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new BadRequestException(`${key} must be an http(s) URL.`);
      }
    }
  }

  async onModuleInit() {
    await this.reload();
  }

  /** Reload every SystemSetting row into the in-memory cache. */
  async reload() {
    const rows = await this.prisma.systemSetting.findMany();
    this.cache.clear();
    for (const r of rows) this.cache.set(r.key, this.decodeIfSecret(r.key, r.value));
  }

  /** Subscribe to setting updates. Returns an unsubscribe fn. */
  onChange(fn: (keys: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Get a setting. DB wins over env. If neither set, returns the default.
   * The `envFallback` arg names the corresponding process.env key — pass
   * '' (or omit) for DB-only settings.
   */
  get<T = string>(key: string, envFallback?: string, defaultValue?: T): T | undefined {
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      if (v !== null && v !== undefined && v !== '') return v as T;
    }
    if (envFallback && process.env[envFallback] !== undefined && process.env[envFallback] !== '') {
      return process.env[envFallback] as unknown as T;
    }
    return defaultValue;
  }

  /** Number coercion convenience. */
  getNumber(key: string, envFallback?: string, defaultValue?: number): number | undefined {
    const raw = this.get<any>(key, envFallback, defaultValue as any);
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    return Number.isFinite(n) ? n : defaultValue;
  }

  /** Boolean coercion (treats "false"/"0"/"" as false). */
  getBool(key: string, envFallback?: string, defaultValue = false): boolean {
    const raw = this.get<any>(key, envFallback);
    if (raw === undefined || raw === null) return defaultValue;
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase().trim();
    return !(s === '' || s === 'false' || s === '0' || s === 'no');
  }

  /**
   * Persist a setting. `actorId` is recorded on the row. After a successful
   * write the in-memory cache is updated and listeners are notified so
   * services can pick up the new value without an API restart.
   */
  async set(key: string, value: any, actorId?: string): Promise<void> {
    this.validateKey(key, value);
    const stored = this.SECRET_KEYS.has(key) ? this.encodeSecret(value) : value;
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: stored as any, updatedBy: actorId },
      update: { value: stored as any, updatedBy: actorId },
    });
    this.cache.set(key, value);
    for (const fn of this.listeners) {
      try { fn([key]); } catch {}
    }
  }

  /** Bulk update — single change-notification with the full list. */
  async setMany(updates: Record<string, any>, actorId?: string): Promise<void> {
    // Validate everything BEFORE any write so a single bad key rejects the
    // whole batch rather than half-applying it.
    for (const [k, v] of Object.entries(updates)) this.validateKey(k, v);
    const ops = Object.entries(updates).map(([k, v]) => {
      const stored = this.SECRET_KEYS.has(k) ? this.encodeSecret(v) : v;
      return this.prisma.systemSetting.upsert({
        where: { key: k },
        create: { key: k, value: stored as any, updatedBy: actorId },
        update: { value: stored as any, updatedBy: actorId },
      });
    });
    await Promise.all(ops);
    for (const [k, v] of Object.entries(updates)) this.cache.set(k, v);
    for (const fn of this.listeners) {
      try { fn(Object.keys(updates)); } catch {}
    }
  }

  /** Delete a setting (reverts to env fallback / default). */
  async unset(key: string): Promise<void> {
    await this.prisma.systemSetting.delete({ where: { key } }).catch(() => undefined);
    this.cache.delete(key);
    for (const fn of this.listeners) {
      try { fn([key]); } catch {}
    }
  }

  /**
   * Return the full settings snapshot for the Admin UI. Secret values
   * are masked (returns true/false to signal "is set") so they never
   * leave the API plaintext to the browser. The frontend writes
   * replacements blindly when the user types something new.
   */
  async getPublicSnapshot(): Promise<Record<string, any>> {
    const rows = await this.prisma.systemSetting.findMany();
    const out: Record<string, any> = {};
    for (const r of rows) {
      if (this.SECRET_KEYS.has(r.key)) {
        // True iff a non-empty value is stored.
        const v = this.decodeIfSecret(r.key, r.value);
        out[r.key] = typeof v === 'string' ? v.length > 0 : !!v;
      } else {
        out[r.key] = r.value;
      }
    }
    return out;
  }

  // ── secret envelope ──────────────────────────────────────────────

  private encodeSecret(value: any): any {
    if (value === null || value === undefined || value === '') return value;
    const plain = typeof value === 'string' ? value : JSON.stringify(value);
    return { __sec: 1, v: this.encryption.encrypt(plain) };
  }

  private decodeIfSecret(key: string, stored: any): any {
    if (!this.SECRET_KEYS.has(key)) return stored;
    if (stored && typeof stored === 'object' && (stored as any).__sec === 1 && typeof (stored as any).v === 'string') {
      try {
        return this.encryption.decrypt((stored as any).v);
      } catch {
        this.logger.error(`Failed to decrypt secret config "${key}"`);
        return undefined;
      }
    }
    // Legacy plaintext value — return as-is, will be re-encrypted on next set().
    return stored;
  }
}
