import { BackupStatus, BackupTarget } from './enums';

export interface CreateBackupRequest {
  name: string;
  serverId: string;
  target: BackupTarget;
  includeApplications?: boolean;
  includeDatabases?: boolean;
  includeVolumes?: boolean;
  schedule?: string;
}

/**
 * Backup as returned by GET /backups (plain Prisma rows — no relations).
 * BigInt columns (size, sizeBytes) serialize as decimal strings.
 */
export interface BackupResponse {
  id: string;
  name: string;
  serverId: string;
  target: `${BackupTarget}`;
  status: `${BackupStatus}`;
  /** Legacy size field (bytes, decimal string). */
  size: string | null;
  /** Final on-disk size in bytes (decimal string) — matches sha256. */
  sizeBytes: string | null;
  /** sha256 of the final on-disk dump (post-encryption when encryptedAt). */
  sha256: string | null;
  /** True when the dump is AES-256-GCM encrypted at rest. */
  encryptedAt: boolean;
  includeApplications: boolean;
  includeDatabases: boolean;
  includeVolumes: boolean;
  schedule: string | null;
  lastRunAt: string | null;
  createdAt: string;
}
