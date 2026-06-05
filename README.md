# Kryptalis

Self-hosted infrastructure platform — deploy apps from Git, manage domains, databases,
mail hosting, and multi-server fleets from a single dashboard.

Open-source alternative to Coolify / Dokploy / CapRover.

---

## Quick install (fresh VPS)

On a fresh Ubuntu / Debian VPS, as root:

```sh
curl -fsSL https://raw.githubusercontent.com/kryptalis/kryptalis/main/install.sh | sudo sh
```

This script will:

1. Install Docker + the `docker compose` plugin if missing
2. Clone Kryptalis to `/opt/kryptalis`
3. Generate `/opt/kryptalis/.env` with random secrets (Postgres password, JWT, encryption key)
4. Bring up the full stack: Postgres + Redis + Caddy + API + Dashboard
5. Wait for the API to be ready, then print the dashboard URL

Re-run any time — it preserves your `.env` and skips already-done steps.

Then:

- Open `http://<server-ip>:3000`
- Create the first account → automatically promoted to **SUPERADMIN**
- (Optional) Settings → Admin → switch `deployment_mode` to `MULTI` to add more servers

### Environment overrides

| Variable | Default | Meaning |
| --- | --- | --- |
| `KRYPTALIS_REPO` | `https://github.com/kryptalis/kryptalis.git` | Source repo |
| `KRYPTALIS_DIR` | `/opt/kryptalis` | Install directory |
| `KRYPTALIS_BRANCH` | `main` | Branch to track |
| `PUBLIC_API_URL` | `http://localhost:4000` | URL the API is reachable at (set when behind a domain) |

---

## Adding extra servers (MULTI mode)

When deployment mode is `MULTI`:

1. **Dashboard → Servers → Add Server** (ADMIN+ only)
2. Copy the install command shown in the dialog (valid 24h)
3. Run it on the new VPS as root:

   ```sh
   curl -fsSL https://<your-api>/api/agent/install.sh?token=<token> | sudo sh
   ```

4. The agent:
   - Installs Docker
   - Downloads itself from `/api/agent/binary?arch=<amd64|arm64>`
   - Calls `/api/agent/register` with the install token
   - Sets up a `kryptalis-agent` systemd unit
   - Long-polls for tasks (`DEPLOY`, `START`, `STOP`, `RESTART`, `REMOVE`,
     `LOGS`, `EXEC`, `STATUS`, `FILE_READ`, `FILE_WRITE`)

The server shows `ONLINE` in the dashboard within ~30 seconds.

### Per-row server actions

| Status | Available |
| --- | --- |
| `PENDING_INSTALL` / `OFFLINE` | Show install command (regenerates the token) |
| `ONLINE` | Rotate token (forces re-register) |
| Any non-local | Reset (wipes metrics + token, keeps projects) |
| Any non-local | Delete (cascades projects when confirmed) |

The local 127.0.0.1 server is never reset/deleted — it runs Kryptalis itself.

---

## Architecture

```
┌──────────────────┐        ┌───────────────────────────────┐
│  Browser         │ ─────► │  Dashboard (Next.js)          │
└──────────────────┘        │  Port 3000                    │
                            └───────────────┬───────────────┘
                                            │ REST + JWT
                                            ▼
                            ┌───────────────────────────────┐
                            │  API (NestJS)                 │
                            │  Port 4000                    │
                            │                               │
                            │  • RBAC (project members)     │
                            │  • SystemSetting (single src) │
                            │  • Reverse proxy (Caddyfile)  │
                            │  • Webhooks (raw-body HMAC)   │
                            └─┬─────────────────────────┬───┘
                              │                         │
                ┌─────────────▼───┐         ┌───────────▼────────┐
                │ Local Docker    │         │ AgentTask queue    │
                │ (host server)   │         │ (Postgres)         │
                └─────────────────┘         └───────────┬────────┘
                                                        │ HTTP poll
                                                        ▼
                                            ┌──────────────────────┐
                                            │ kryptalis-agent      │
                                            │ (Go, on each VPS)    │
                                            │                      │
                                            │ • docker compose     │
                                            │ • /proc metrics      │
                                            │ • git clone + build  │
                                            └──────────────────────┘
```

### Lifecycle routing

`ApplicationsService` resolves the target server via `project.serverId`:

- `host ∈ {127.0.0.1, localhost, ::1}` → runs `docker compose` directly on the API host
- otherwise → enqueues a typed `AgentTask` the remote agent picks up

Synchronous calls (`logs`, `exec`) use `enqueueAndWait` with a timeout; async
ones (`deploy`, `start`, `stop`, `restart`, `remove`) fire-and-forget.

### Concurrency-safe task claim

The poll endpoint uses Postgres `SELECT ... FOR UPDATE SKIP LOCKED` so two
agents sharing the same token can never both claim the same task. Required
the day you add HA / a second agent, present from day one.

### Per-project Docker network

Every project gets a dedicated user-defined bridge:

```
kryptalis_proj_<slug>
```

All apps in the same project join it via
`networks: { kryptalis_project: { external: true, name } }`
so service-to-service DNS just works (`http://api/`, `http://worker/`, …).

---

## Repository layout

```
apps/
  api/        NestJS backend (Prisma + Postgres)
  dashboard/  Next.js 15 + React Query frontend
  agent/      Go binary deployed on remote VPS
docker-compose.yml      Root stack
install.sh              First-boot installer
```

---

## Build the agent (one-time)

The API serves the agent binary from
`apps/agent/bin/kryptalis-agent-linux-<arch>`. Build it on any machine with
Go ≥ 1.21:

```sh
cd apps/agent
./build.sh
```

This produces `bin/kryptalis-agent-linux-amd64` and
`bin/kryptalis-agent-linux-arm64`. The API container picks them up at next
start (no rebuild needed).

---

## Security notes

- The first user to register becomes **SUPERADMIN**; subsequent signups can
  be disabled via `Admin → Settings → registration_enabled`.
- Postgres and Redis bind to `127.0.0.1` only — never exposed publicly.
- Compose refuses to start if `POSTGRES_PASSWORD`, `JWT_SECRET`,
  `JWT_REFRESH_SECRET`, or `ENCRYPTION_KEY` are missing (no dev defaults
  in production).
- Git tokens injected via `http.extraheader`, never persisted to
  `.git/config`.
- Webhook HMAC verified against the **raw** request bytes
  (GitHub / GitLab / Bitbucket). Bitbucket without a signature header is
  rejected — `x-event-key` alone is not authentication.
- All `exec` paths use `execFile` with argv arrays — no shell interpolation.
- Agent file-tasks reject any path containing `..`.

---

## Useful commands

```sh
cd /opt/kryptalis
docker compose logs -f api          # follow API logs
docker compose ps                   # container health
docker compose down                 # stop everything
docker compose up -d --pull always  # update
```

---

## License

MIT
