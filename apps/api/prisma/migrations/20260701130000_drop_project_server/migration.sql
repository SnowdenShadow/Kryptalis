-- Remove the "project has a server" coupling. A project is now a purely logical
-- grouping; each application and database carries its OWN serverId. Apps used to
-- inherit the project's server via a NULL serverId — back-fill those from the
-- project BEFORE the column becomes NOT NULL and before the project column is
-- dropped, so no app is left without a server.

-- 1. Back-fill apps that inherited their server from the project.
UPDATE "applications" a
SET "serverId" = p."serverId"
FROM "projects" p
WHERE a."projectId" = p."id" AND a."serverId" IS NULL;

-- 2. Defensive: any database row still without a server inherits the project's
--    (databases already default to the project server at create time, but a
--    legacy NULL would block the NOT NULL/Restrict below).
UPDATE "databases" d
SET "serverId" = p."serverId"
FROM "projects" p
WHERE d."projectId" = p."id" AND d."serverId" IS NULL;

-- 3. applications.serverId becomes NOT NULL (every app now names its machine).
ALTER TABLE "applications" ALTER COLUMN "serverId" SET NOT NULL;

-- 4. Re-forge the FK ON DELETE behaviour to RESTRICT: a server that still hosts
--    apps/databases can't be deleted (no project server to fall back to). The
--    Servers service surfaces a friendly "move/remove these first" error.
ALTER TABLE "applications" DROP CONSTRAINT "applications_serverId_fkey";
ALTER TABLE "applications" ADD CONSTRAINT "applications_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "databases" DROP CONSTRAINT "databases_serverId_fkey";
ALTER TABLE "databases" ADD CONSTRAINT "databases_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Drop the project's server entirely (index → FK → column).
DROP INDEX "projects_serverId_idx";
ALTER TABLE "projects" DROP CONSTRAINT "projects_serverId_fkey";
ALTER TABLE "projects" DROP COLUMN "serverId";
