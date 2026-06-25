import { BackupStatus, BackupTarget } from './enums';

export interface CreateBackupRequest {
  name: string;
  serverId: string;
  /** Scope the backup to one project (its apps + DBs + volumes). Omit for a
   *  whole-server backup. */
  projectId?: string;
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
  /** Project this backup is scoped to (null = whole server). */
  projectId?: string | null;
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
  /** On-disk archive filename (null for rows predating the column / never-run jobs). */
  filename?: string | null;
  includeApplications: boolean;
  includeDatabases: boolean;
  includeVolumes: boolean;
  schedule: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

/**
 * POST /backups/:id/restore — two shapes depending on where the backup's
 * server lives:
 *   - local server  → synchronous restore: `databasesRestored` /
 *     `volumesRestored` counters, message "Restore completed.".
 *   - remote server → the archive is staged and a RESTORE task is enqueued
 *     on the agent: `taskId` + `databasesQueued` / `volumesQueued`, message
 *     contains "queued".
 * Discriminate on the presence of `databasesRestored` vs `databasesQueued`.
 */
export interface RestoreBackupLocalResponse {
  message: string;
  backupId: string;
  databasesRestored: number;
  volumesRestored: number;
}

export interface RestoreBackupQueuedResponse {
  message: string;
  backupId: string;
  taskId: string;
  databasesQueued: number;
  volumesQueued: number;
}

export type RestoreBackupResponse =
  | RestoreBackupLocalResponse
  | RestoreBackupQueuedResponse;
