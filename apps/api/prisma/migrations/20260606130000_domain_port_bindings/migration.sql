-- Multi-app per domain: one row per (domain, port) → application binding.
-- Lets several apps share a single hostname on different ports.
CREATE TABLE "domain_port_bindings" (
  "id" TEXT NOT NULL,
  "domainId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "port" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "domain_port_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "domain_port_bindings_domainId_port_key"
  ON "domain_port_bindings"("domainId", "port");

CREATE INDEX "domain_port_bindings_applicationId_idx"
  ON "domain_port_bindings"("applicationId");

ALTER TABLE "domain_port_bindings"
  ADD CONSTRAINT "domain_port_bindings_domainId_fkey"
  FOREIGN KEY ("domainId") REFERENCES "domains"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "domain_port_bindings"
  ADD CONSTRAINT "domain_port_bindings_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "applications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing (Domain.applicationId, Application.port) where
-- the app is in customPort mode becomes a port binding, and we clear
-- Domain.applicationId so the domain's :443 slot is free again (the user
-- can later link a clean-URL app there).
INSERT INTO "domain_port_bindings" ("id", "domainId", "applicationId", "port")
SELECT
  'dpb_' || substr(md5(random()::text || d.id), 1, 22) AS id,
  d.id AS "domainId",
  a.id AS "applicationId",
  a.port AS port
FROM "domains" d
JOIN "applications" a ON a.id = d."applicationId"
WHERE a."customPort" = TRUE
  AND a.port IS NOT NULL
ON CONFLICT ("domainId", "port") DO NOTHING;

UPDATE "domains"
SET "applicationId" = NULL
WHERE "applicationId" IN (
  SELECT id FROM "applications" WHERE "customPort" = TRUE
);
