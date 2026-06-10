-- Dedupe marker for the SSL expiry notifier: set when an "expiring soon"
-- notification is sent, compared against the start of the warning window so
-- a renewed cert (expiresAt pushed forward) re-arms automatically.
ALTER TABLE "ssl_certificates" ADD COLUMN IF NOT EXISTS "expiryNotifiedAt" TIMESTAMP(3);
