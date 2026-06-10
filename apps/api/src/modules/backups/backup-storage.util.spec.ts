import { describe, it, expect } from 'vitest';
import {
  backupS3Prefix,
  buildS3Key,
  isRemoteTarget,
  missingS3ConfigKeys,
} from './backup-storage.util';

describe('backup-storage.util', () => {
  describe('isRemoteTarget (flow selection)', () => {
    it('treats S3/R2/B2 as remote and LOCAL/empty as not', () => {
      expect(isRemoteTarget('S3')).toBe(true);
      expect(isRemoteTarget('R2')).toBe(true);
      expect(isRemoteTarget('B2')).toBe(true);
      expect(isRemoteTarget('LOCAL')).toBe(false);
      expect(isRemoteTarget(undefined)).toBe(false);
      expect(isRemoteTarget(null)).toBe(false);
      expect(isRemoteTarget('s3')).toBe(false); // case-sensitive enum values
    });
  });

  describe('buildS3Key', () => {
    it('builds kryptalis-backups/<id>/<filename> from a plain filename', () => {
      expect(buildS3Key('ckabc123', 'dump.sql.gz')).toBe(
        'kryptalis-backups/ckabc123/dump.sql.gz',
      );
    });

    it('keeps only the basename of full paths (posix and windows)', () => {
      expect(buildS3Key('id1', '/var/backups/db/dump.sql')).toBe(
        'kryptalis-backups/id1/dump.sql',
      );
      expect(buildS3Key('id1', 'C:\\backups\\dump.sql')).toBe(
        'kryptalis-backups/id1/dump.sql',
      );
    });

    it('sanitizes hostile filenames so they cannot escape the prefix', () => {
      const key = buildS3Key('id1', '../../etc/passwd');
      expect(key.startsWith(backupS3Prefix('id1'))).toBe(true);
      expect(key).toBe('kryptalis-backups/id1/passwd');
      // Weird chars are flattened, never empty.
      expect(buildS3Key('id1', '??? ***')).toBe('kryptalis-backups/id1/_______');
      expect(buildS3Key('id1', '')).toBe('kryptalis-backups/id1/backup.dump');
    });
  });

  describe('missingS3ConfigKeys', () => {
    const full = {
      endpoint: 'https://acc.r2.cloudflarestorage.com',
      bucket: 'backups',
      region: 'auto',
      accessKey: 'AKIA',
      secretKey: 'shh',
    };

    it('returns [] when everything required is set (region optional)', () => {
      expect(missingS3ConfigKeys(full)).toEqual([]);
      expect(missingS3ConfigKeys({ ...full, region: undefined })).toEqual([]);
    });

    it('lists every missing/blank required key by its setting name', () => {
      expect(missingS3ConfigKeys({})).toEqual([
        's3_endpoint',
        's3_bucket',
        's3_access_key',
        's3_secret_key',
      ]);
      expect(missingS3ConfigKeys({ ...full, secretKey: '   ' })).toEqual(['s3_secret_key']);
      expect(missingS3ConfigKeys({ ...full, endpoint: '' })).toEqual(['s3_endpoint']);
    });
  });
});
