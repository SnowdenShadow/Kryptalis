-- Pin the exact remote storage coordinate onto each remote backup row.
-- Encrypted JSON (endpoint/bucket/region/accessKey/secretKey) captured at
-- finalize time so restore/delete always target the bucket the dump was
-- actually written to — independent of later project storage config changes.
ALTER TABLE "backups" ADD COLUMN "storageConfigEnc" TEXT;
