# DockControl

DockControl is a self-hosted Platform-as-a-Service that turns one or more Linux VPSes into a managed deployment target — the open-source alternative to Heroku, Vercel, or Render. You install it on your own hardware, point a domain at it, and get a dashboard for deploying apps from Git, managing databases, mailboxes, SSL, monitoring, and backups, all without ever SSHing in again.

## Key features

- **Marketplace apps** — one-click install of curated stacks (WordPress, Ghost, n8n, MinIO, Postgres, Redis, …) generated as Docker Compose under `.dockcontrol/apps/`.
- **Custom git deploys** — connect a GitHub / GitLab / Bitbucket repo, pick a branch, get a build + deploy pipeline triggered by webhooks (HMAC-verified on the raw body).
- **Automatic SSL via Caddy** — attach a domain, Caddy provisions a Let's Encrypt cert on the next request, including custom-port HTTPS via an auto-managed `docker-compose.override.yml`.
- **Monitoring + alerts** — per-server CPU / RAM / disk / network metrics with configurable retention, threshold alerts dispatched over SMTP, Discord, Slack, or arbitrary webhooks.
- **Multi-server support** — start in LOCAL mode on a single VPS, flip to MULTI to enroll additional servers via a Go agent (long-poll task queue, concurrency-safe claim).
- **2FA** — TOTP enrolment per user, enforced on next login, recovery codes generated at setup.
- **Encrypted backups** — Postgres / MySQL / app file dumps written to disk with AES-256-GCM (using a dedicated `BACKUP_ENCRYPTION_KEY` siloed from app secrets), SHA-256 verified on restore. Schedulable (hourly / daily / weekly / custom time presets) and uploadable to remote S3-compatible targets (Amazon S3, Cloudflare R2, Backblaze B2).

## Quick install

On a fresh Ubuntu / Debian VPS as root:

```sh
curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/DockControl/main/install.sh | sudo sh
```

The installer is idempotent — re-running it pulls latest, preserves `.env`, and only rebuilds what changed.

## Requirements

- Linux VPS (Ubuntu 22.04+ or Debian 12+ tested; other distros work but are untested).
- Docker Engine 24+ with the `docker compose` plugin.
- 2 GB RAM minimum (4 GB recommended once you start deploying apps).
- Ports **80** and **443** open to the public internet (Caddy + Let's Encrypt HTTP-01).
- Ports **3000** (dashboard) and **4000** (API) reachable on first boot before you wire a domain; both can be put behind Caddy afterwards.
- A public IPv4 address (auto-detected via `api.ipify.org`, override with `PUBLIC_API_URL`).

## Documentation

- [INSTALL.md](./INSTALL.md) — full install walkthrough, SMTP, domains, updates, troubleshooting.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — services, LOCAL vs MULTI, on-disk layout, security model.
- [docs/CONFIG.md](./docs/CONFIG.md) — every `SystemSetting` key, every `.env` bootstrap secret, resolution order.
- [docs/USER_GUIDE.en.md](./docs/USER_GUIDE.en.md) — end-user dashboard guide (also in French).

## License

MIT. Use it, fork it, run it commercially, no strings.

## Contributing

PRs welcome — open an issue first for anything bigger than a typo fix. Run `pnpm install && pnpm dev` from the repo root for a local dev loop (the API and dashboard hot-reload independently). Make sure `docker compose -f docker/docker-compose.dev.yml up -d postgres` is running before booting the API (redis is optional — the API doesn't consume it yet).
