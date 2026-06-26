-- Per-PHP_SITE config: web server, optional extensions, php.ini overrides,
-- preset. Defaults preserve current behaviour (Apache + base pack + default ini).
ALTER TABLE "applications" ADD COLUMN "phpWebServer" TEXT DEFAULT 'apache';
ALTER TABLE "applications" ADD COLUMN "phpExtensions" TEXT;
ALTER TABLE "applications" ADD COLUMN "phpIni" JSONB;
ALTER TABLE "applications" ADD COLUMN "phpPreset" TEXT;
