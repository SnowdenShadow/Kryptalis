#!/bin/sh
# Kryptalis — first-boot installer / updater
# ─────────────────────────────────────────────────────────────────────
# Usage on a fresh Ubuntu / Debian VPS (as root):
#
#   curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/Kryptalis/main/install.sh | sudo sh
#
# Special flags (via env var):
#   KRYPTALIS_RESET=1   wipe the .env + all docker volumes and reinstall fresh
#                       (DESTRUCTIVE — drops Postgres data, sessions, agent tokens)
#   KRYPTALIS_REPO      override the source repo
#   KRYPTALIS_DIR       override the install dir
#   KRYPTALIS_BRANCH    track a non-main branch
#   PUBLIC_API_URL      force the public URL the dashboard calls
#
# Re-running it is safe — it preserves .env + DB + auto-rebuilds only what's needed.
# ─────────────────────────────────────────────────────────────────────

set -eu

REPO_URL="${KRYPTALIS_REPO:-https://github.com/SnowdenShadow/Kryptalis.git}"
INSTALL_DIR="${KRYPTALIS_DIR:-/opt/kryptalis}"
BRANCH="${KRYPTALIS_BRANCH:-main}"
RESET="${KRYPTALIS_RESET:-0}"

# ─── helpers ────────────────────────────────────────────────────────
say()  { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)"

# ─── 1. detect OS ────────────────────────────────────────────────────
if [ -f /etc/os-release ]; then . /etc/os-release; OS_ID="$ID"; else die "/etc/os-release not found"; fi
case "$OS_ID" in
  ubuntu|debian) ok "Detected $PRETTY_NAME" ;;
  *) warn "Untested OS ($OS_ID) — proceeding anyway" ;;
esac

# ─── 2. install Docker ───────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  ok "Docker already installed: $(docker --version)"
else
  say "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "Docker installed"
fi

if docker compose version >/dev/null 2>&1; then
  ok "docker compose plugin present"
else
  die "docker compose plugin missing — please install it"
fi

# ─── 3. handle KRYPTALIS_RESET=1 BEFORE touching files ──────────────
# This is the "uninstall + reinstall fresh" path. We do it BEFORE the clone
# so that even a corrupted /opt/kryptalis directory is recovered.
if [ "$RESET" = "1" ]; then
  warn "KRYPTALIS_RESET=1 — wiping all data (this is destructive)"
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    ( cd "$INSTALL_DIR" && docker compose down -v --remove-orphans 2>/dev/null || true )
  fi
  # Catch any stray volumes that survived (e.g. project name mismatch from older installs)
  for v in $(docker volume ls --quiet --filter "name=kryptalis" 2>/dev/null); do
    docker volume rm "$v" 2>/dev/null || true
  done
  rm -rf "$INSTALL_DIR"
  ok "Cleaned previous state"
fi

# ─── 4. clone / update repo ──────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing checkout at $INSTALL_DIR"
  cd "$INSTALL_DIR"
  git fetch --depth=1 origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  say "Cloning Kryptalis to $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ─── 5. detect the public IP / hostname the browser will use ─────────
# The dashboard's API URL is baked into the build (Next inlines NEXT_PUBLIC_*),
# so we need to know it BEFORE `docker compose up`. Order of precedence:
#   1. PUBLIC_API_URL env var the operator set explicitly
#   2. ipify.org (public IPv4)
#   3. `hostname -I` first non-loopback address
DETECTED_HOST=""
if [ -z "${PUBLIC_API_URL:-}" ]; then
  DETECTED_HOST=$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || true)
  if [ -z "$DETECTED_HOST" ]; then
    DETECTED_HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  if [ -z "$DETECTED_HOST" ]; then
    DETECTED_HOST="localhost"
    warn "Could not detect a public IP — falling back to localhost. Edit .env later and set PUBLIC_API_URL."
  else
    ok "Detected public address: $DETECTED_HOST"
  fi
  PUBLIC_API_URL_RESOLVED="http://$DETECTED_HOST:4000"
else
  PUBLIC_API_URL_RESOLVED="$PUBLIC_API_URL"
  ok "Using operator-supplied PUBLIC_API_URL=$PUBLIC_API_URL_RESOLVED"
fi

# ─── 6. .env consistency check ───────────────────────────────────────
# CRITICAL: the Postgres volume bakes POSTGRES_PASSWORD on first init only.
# If we drop the .env without dropping the volume, the API will then mint a
# NEW password and Postgres rejects it forever (P1000 auth failure).
# Solution: if .env is missing BUT a kryptalis_postgres_data volume exists,
# we wipe the volume too so Postgres re-init with the new password.
NEEDS_DASHBOARD_REBUILD=0

