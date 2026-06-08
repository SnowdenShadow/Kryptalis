-- Mark whether the user explicitly chose the port at install time.
-- When true, the reverse proxy emits https://<domain>:<port> instead of
-- https://<domain> so the chosen port becomes part of the final URL.
ALTER TABLE "applications" ADD COLUMN "customPort" BOOLEAN NOT NULL DEFAULT false;
