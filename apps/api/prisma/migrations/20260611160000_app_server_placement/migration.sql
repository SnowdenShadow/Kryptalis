-- Per-app server placement: NULL = inherit the project's server (default).
-- Lets apps in the same project run on different machines.
ALTER TABLE "applications" ADD COLUMN "serverId" TEXT;
ALTER TABLE "applications" ADD CONSTRAINT "applications_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "applications_serverId_idx" ON "applications"("serverId");
