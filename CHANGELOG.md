# Changelog

All notable changes to DockControl are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added — PHP/Apache hosting, cron jobs, DB attach (2026-06-25)

**PHP / Apache shared hosting**
- New `PHP_SITE` application type: one `php:<version>-apache` container per site, with a selectable PHP version (7.4–8.3) that can be changed after creation (rebuilds the image + redeploys). Serves static `.html` and executable `.php`.
- The generated image bundles the database drivers (`pdo_mysql`, `mysqli`, `pdo_pgsql`) and a common web pack (`gd`, `zip`, `intl`, `opcache`, `bcmath`) so WordPress / Laravel / Symfony / PrestaShop run out of the box.
- Files are uploaded over SFTP into the site's `public/` docroot (bind-mounted, served live with no rebuild). SFTP drops the user directly into `public/`.
- New dashboard page **PHP Sites** with create dialog, inline version switcher, DB manager, and links to SFTP + the app-detail page (logs / deployments / lifecycle).

**Attach a database to a site**
- Managed databases now join their **project network** at create time, so a sibling app/site reaches them by container name.
- New `attachDatabase`/`detachDatabase`: links a managed DB to an app and injects `DB_HOST`/`DB_PORT`/`DB_DATABASE`/`DB_USERNAME`/`DB_PASSWORD`/`DATABASE_URL` (in-network host + internal port) into its env, surviving redeploys. Cross-host attach is refused with a clear message; pre-existing DBs are connected to the project network on attach (repair path).

**Cron jobs**
- New `CronJob` model + scheduler (60 s tick, minute granularity, single API process). Commands run as `sh -c` inside the target app/site container, locally or via a remote EXEC agent task.
- Dashboard **Cron Jobs** page: simple frequency builder + advanced raw-cron mode with a plain-language preview, edit/enable/disable/delete, a **Test** button that runs the job now and shows captured output + exit code.
- Guards: jobs against a stopped app record a clear "app not running" outcome instead of a raw docker error; empty name/command rejected at the DTO.

### Fixed
- `CreateApplicationDto`: the internal `restoreVolumes`/`loadImages` fields are now `declare`-only — under `target: ES2022` they were emitted as `undefined` instance properties and `forbidNonWhitelisted` rejected **every** application-create request with "property restoreVolumes should not exist".
- `install.sh` / `update.sh`: `docker compose pull` now pulls only the registry images (postgres, caddy) by name — a bare pull tried to fetch the locally-built `dockcontrol-sftp` image and printed a scary "pull access denied" error + layer-progress spam. The final install summary box no longer mis-aligns on variable-width IPs.

### Fixed — reliability & security hardening pass (2026-06-10)

**Critical**
- API Dockerfile no longer runs `prisma db push --accept-data-loss` at startup — a destructive schema change combined with auto-update could silently destroy data on every installation. Destructive pushes are now an explicit manual operation.
- `update.sh` `run()` helper now propagates the real command exit code (previously `tee` masked every failure as success, so failed updates logged "✓ update complete").
- `install.sh` systemd timer heredoc wrote the literal string `${DOCKCONTROL_UPDATE_INTERVAL:-5min}` into the unit (systemd does no shell expansion) — the auto-update timer never loaded. Interval is now resolved before writing the unit.
- `install.sh` no longer silently wipes the Postgres volume when `.env` is missing — it refuses and requires explicit `DOCKCONTROL_RESET=1`.
- Dashboard admin page violated the Rules of Hooks (conditional early-return before `useQuery`) — guaranteed React crash for non-admin users. Guard moved after all hooks.
- Token state desync between localStorage and the persisted zustand store caused a `/login ↔ /dashboard` redirect loop after session expiry. Both stores now stay in sync on refresh/logout.
- Go agent: all `exec.Command` calls now use `exec.CommandContext` with per-task-type timeouts — a hung `docker compose pull` could previously brick the agent (4 stuck tasks = full semaphore, silent).

