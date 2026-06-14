# Configuration

DockControl splits configuration into two layers:

1. **`.env` bootstrap secrets** — read once at API startup. Must be set on disk *before* `docker compose up` or the stack refuses to start.
2. **`SystemSetting` rows in Postgres** — everything operational. Editable from **Admin → System Config** in the dashboard, no API restart needed.

## Resolution order

Every read of an operational setting follows this order:

```
SystemSetting (DB)  →  process.env  →  built-in default
```

- The DB value wins if set (`SystemConfigService.get(key, envFallback, default)`).
- The env fallback is the legacy path — installs older than the Admin UI still work, and the bootstrap secrets in `.env` keep functioning.
- The default is the documented value in the table below.

A live `setMany()` write to `SystemSetting` notifies subscribers via `SystemConfigService.onChange()`, so the SMTP transport, scheduler intervals, etc. reconfigure without a restart.

## `.env` bootstrap secrets

These four are **required** — `docker-compose.yml` uses the `${VAR:?error}` pattern, so the stack refuses to start if any of them is missing. `install.sh` generates them on a fresh install; do not lose them.

| Key | What it is | How to generate |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Postgres `dockcontrol` user password. Baked into the Postgres data volume on first init — changing it later requires wiping the volume. | `openssl rand -hex 16` |
| `JWT_SECRET` | HMAC key for access tokens. Rotating it invalidates every active session. | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | HMAC key for refresh tokens. Rotating it forces every user to log in again. | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | AES-256-GCM key for `SystemSetting` secrets and credential fields on `Server` / `GitProvider` / `Database` rows. **If you lose this, the encrypted SMTP password, webhook secrets, and similar are unrecoverable.** | `openssl rand -hex 16` (16 bytes / 32 hex chars) |

`DATABASE_URL` is composed in `docker-compose.yml` from the Postgres values; it is not set directly in `.env`. If you run the API outside Docker (dev mode), set it explicitly: `postgresql://dockcontrol:<pass>@127.0.0.1:5432/dockcontrol`.

Two more `.env` keys are optional but commonly set:

| Key | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_API_URL` | autodetected at install | The URL the browser uses to reach the API. Baked into the dashboard at build time (`NEXT_PUBLIC_API_URL`). Change → rebuild dashboard with `--no-cache`. |
| `BACKUP_ENCRYPTION_KEY` | unset | When set, backup dumps are AES-256-GCM encrypted on disk. Separate from `ENCRYPTION_KEY` so backup access can be siloed. Can also be set via `SystemSetting.backup_encryption_key`. |
| `ACME_EMAIL` | derived from `PUBLIC_API_URL` | Let's Encrypt contact email for expiry notices. Bare-IP installs fall back to anonymous registration. |
| `DASHBOARD_BIND` | `0.0.0.0` | Set to `127.0.0.1` once a public domain fronts the dashboard so direct `:3000` traffic stops bypassing TLS. |
| `API_BIND` | `0.0.0.0` | Same idea for the API: set to `127.0.0.1` once Caddy fronts it so direct `:4000` traffic stops bypassing TLS. |
| `DASHBOARD_PORT` | `3000` | Host port the dashboard container is published on (container side stays 3000). |
| `SFTP_PORT` | `2222` | Host port the bundled SFTP container is published on (container side stays 22). |
| `PUBLIC_DASHBOARD_URL` | `http://localhost:3000` | Dashboard public origin, used for CTA links in emails. Also editable live as `public_dashboard_url` (see below). |
| `JWT_EXPIRATION` | `15m` | Access-token TTL. |
| `JWT_REFRESH_EXPIRATION` | `7d` | Refresh-token TTL. |
| `CORS_ORIGINS` | derived | Comma-separated explicit browser-origin allowlist. Unset → derived from `PUBLIC_API_URL` + local dev origins. |
| `SWAGGER_PUBLIC` | unset | Set truthy to expose Swagger (`/api/docs`) in production. |
| `GITHUB_OAUTH_CLIENT_ID` | baked-in default | GitHub OAuth app client id for the "connect GitHub" flow; set to use your own OAuth app. |

Advanced env-only knobs (rarely needed):

| Key | Default | Purpose |
| --- | --- | --- |
| `CADDY_DATA_VOLUME` | autodetected | Explicit name of the Caddy data volume (mail-server certificate lookups). |
| `DOCKCONTROL_PROTECTED_CONTAINERS` | built-in list | Extra comma-separated container names the API refuses to stop/remove. |
| `DOCKCONTROL_COMPOSE_OVERRIDE` | `/app/install-root/docker-compose.override.yml` | Path of the override file the reverse-proxy writes for extra published Caddy ports. |

## `SystemSetting` keys

Every key below is editable from **Admin → System Config**. The `env fallback` column names the corresponding `process.env` variable for legacy installs.

### Mail (SMTP)

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `smtp_host` | `SMTP_HOST` | — | SMTP server hostname. Unset → notifications service is a logged no-op. |
| `smtp_port` | `SMTP_PORT` | `587` | SMTP server port. |
| `smtp_user` | `SMTP_USER` | — | SMTP username. |
| `smtp_pass` | `SMTP_PASS` | — | SMTP password. **Encrypted at rest.** Blank field in the UI keeps the existing value (so you can edit other SMTP fields without re-entering it). |
| `smtp_from` | `SMTP_FROM` | falls back to `smtp_user`, then `no-reply@dockcontrol.local` | `From:` header on outgoing mail. |

