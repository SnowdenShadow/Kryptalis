-- Project-scoped backups: a backup can target ONE project (its apps + DBs +
-- volumes) instead of the whole server. NULL = legacy server-wide backup.
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

ALTER TABLE "backups" ADD CONSTRAINT "backups_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "backups_projectId_idx" ON "backups"("projectId");