**High**
- `turbo` added to root devDependencies (root `pnpm dev/build/lint` scripts were broken without a global install).
- Databases module: `name`/`username`/`password` DTO validation (`@Matches`) — values are interpolated into generated compose YAML; shell-interpolated `docker rm -f` replaced with `execFile` argv; DB passwords now generated with `crypto.randomBytes` (was `Math.random()`); host-port allocation is collision-checked against existing rows (was unchecked random).
- Login 2FA detection now uses the structured `code: 'TOTP_REQUIRED'` field instead of regex-matching the English error message.
- `API_BIND` variable added to docker-compose (mirror of `DASHBOARD_BIND`) so the API can be bound to loopback behind Caddy.
- Dev compose (postgres/redis) now binds to `127.0.0.1` instead of all interfaces.
- File upload/download go through the shared API client (`api.rawFetch`) so the 401→refresh pipeline applies (used to break 15 min into a session).
- Go agent: `runRemove` no longer swallows `compose down` errors (API state stayed diverged from reality); env-var values are escaped when writing `.env` (newline injection); `reportResult` retries with backoff; graceful SIGTERM drain (up to 60 s) so in-flight deployments report their result.
- CSP `connect-src` no longer allows WebSockets to arbitrary hosts.

**Medium**
- Shared `src/lib/app-format.ts` extracted: `STATUS_VARIANT` / `STATUS_COLOR` / `FRAMEWORK_LABELS` / `HTTPS_PORTS` / `makeTimeAgo` / `publicUrls` were copy-pasted (and drifting) across 5 pages.
- Project page "Open" button no longer hardcodes `localhost` (broken on any remote install).
- Removed the global react-query `refetchInterval: 10s` (every query in the app was re-fetched every 10 s); pages keep their targeted intervals.
- Env-var editor rows keyed by stable id instead of array index (deleting a row could reveal the next row's masked secret).
- Admin user search debounced (300 ms); role/status selects are now controlled (failed mutations no longer show the wrong value).
- `update.sh` http/https protocol mismatches fixed on application URLs (port-pinned domains are plain HTTP via the container).
- `<pre>` deployment log autoscroll anchor changed from `<div>` to `<span>` (invalid HTML).
- API `res.json()` no longer throws on 204/empty responses.
- Decorative search bar (Ctrl+K) and hardcoded notification badge removed from the header (no backing implementation).
- Go agent: 6 dead packages removed (`backup`, `deploy`, `docker`, `proxy`, `ssl`, `system` — zero imports, no-op `Rollback`); `go.mod` purged (`go mod tidy`); agent version stamped via ldflags (`monitor.Version`) instead of two hard-coded copies; `/proc` stats read directly instead of shelling out to `sh`/`awk`; heartbeat drains response bodies (keep-alive reuse); `POLL_INTERVAL` validated (≥1 s; zero/negative previously panicked).
- Missing login i18n keys added (EN + FR): `auth.welcomeBack`, `auth.totpCode`, `auth.backupCode`, `auth.useBackup`, `auth.useAuthenticator`, `errors.server`.

**Docs**
- ARCHITECTURE.md: 6 containers (sftp was missing), mail stack corrected to docker-mailserver (was "Mailcow / Stalwart"), redis described as reserved (API doesn't consume it yet), ENCRYPTION_KEY size description fixed, notifications section aligned with the implementation (in-app feed / webhook HMAC / security events marked as planned).
- CONFIG.md: `require_admin_approval`, `default_user_role`, `maintenance_mode` moved to a "planned, not implemented" note.
- INSTALL.md: auto-update interval corrected to 5 min everywhere; mail stack reference fixed; P1000 troubleshooting updated for the new no-silent-wipe behaviour.
- USER_GUIDE (EN/FR): agent update procedure corrected (standalone binary, not a git checkout); database type list completed (KeyDB, Dragonfly, ClickHouse).
- `.env.example` regenerated from what the code actually reads (removed never-read `REDIS_URL`/`AGENT_TOKEN`/`CLOUDFLARE_*`/`S3_*`; added `POSTGRES_PASSWORD`, `BACKUP_ENCRYPTION_KEY`, `ACME_EMAIL`, `DASHBOARD_BIND`, `API_BIND`, `CORS_ORIGINS`, `SWAGGER_PUBLIC`).
- `README-Dashbord.md` renamed to `README-Dashboard.md`; phantom features removed (Light Mode, Keyboard Shortcuts, Compress/Extract, "Client" role).

## [0.1.0] — Initial development version
