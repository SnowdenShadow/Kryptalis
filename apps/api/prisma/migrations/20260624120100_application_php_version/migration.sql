-- PHP runtime version for PHP_SITE apps (e.g. "8.3"), baked into the
-- php:<version>-apache image as a build ARG. NULL for every other framework.
-- AlterTable
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "phpVersion" TEXT;
