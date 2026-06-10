import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { assertAppOwnership } from './applications.helpers';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Env-var concerns for applications: at-rest encryption of the envVars
 * JSON blob, .env file (de)serialization, repo .env discovery, and the
 * get/set endpoints' logic. Split out of ApplicationsService.
 */
@Injectable()
export class ApplicationEnvService {
  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  // ── env vars ───────────────────────────────────────────────────────

  async getEnv(userId: string, id: string) {
    const app = await assertAppOwnership(this.prisma, userId, id);
    return { envVars: this.decryptEnvVars(app.envVars) };
  }

  async setEnv(userId: string, id: string, envVars: Record<string, string>) {
    await assertAppOwnership(this.prisma, userId, id);
    if (!envVars || typeof envVars !== 'object') {
      throw new BadRequestException('envVars required');
    }
    return this.prisma.application.update({
      where: { id },
      data: { envVars: this.encryptEnvVars(envVars) as any },
    });
  }

  // ── envVars at-rest encryption ────────────────────────────────────
  //
  // App env vars routinely carry production secrets (DATABASE_URL, JWT
  // SECRETs, third-party API keys, etc.). We persist the JSON blob as
  // `{ __k: 1, v: '<encrypted-utf8>' }` so the read path can detect the
  // wrapper and decrypt, while legacy plaintext rows are still readable
  // (they don't have __k).
  encryptEnvVars(envVars: Record<string, string> | null | undefined): any {
    if (!envVars || Object.keys(envVars).length === 0) return envVars;
    return { __k: 1, v: this.encryption.encrypt(JSON.stringify(envVars)) };
  }

  decryptEnvVars(raw: any): Record<string, string> {
    if (!raw) return {};
    if (typeof raw === 'object' && (raw as any).__k === 1 && typeof (raw as any).v === 'string') {
      try {
        return JSON.parse(this.encryption.decrypt((raw as any).v));
      } catch {
        return {};
      }
    }
    // Legacy plaintext shape: { KEY: VALUE, ... }
    return raw as Record<string, string>;
  }

  serializeEnv(env: Record<string, string>) {
    return Object.entries(env)
      .map(([k, v]) => {
        const safe = String(v).replace(/\n/g, '\\n');
        return `${k}=${safe}`;
      })
      .join('\n');
  }

  // priority (lowest → highest): .env.example → .env.production → .env → .env.local
  // user-supplied envVars wins over everything (merged by the caller).
  loadRepoEnvFiles(appDir: string): Record<string, string> {
    const ordered = ['.env.example', '.env.local.example', '.env.production', '.env', '.env.local'];
    const out: Record<string, string> = {};
    for (const name of ordered) {
      const p = path.join(appDir, name);
      if (!fs.existsSync(p)) continue;
      try {
        const text = fs.readFileSync(p, 'utf-8');
        for (const raw of text.split('\n')) {
          const line = raw.replace(/\r$/, '');
          if (!line || line.startsWith('#')) continue;
          const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (!m) continue;
          let val = m[2].trim();
          // strip surrounding quotes
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          // strip trailing inline comment for unquoted values
          if (!m[2].startsWith('"') && !m[2].startsWith("'")) {
            const hash = val.indexOf(' #');
            if (hash !== -1) val = val.slice(0, hash).trimEnd();
          }
          // unescape \n only for double-quoted (already stripped) — best effort
          val = val.replace(/\\n/g, '\n');
          out[m[1]] = val;
        }
      } catch {}
    }
    return out;
  }
}