if [ ! -f .env ]; then
  STALE_PG_VOLUME=$(docker volume ls --quiet --filter "name=kryptalis_postgres_data" 2>/dev/null)
  if [ -n "$STALE_PG_VOLUME" ]; then
    warn "Found a Postgres volume from a previous install but no .env — wiping it"
    docker volume rm $STALE_PG_VOLUME 2>/dev/null || true
  fi
  # Same logic for redis (less critical, but ensures clean state)
  STALE_REDIS_VOLUME=$(docker volume ls --quiet --filter "name=kryptalis_redis_data" 2>/dev/null)
  if [ -n "$STALE_REDIS_VOLUME" ]; then
    docker volume rm $STALE_REDIS_VOLUME 2>/dev/null || true
  fi

  say "Generating $INSTALL_DIR/.env with secure random secrets"
  JWT_SECRET=$(openssl rand -hex 32)
  JWT_REFRESH_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 16)
  POSTGRES_PASSWORD=$(openssl rand -hex 16)

  cat > .env <<EOF
# Kryptalis runtime config — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
JWT_SECRET=$JWT_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
PUBLIC_API_URL=$PUBLIC_API_URL_RESOLVED
EOF
  chmod 600 .env
  ok ".env created (kept private at $INSTALL_DIR/.env)"
  NEEDS_DASHBOARD_REBUILD=1
else
  # .env exists — refresh PUBLIC_API_URL if it has drifted (e.g. operator changed
  # PUBLIC_API_URL env between runs, or the public IP rotated).
  CURRENT_URL=$(grep -E '^PUBLIC_API_URL=' .env | head -1 | cut -d= -f2- || true)
  if [ "$CURRENT_URL" != "$PUBLIC_API_URL_RESOLVED" ]; then
    say "PUBLIC_API_URL changed: $CURRENT_URL → $PUBLIC_API_URL_RESOLVED"
    sed -i.bak "s|^PUBLIC_API_URL=.*|PUBLIC_API_URL=$PUBLIC_API_URL_RESOLVED|" .env
    NEEDS_DASHBOARD_REBUILD=1
  else
    ok ".env already exists — leaving it alone"
  fi
fi

# ─── 7. seed the Caddyfile so Caddy can mount it on first boot ──────
# The API regenerates this file on every domain change, but the file MUST exist
# (and be a regular file, not a directory) before `docker compose up` mounts it
# into the Caddy container — otherwise Docker creates an empty dir at that path
# and Caddy crashes with "not a directory".
CADDY_DIR="$INSTALL_DIR/.kryptalis/reverse-proxy"
CADDY_FILE="$CADDY_DIR/Caddyfile"
mkdir -p "$CADDY_DIR"
if [ -d "$CADDY_FILE" ] && [ ! -f "$CADDY_FILE" ]; then
  rmdir "$CADDY_FILE" 2>/dev/null || rm -rf "$CADDY_FILE"
fi
if [ ! -f "$CADDY_FILE" ]; then
  cat > "$CADDY_FILE" <<'CADDYEOF'
# Seeded by install.sh — the API rewrites this once domains are created.
{
  admin :2019
  email kryptalis@localhost
}
:80 {
  respond "Kryptalis: no domain configured yet." 404
}
CADDYEOF
fi

# ─── 7b. seed the docker-compose override the API maintains ─────────
# The API writes extra Caddy port publications here (e.g. 5000:5000 so
# https://athexis.xyz:5000 hits Caddy with a valid Let's Encrypt cert).
# The file MUST exist before `docker compose up` so the bind mount works
# (otherwise Docker creates an empty dir at that path).
OVERRIDE_FILE="$INSTALL_DIR/docker-compose.override.yml"
if [ -d "$OVERRIDE_FILE" ] && [ ! -f "$OVERRIDE_FILE" ]; then
  rmdir "$OVERRIDE_FILE" 2>/dev/null || rm -rf "$OVERRIDE_FILE"
fi
if [ ! -f "$OVERRIDE_FILE" ]; then
  cat > "$OVERRIDE_FILE" <<'OVEREOF'
# Auto-managed by Kryptalis API — extra Caddy port publications go here.
# Edit nothing; the file is rewritten on every domain/port change.
services:
  caddy:
    ports: []
OVEREOF
fi

# ─── 8. start the stack ──────────────────────────────────────────────
# IMPORTANT: when PUBLIC_API_URL changes we MUST rebuild the dashboard without
# cache, otherwise Next reuses the old inlined URL and the browser keeps calling
# the wrong origin (CORS error).
say "Pulling images & starting Kryptalis..."
docker compose pull 2>&1 | grep -vE "Skipped|^$" || true

if [ "$NEEDS_DASHBOARD_REBUILD" = "1" ]; then
  say "Rebuilding dashboard with --no-cache so Next picks up the new PUBLIC_API_URL"
  docker compose build --no-cache dashboard
fi

docker compose up -d --build --remove-orphans

