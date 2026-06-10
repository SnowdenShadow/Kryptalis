-- Per-user notification channel preferences (event -> channel -> bool).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notificationPrefs" JSONB;
