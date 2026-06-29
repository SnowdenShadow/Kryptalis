-- Multi-server mail: the host a mail stack runs on. NULL = the platform
-- primary host (historical behaviour — docker runs locally on the API host).
-- A non-null serverId routes the stack to that registered server via the agent.
-- ON DELETE SET NULL so removing a server falls back to "primary host" rather
-- than cascading the mail server away.
ALTER TABLE "mail_servers" ADD COLUMN "serverId" TEXT;

CREATE INDEX "mail_servers_serverId_idx" ON "mail_servers"("serverId");

ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
