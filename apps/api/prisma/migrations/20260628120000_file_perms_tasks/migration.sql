-- Add FILE_CHMOD / FILE_CHOWN task types (permission management dispatched to
-- the agent for apps on remote servers). Non-destructive enum value adds.
-- `IF NOT EXISTS` makes the migration idempotent / safe to re-run.
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'FILE_CHMOD';
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'FILE_CHOWN';
