# Installing Kryptalis

This page covers a production install on a fresh VPS. For the dev loop on your laptop, see the Contributing section in [README.md](./README.md).

## Prerequisites checklist

- [ ] A fresh Ubuntu 22.04+ or Debian 12+ VPS with root access.
- [ ] At least 2 GB RAM and 20 GB disk.
- [ ] Ports `80`, `443`, `3000`, `4000` reachable from your machine (and `80` + `443` from the public internet — Let's Encrypt needs them for HTTP-01).
- [ ] A public IPv4 address.
- [ ] Optional but recommended: a domain you control, with DNS managed somewhere you can edit A records.

You do **not** need Docker, Node, Postgres, Redis, or Caddy installed beforehand — the installer handles all of that.

## Install via `install.sh`

Run as root on the VPS:

```sh
curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/Kryptalis/main/install.sh | sudo bash
```

The script:

1. Detects the OS and installs Docker + the `docker compose` plugin if missing.
2. Clones the repo to `/opt/kryptalis` (override with `KRYPTALIS_DIR`).
3. Detects the public IP via `api.ipify.org` (override with `PUBLIC_API_URL`).
4. Generates `/opt/kryptalis/.env` with cryptographically random values for `POSTGRES_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY` (mode `0600`).
5. Seeds bind-mount targets (`docker-compose.override.yml`, `.kryptalis/reverse-proxy/Caddyfile`) so Docker doesn't materialise them as empty directories.
6. Runs `docker compose up -d --build`, waits up to 180 s for `/api/health` to come up.
7. Installs `kryptalis-update.timer` (systemd) for auto-updates every 30 s — see [Updating](#updating-kryptalis).

The installer asks for **nothing interactively**. Everything is taken from env vars or sensible defaults. Useful overrides:

| Env var | Default | Purpose |
| --- | --- | --- |
| `KRYPTALIS_DIR` | `/opt/kryptalis` | Install root. |
| `KRYPTALIS_REPO` | `https://github.com/SnowdenShadow/Kryptalis.git` | Source repo. |
| `KRYPTALIS_BRANCH` | `main` | Branch to track. |
| `PUBLIC_API_URL` | autodetected | Forces the public API URL baked into the dashboard build. |
| `KRYPTALIS_RESET=1` | off | **Destructive.** Wipes `.env`, Postgres + Redis volumes, reinstalls fresh. |
| `KRYPTALIS_NO_AUTOUPDATE=1` | off | Skip the systemd auto-update timer. |

Re-running the installer is safe — it preserves `.env`, the Postgres volume, and only rebuilds the dashboard when `PUBLIC_API_URL` changes (Next inlines `NEXT_PUBLIC_*` at build time, so a stale image would call the wrong origin and trigger CORS errors).

## Post-install: first user, onboarding wizard

Open `http://<server-ip>:3000` (or whatever `PUBLIC_API_URL` resolves to). Register the first account.

- The first user to register is automatically promoted to `SUPERADMIN`.
- The onboarding wizard auto-mounts on the dashboard and walks through: SMTP, public domain, registration toggle.
- Further signups can be locked down via **Admin → Settings → `registration_enabled`**. Set `require_admin_approval` to keep public signup but gate access behind an admin click.

## Configuring SMTP

SMTP is now configured entirely from **Admin → System Config**, not from `.env`. The keys map straight into `SystemSetting`:

| Field in UI | `SystemSetting` key | Notes |
| --- | --- | --- |
| Host | `smtp_host` | `smtp.example.com`. |
| Port | `smtp_port` | Defaults to `587`. |
| Username | `smtp_user` | |
| Password | `smtp_pass` | Stored encrypted (AES-256-GCM envelope). Leave blank to keep existing value. |
| From | `smtp_from` | Defaults to `smtp_user`. |

Use the **Send test email** button in the same panel — it loops through the API container and reports the actual SMTP error if there is one. Without SMTP configured, the `NotificationsService` becomes a logged no-op; the API still boots normally and dashboard alerts stay in-app only.

## Setting up a public domain

1. Point an `A` record (or `AAAA`) at the server's public IP. Wait for DNS to propagate — `dig +short yourdomain.com` should return the right IP.
2. In the dashboard go to **Domains → Add Domain**, enter the FQDN, attach it to the dashboard or to a deployed app.
3. Kryptalis regenerates `.kryptalis/reverse-proxy/Caddyfile` and reloads Caddy. The cert is issued on the next inbound request to that hostname (Let's Encrypt HTTP-01 on port 80).
4. For dashboard / API behind a domain: set `DASHBOARD_BIND=127.0.0.1` in `.env` and restart so port `3000` no longer bypasses TLS. The Caddy site for that domain will proxy `:80` → `dashboard:3000` automatically.

Custom-port HTTPS (e.g. `https://app.example.com:5000`) is handled by an auto-managed `docker-compose.override.yml` the API rewrites whenever you attach a port-pinned domain — do not edit that file by hand, it is regenerated on every domain change.

## Updating Kryptalis

Two ways:

- **Automatic** (default). The installer installs `kryptalis-update.timer` which fires every 30 s. `update.sh` calls the GitHub API with an `If-None-Match` ETag — when the upstream SHA is unchanged the response is `304 Not Modified` and costs nothing against the 60 req/h anonymous quota. When a new commit is detected: `git fetch && git reset --hard origin/<branch> && docker compose pull && docker compose up -d --build`. Status is written to `.kryptalis/update-status.json` so the dashboard can show progress.
- **Manual**. Hit **/admin/updates** in the dashboard and click "Check now" or "Update now". Or on the VPS: `sudo /opt/kryptalis/update.sh` (apply), `--check` (don't apply), `--force` (rebuild even if no new commit).

To pause auto-updates without stopping the timer, toggle off in the dashboard — `update.sh` honours the `auto-update.pref` file and no-ops politely.

## Troubleshooting

Logs live in two places:

- **Docker logs** for each service:

  ```sh
  cd /opt/kryptalis
  docker compose logs -f api          # API requests, deploy jobs, scheduler
  docker compose logs -f dashboard    # Next.js server logs
  docker compose logs -f caddy        # TLS, virtual hosts, ACME
  docker compose logs -f postgres
  ```

- **Persisted state** under `/opt/kryptalis/.kryptalis/`:

  ```
  .kryptalis/
    update.log              # last 500 lines of update.sh runs
    update-status.json      # current update state (read by dashboard)
    apps/<slug-shortid>/    # generated docker-compose stacks per app
    databases/<slug>/       # database stacks (Postgres, MySQL, …)
    mail/                   # mail server configs (Mailcow / Stalwart)
    reverse-proxy/Caddyfile # regenerated by the API on every domain change
  ```

Common gotchas:

- **`Permission denied` on `update.sh`** — Windows checkouts strip the `+x` bit on `git push`. `update.sh` re-asserts it on every run, but the *first* manual run from a Windows-pushed commit may need `chmod +x install.sh update.sh`.
- **Postgres `P1000` auth failure** — happens if `.env` was regenerated without dropping the Postgres volume. `install.sh` detects this case and wipes the stale volume automatically; if you got there by hand, run `KRYPTALIS_RESET=1 ./install.sh`.
- **Caddy crashes with "not a directory"** — Docker materialised `.kryptalis/reverse-proxy/Caddyfile` as an empty dir before the file existed. `install.sh` and `update.sh` both seed the file beforehand; if you brought the stack up by hand, run `install.sh` once to reseed.
- **Dashboard calls the wrong origin (CORS errors)** — `NEXT_PUBLIC_API_URL` is baked at build time. Change `PUBLIC_API_URL` in `.env` and re-run `install.sh` so the dashboard is rebuilt with `--no-cache`.