### Public URLs

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `public_dashboard_url` | `PUBLIC_DASHBOARD_URL` | `http://localhost:3000` | Used to build CTA links inside email bodies (deploy-result, password reset, invite). Set this to your real dashboard origin once you wire a domain. |

### Retention

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `metric_retention_days` | `METRIC_RETENTION_DAYS` | `30` | Server metric samples (CPU / RAM / disk / net) older than this are deleted by the hourly cleanup job. |
| `deployment_retention_days` | `DEPLOYMENT_RETENTION_DAYS` | `90` | Successful deployments older than this are pruned (failed/in-progress are kept indefinitely so you can debug). |

The audit log has a hardcoded retention of 365 days (cleaned hourly), tracked in `apps/api/src/modules/admin/admin.service.ts`.

### Backups

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `backup_encryption_key` | `BACKUP_ENCRYPTION_KEY` | unset → plaintext | 32-byte hex key for AES-256-GCM backup encryption. **Encrypted at rest** (envelope inside `SystemSetting`). Set this *before* any production data lands, then back the key up off-system. |
| `s3_endpoint` | `S3_ENDPOINT` | — | Endpoint URL of the S3-compatible store (Amazon S3, Cloudflare R2, Backblaze B2, MinIO). Required for remote backup targets. |
| `s3_bucket` | `S3_BUCKET` | — | Bucket name backups are written into. Required for remote backup targets. |
| `s3_region` | `S3_REGION` | `auto` | Bucket region. `auto` works for R2/B2/MinIO; set a real region for Amazon S3. |
| `s3_access_key` | `S3_ACCESS_KEY` | — | Access key ID. Required for remote backup targets. |
| `s3_secret_key` | `S3_SECRET_KEY` | — | Secret access key. **Encrypted at rest.** Blank field in the UI keeps the existing value. Required for remote backup targets. |

> **Note on the `S3_*` env fallbacks:** the provided `docker-compose.yml` does **not** pass any `S3_*` variable into the API container, so setting them in `.env` has no effect on a standard install — they only work for bare-metal / custom-compose deployments that inject them explicitly. On a standard install, configure S3 storage via **Admin → System Config** (which is the recommended path anyway).

Remote backup targets (`S3` / `R2` / `B2` in the create-backup dialog) only become selectable once `s3_endpoint`, `s3_bucket`, `s3_access_key` and `s3_secret_key` are all set (`GET /backups/targets` reports `s3Configured`). Dumps are uploaded under `dockcontrol-backups/<backupId>/<filename>` (post-encryption bytes — the recorded sha256 still matches), the local file is deleted after a successful upload, and restores download to a temp file before running the usual integrity/decryption gate. Deleting a backup removes its remote objects best-effort.

### Admin / user policy

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `registration_enabled` | — | `true` after first user | Public signup toggle. Defaults to allowing the first user, then can be locked down. |
| `require_admin_approval` | — | `false` | When `true`, every non-bootstrap signup is created with status `PENDING_APPROVAL` (no verification email is sent). Login answers 403 until an ADMIN/SUPERADMIN flips the user to `ACTIVE` via `PATCH /admin/users/:id/status` (Admin → Users). |
| `default_user_role` | — | `USER` | Role granted to non-bootstrap signups. Allowed values: `USER` or `VIEWER` — anything else silently falls back to `USER` so a tampered row can never mint privileged accounts. |
| `maintenance_mode` | — | `false` | When `true`, write requests (POST/PATCH/PUT/DELETE) from non-admins get a 503 with a `MAINTENANCE_MODE` code. GETs always pass; `/api/auth/*`, `/api/health`, `/api/agent/*` and `/api/webhooks/*` stay open; ADMIN/SUPERADMIN bearer tokens bypass the gate. Enforced by a global guard (`apps/api/src/common/guards/maintenance.guard.ts`) that caches the flag in memory via `SystemConfigService.onChange` — no DB query per request. |
| `platform_name` | — | `DockControl` | Branding in dashboard header + email subjects. |
| `deployment_mode` | — | `LOCAL` | `LOCAL` (single VPS) or `MULTI` (additional servers via the agent). Switching `LOCAL → MULTI` is reversible until you add a non-local server. |


### Webhooks

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `github_webhook_secret` | — | unset | Shared secret for GitHub webhook HMAC verification. **Encrypted at rest.** Verified against the raw request body (not the JSON-reparsed form). |

### Secret keys (encrypted at rest)

The `SECRET_KEYS` allowlist in `SystemConfigService` controls which keys go through the encryption envelope:

- `smtp_pass`
- `backup_encryption_key`
- `github_webhook_secret`
- `s3_secret_key`

For these, `getPublicSnapshot()` returns a boolean (`true` if a non-empty value is stored) so the plaintext never leaves the API to the browser. The Admin UI shows them as masked fields; submitting blank means "keep existing".

## Adding a new setting

`SystemSetting` is a free-form key/value store (`Json` column), so adding a new one is one Prisma upsert. The convention is:

1. Pick a snake_case key (`some_new_thing`).
2. Add a read with a sensible default: `this.systemConfig.get('some_new_thing', 'SOME_NEW_THING', 'default-value')`.
3. If it's sensitive, add the key to `SECRET_KEYS` in both `system-config.service.ts` and `admin.service.ts` so it gets the encryption envelope and the "blank = keep existing" UX.
4. Add it to the table above so operators can find it.

No migration needed — `SystemSetting` rows are inserted on first write.
