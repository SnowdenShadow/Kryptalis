-- Add the FILE_EXTRACT task type (zip extraction dispatched to the agent for
-- apps on remote servers). Non-destructive enum value add. `IF NOT EXISTS`
-- makes the migration idempotent / safe to re-run.
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'FILE_EXTRACT';