# ─── 8b. install auto-update systemd timer ──────────────────────────
# Runs update.sh every 30 SECONDS — checks origin/main via the GitHub API
# (no auth required, 60 req/h limit is well under our cadence), rebuilds only
# if the upstream SHA changed. A no-op check is ~100ms and writes nothing to
# disk, so polling this aggressively is essentially free.
#
# This is what makes updates feel "instant" to end-users: ~30s between
# `git push` and their install starting the rebuild. No webhook, no
# third-party service, no per-install configuration.
#
# Toggleable from the dashboard (writes `auto-update.pref` which update.sh
# honours) or via KRYPTALIS_NO_AUTOUPDATE=1.
UPDATE_SCRIPT="$INSTALL_DIR/update.sh"
if [ -f "$UPDATE_SCRIPT" ]; then
  chmod +x "$UPDATE_SCRIPT"
fi

if [ "${KRYPTALIS_NO_AUTOUPDATE:-0}" = "1" ]; then
  warn "KRYPTALIS_NO_AUTOUPDATE=1 — skipping auto-update timer install"
elif [ ! -f "$UPDATE_SCRIPT" ]; then
  warn "update.sh missing — auto-update will be installed on the next sync"
elif ! command -v systemctl >/dev/null 2>&1; then
  warn "systemd not detected — auto-update timer skipped (use cron manually)"
else
  say "Installing kryptalis-update.timer (checks every 10 min)"
  cat > /etc/systemd/system/kryptalis-update.service <<EOF
[Unit]
Description=Kryptalis self-update (pull latest from origin/$BRANCH, rebuild if changed)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=KRYPTALIS_DIR=$INSTALL_DIR
Environment=KRYPTALIS_BRANCH=$BRANCH
ExecStart=$UPDATE_SCRIPT
# Don't fail the unit if the script logs an error — it writes status to JSON
SuccessExitStatus=0 1
EOF

  cat > /etc/systemd/system/kryptalis-update.timer <<EOF
[Unit]
Description=Run Kryptalis self-update every 30 seconds
Requires=kryptalis-update.service

[Timer]
# First run 1 min after boot (let docker settle), then every 30 seconds.
# update.sh polls the GitHub API with If-None-Match — when the upstream SHA
# is unchanged, GitHub returns 304 Not Modified WITHOUT consuming the 60/h
# anonymous quota. So even at 120 req/h cadence we sit at 0 quota cost in
# steady state, and the latency between \`git push\` and rebuild start is
# at most ~30 seconds. No webhook, no third-party service, no config.
OnBootSec=1min
OnUnitActiveSec=30s
Unit=kryptalis-update.service
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now kryptalis-update.timer >/dev/null 2>&1 && \
    ok "Auto-update enabled (kryptalis-update.timer)" || \
    warn "Could not enable auto-update timer (continuing)"
fi

# ─── 9. wait for the API ────────────────────────────────────────────
say "Waiting for the API to come up (up to 180s)..."
DEADLINE=$((`date +%s` + 180))
LAST_TICK=$(date +%s)
while :; do
  CODE=$(curl -fsS -o /dev/null -w "%{http_code}" http://localhost:4000/api/settings/public 2>/dev/null || echo "000")
  if echo "$CODE" | grep -qE "200|401"; then
    ok "API ready"
    break
  fi
  NOW=$(date +%s)
  # tick every 15s so the user knows we're still alive
  if [ $((NOW - LAST_TICK)) -ge 15 ]; then
    say "  ...still waiting (status: $CODE)"
    LAST_TICK=$NOW
  fi
  if [ "$NOW" -ge "$DEADLINE" ]; then
    warn "API did not come up in 180s"
    echo
    docker compose logs --tail 40 api
    echo
    warn "Diagnostics above. Try: docker compose logs -f api"
    break
  fi
  sleep 2
done

# ─── 10. final hint ─────────────────────────────────────────────────
HOST_IP=$(curl -fsSL --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
cat <<EOF

╭───────────────────────────────────────────────────────────╮
│  Kryptalis is ready                                       │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  Dashboard: http://$HOST_IP:3000
│  API:       http://$HOST_IP:4000/api
│                                                           │
│  → Open the dashboard and create the first account.       │
│    The first user gets SUPERADMIN automatically.          │
│                                                           │
╰───────────────────────────────────────────────────────────╯

Useful commands:
  cd $INSTALL_DIR
  docker compose logs -f api          # follow API logs
  docker compose ps                   # container health
  docker compose restart api          # restart just the API
  docker compose down                 # stop everything
  docker compose down -v              # stop + wipe DB (destructive)

Update later — re-run the installer:
  curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/Kryptalis/$BRANCH/install.sh | sudo sh

Fresh start (drops DB, sessions, agent tokens):
  KRYPTALIS_RESET=1 sh -c "\$(curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/Kryptalis/$BRANCH/install.sh)"

EOF
