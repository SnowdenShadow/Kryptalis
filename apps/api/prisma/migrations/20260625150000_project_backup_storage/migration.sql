-- Per-project remote backup storage: each project can bring its own
-- S3-compatible bucket. The secret key is stored AES-256-GCM encrypted.
CREATE TABLE "project_backup_storage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "target" "BackupTarget" NOT NULL,
    "endpoint" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "region" TEXT,
    "accessKey" TEXT NOT NULL,
    "secretKeyEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_backup_storage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_backup_storage_projectId_key" ON "project_backup_storage"("projectId");

ALTER TABLE "project_backup_storage" ADD CONSTRAINT "project_backup_storage_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
