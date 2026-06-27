-- Enforce at most ONE in-flight deployment per application at the DATABASE
-- level, closing the TOCTOU window in assertNoInflightDeployment() (a read +
-- later deployment.create() that two near-simultaneous redeploys could both
-- pass). A partial unique index makes the second concurrent insert fail with a
-- unique-violation instead of racing on the same app directory.
--
-- "In-flight" = status IN ('PENDING','BUILDING','DEPLOYING'). Terminal states
-- (RUNNING/FAILED/CANCELLED/ROLLED_BACK) and ROLLING_BACK are NOT constrained.
--
-- DEFENSIVE FIRST STEP: an existing database may already hold >1 in-flight
-- deployment for some app (the very race this index prevents, or rows left
-- in-flight by a crash). Creating the unique index against such data would
-- FAIL and block `prisma migrate deploy` at container startup. So we first
-- resolve any pre-existing duplicates: keep the most recent in-flight row per
-- application, mark the older ones FAILED. This is safe — those older rows
-- were already superseded — and idempotent.

UPDATE "deployments" d
SET "status" = 'FAILED',
    "finishedAt" = COALESCE("finishedAt", NOW())
WHERE d."status" IN ('PENDING', 'BUILDING', 'DEPLOYING')
  AND EXISTS (
    SELECT 1 FROM "deployments" newer
    WHERE newer."applicationId" = d."applicationId"
      AND newer."status" IN ('PENDING', 'BUILDING', 'DEPLOYING')
      AND (newer."createdAt" > d."createdAt"
           OR (newer."createdAt" = d."createdAt" AND newer."id" > d."id"))
  );

-- One in-flight deployment per application. Partial unique index (Postgres) —
-- not expressible in the Prisma schema, so it lives here as raw SQL.
CREATE UNIQUE INDEX "deployments_app_inflight_unique"
  ON "deployments" ("applicationId")
  WHERE "status" IN ('PENDING', 'BUILDING', 'DEPLOYING');
