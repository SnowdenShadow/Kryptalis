-- Per-mail-server antispam config. Defaults preserve current behaviour
-- (rspamd + fail2ban on, no greylisting/antivirus, mark above the threshold).
ALTER TABLE "mail_servers" ADD COLUMN "spamPreset" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "mail_servers" ADD COLUMN "greylisting" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mail_servers" ADD COLUMN "antivirus" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mail_servers" ADD COLUMN "spamAction" TEXT NOT NULL DEFAULT 'add_header';
ALTER TABLE "mail_servers" ADD COLUMN "spamThreshold" DOUBLE PRECISION NOT NULL DEFAULT 6;
ALTER TABLE "mail_servers" ADD COLUMN "whitelist" TEXT;
ALTER TABLE "mail_servers" ADD COLUMN "blacklist" TEXT;
