-- User-scheduled commands that run inside an application's container on a
-- standard 5-field cron expression. One scheduler (the API process) ticks
-- every 60s and compares lastRunAt against the previous occurrence.
CREATE TABLE "cron_jobs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastExitCode" INTEGER,
    "lastOutput" TEXT,
    "applicationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cron_jobs_applicationId_idx" ON "cron_jobs"("applicationId");

ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
