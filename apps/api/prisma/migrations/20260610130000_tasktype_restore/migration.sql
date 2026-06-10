-- Add RESTORE to the agent TaskType enum (remote restore orchestration).
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'RESTORE';
