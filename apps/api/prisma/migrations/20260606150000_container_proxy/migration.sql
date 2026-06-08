-- Caddy can proxy directly to app containers over a shared docker network.
-- containerName + containerPort tell Caddy where to send traffic.
ALTER TABLE "applications" ADD COLUMN "containerName" TEXT;
ALTER TABLE "applications" ADD COLUMN "containerPort" INTEGER;
