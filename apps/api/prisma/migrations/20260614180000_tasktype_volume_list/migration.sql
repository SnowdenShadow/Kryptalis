-- Server-to-server migration: discover a stack's real docker volume names on a
-- remote host (docker volume ls filtered by compose-project prefix) so the
-- migration exports actual volumes instead of guessing deterministic names.
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'VOLUME_LIST';
