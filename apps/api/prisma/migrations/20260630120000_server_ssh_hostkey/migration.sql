-- Pin the agent's SSH host key (trust-on-first-use) so the API↔agent remote
-- terminal / SFTP bridge can detect a MITM. NULL until the first successful
-- connect captures it; later connects compare against it and abort on mismatch.
ALTER TABLE "servers" ADD COLUMN "sshHostKey" TEXT;
