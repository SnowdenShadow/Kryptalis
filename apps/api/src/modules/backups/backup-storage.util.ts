/**
 * Pure helpers for the remote (S3-compatible) backup storage flow.
 *
 * Kept free of any I/O or Nest dependency so they can be unit-tested
 * directly and reused by both the service and future job runners.
 *
 * Key layout in the bucket:
 *   kryptalis-backups/<backupId>/<filename>
 *
 * The Backup model has no path column, so the remote location is fully
 * deterministic from the row id: restore/delete resolve the exact object
 * by listing the `kryptalis-backups/<backupId>/` prefix.
 */

/** Targets that store the dump in an S3-compatible bucket. */
export const REMOTE_TARGETS = ['S3', 'R2', 'B2'] as const;

export type RemoteTarget = (typeof REMOTE_TARGETS)[number];

export function isRemoteTarget(target: string | null | undefined): target is RemoteTarget {
  return !!target && (REMOTE_TARGETS as readonly string[]).includes(target);
}

/** Bucket prefix that holds every object belonging to one backup row. */
export function backupS3Prefix(backupId: string): string {
  return `kryptalis-backups/${backupId}/`;
}

/**
 * Object key for a backup dump. The filename is reduced to its basename
 * and sanitized so a hostile/odd local path can never escape the
 * per-backup prefix or produce an invalid key.
 */
export function buildS3Key(backupId: string, filename: string): string {
  const base = filename.split(/[\\/]/).pop() || 'backup.dump';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${backupS3Prefix(backupId)}${safe || 'backup.dump'}`;
}

export interface S3BackupConfig {
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
}

/**
 * Returns the list of missing required settings (admin-facing key names).
 * Empty array == S3 storage is usable. `region` is optional (defaults to
 * 'auto', which R2/B2/MinIO accept).
 */
export function missingS3ConfigKeys(cfg: S3BackupConfig): string[] {
  const missing: string[] = [];
  if (!cfg.endpoint?.trim()) missing.push('s3_endpoint');
  if (!cfg.bucket?.trim()) missing.push('s3_bucket');
  if (!cfg.accessKey?.trim()) missing.push('s3_access_key');
  if (!cfg.secretKey?.trim()) missing.push('s3_secret_key');
  return missing;
}
