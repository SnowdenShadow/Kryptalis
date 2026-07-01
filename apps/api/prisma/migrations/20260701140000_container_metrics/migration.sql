-- Per-container resource usage samples (CPU / memory / net / block IO). The
-- container-level analogue of server_metrics: fed by the agent heartbeat for
-- remote hosts and a local `docker stats` collector for the API box. Rows are
-- pruned aggressively (short retention + per-container cap) since this table
-- grows far faster than server_metrics.

-- New agent task type for on-demand live container stats (remote apps).
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'STATS';

-- CreateTable
CREATE TABLE "container_metrics" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "applicationId" TEXT,
    "containerName" TEXT NOT NULL,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memoryUsed" BIGINT NOT NULL,
    "memoryLimit" BIGINT NOT NULL,
    "networkIn" BIGINT NOT NULL,
    "networkOut" BIGINT NOT NULL,
    "blockRead" BIGINT NOT NULL,
    "blockWrite" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "container_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "container_metrics_applicationId_timestamp_idx" ON "container_metrics"("applicationId", "timestamp");

-- CreateIndex
CREATE INDEX "container_metrics_serverId_timestamp_idx" ON "container_metrics"("serverId", "timestamp");

-- CreateIndex
CREATE INDEX "container_metrics_containerName_timestamp_idx" ON "container_metrics"("containerName", "timestamp");

-- AddForeignKey
ALTER TABLE "container_metrics" ADD CONSTRAINT "container_metrics_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_metrics" ADD CONSTRAINT "container_metrics_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
