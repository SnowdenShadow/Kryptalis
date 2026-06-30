-- Domain-ownership verification (H-3). A domain must prove control via a DNS
-- TXT record before it can be rendered into Caddy / host a mail stack when
-- require_domain_verification is enabled. Existing rows are back-filled as
-- verified so already-configured installs keep working after upgrade.
ALTER TABLE "domains" ADD COLUMN "verificationToken" TEXT;
ALTER TABLE "domains" ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- Grandfather every pre-existing domain as verified (they were already routing
-- before this feature existed; do not break them on upgrade).
UPDATE "domains" SET "verifiedAt" = NOW() WHERE "verifiedAt" IS NULL;
