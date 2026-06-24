-- PHP_SITE hosting type: an Apache + PHP container (selectable PHP version)
-- serving SFTP-uploaded files from a live bind-mounted docroot. New value on
-- the AppFramework enum. ADD VALUE must run in its own migration (Postgres
-- forbids using a freshly-added enum value in the same transaction).
ALTER TYPE "AppFramework" ADD VALUE IF NOT EXISTS 'PHP_SITE';
