-- Track DBs created by the compose / marketplace auto-importer separately
-- from DBs the user provisioned via /databases. Lets the dashboard render
-- a clear "managed by app" badge and lets the API decide which lifecycle
-- ops are valid (auto-imported = read-only from the /databases dialog).
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "autoImported" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "serviceName" TEXT;

-- Idempotency for redeploys: a given app can only have one Database row per
-- compose service name. On redeploy we upsert against this key instead of
-- inserting duplicates each time.
CREATE UNIQUE INDEX IF NOT EXISTS "databases_applicationId_serviceName_key"
  ON "databases" ("applicationId", "serviceName")
  WHERE "applicationId" IS NOT NULL AND "serviceName" IS NOT NULL;
