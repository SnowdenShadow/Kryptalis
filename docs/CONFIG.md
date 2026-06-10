# Configuration

Kryptalis splits configuration into two layers:

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
| `POSTGRES_PASSWORD` | Postgres `kryptalis` user password. Baked into the Postgres data volume on first init — changing it later requires wiping the volume. | `openssl rand -hex 16` |
| `JWT_SECRET` | HMAC key for access tokens. Rotating it invalidates every active session. | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | HMAC key for refresh tokens. Rotating it forces every user to log in again. | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | AES-256-GCM key for `SystemSetting` secrets and credential fields on `Server` / `GitProvider` / `Database` rows. **If you lose this, the encrypted SMTP password, webhook secrets, and similar are unrecoverable.** | `openssl rand -hex 16` (16 bytes / 32 hex chars) |

`DATABASE_URL` is composed in `docker-compose.yml` from the Postgres values; it is not set directly in `.env`. If you run the API outside Docker (dev mode), set it explicitly: `postgresql://kryptalis:<pass>@127.0.0.1:5432/kryptalis`.

Two more `.env` keys are optional but commonly set:

| Key | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_API_URL` | autodetected at install | The URL the browser uses to reach the API. Baked into the dashboard at build time (`NEXT_PUBLIC_API_URL`). Change → rebuild dashboard with `--no-cache`. |
| `BACKUP_ENCRYPTION_KEY` | unset | When set, backup dumps are AES-256-GCM encrypted on disk. Separate from `ENCRYPTION_KEY` so backup access can be siloed. Can also be set via `SystemSetting.backup_encryption_key`. |
| `ACME_EMAIL` | derived from `PUBLIC_API_URL` | Let's Encrypt contact email for expiry notices. Bare-IP installs fall back to anonymous registration. |
| `DASHBOARD_BIND` | `0.0.0.0` | Set to `127.0.0.1` once a public domain fronts the dashboard so direct `:3000` traffic stops bypassing TLS. |

## `SystemSetting` keys

Every key below is editable from **Admin → System Config**. The `env fallback` column names the corresponding `process.env` variable for legacy installs.

### Mail (SMTP)

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `smtp_host` | `SMTP_HOST` | — | SMTP server hostname. Unset → notifications service is a logged no-op. |
| `smtp_port` | `SMTP_PORT` | `587` | SMTP server port. |
| `smtp_user` | `SMTP_USER` | — | SMTP username. |
| `smtp_pass` | `SMTP_PASS` | — | SMTP password. **Encrypted at rest.** Blank field in the UI keeps the existing value (so you can edit other SMTP fields without re-entering it). |
| `smtp_from` | `SMTP_FROM` | falls back to `smtp_user`, then `no-reply@kryptalis.local` | `From:` header on outgoing mail. |

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

### Admin / user policy

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `registration_enabled` | — | `true` after first user | Public signup toggle. Defaults to allowing the first user, then can be locked down. |
| `platform_name` | — | `Kryptalis` | Branding in dashboard header + email subjects. |
| `deployment_mode` | — | `LOCAL` | `LOCAL` (single VPS) or `MULTI` (additional servers via the agent). Switching `LOCAL → MULTI` is reversible until you add a non-local server. |

Planned, **not implemented yet** (the keys exist in `SETTING_KEYS` but no code enforces them): `require_admin_approval` (pending-approval signup flow), `default_user_role`, `maintenance_mode` (503 on write endpoints).

### Webhooks

| Key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `github_webhook_secret` | — | unset | Shared secret for GitHub webhook HMAC verification. **Encrypted at rest.** Verified against the raw request body (not the JSON-reparsed form). |

### Secret keys (encrypted at rest)

The `SECRET_KEYS` allowlist in `SystemConfigService` controls which keys go through the encryption envelope:

- `smtp_pass`
- `backup_encryption_key`
- `github_webhook_secret`

For these, `getPublicSnapshot()` returns a boolean (`true` if a non-empty value is stored) so the plaintext never leaves the API to the browser. The Admin UI shows them as masked fields; submitting blank means "keep existing".

## Adding a new setting

`SystemSetting` is a free-form key/value store (`Json` column), so adding a new one is one Prisma upsert. The convention is:

1. Pick a snake_case key (`some_new_thing`).
2. Add a read with a sensible default: `this.systemConfig.get('some_new_thing', 'SOME_NEW_THING', 'default-value')`.
3. If it's sensitive, add the key to `SECRET_KEYS` in both `system-config.service.ts` and `admin.service.ts` so it gets the encryption envelope and the "blank = keep existing" UX.
4. Add it to the table above so operators can find it.

No migration needed — `SystemSetting` rows are inserted on first write.
