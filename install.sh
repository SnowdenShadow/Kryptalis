#!/bin/sh
# DockControl — first-boot installer / updater
# ─────────────────────────────────────────────────────────────────────
# Usage on a fresh Ubuntu / Debian VPS (as root):
#
#   curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/DockControl/main/install.sh | sudo sh
#
# Special flags (via env var):
#   DOCKCONTROL_RESET=1   wipe the .env + all docker volumes and reinstall fresh
#                       (DESTRUCTIVE — drops Postgres data, sessions, agent tokens)
#   DOCKCONTROL_REPO      override the source repo
#   DOCKCONTROL_DIR       override the install dir
#   DOCKCONTROL_BRANCH    track a non-main branch
#   PUBLIC_API_URL      force the public URL the dashboard calls
#
# Re-running it is safe — it preserves .env + DB + auto-rebuilds only what's needed.
# ─────────────────────────────────────────────────────────────────────

set -eu

# `sed -i.bak` on .env leaves a .env.bak containing every secret. Clean it
# on ANY exit (success, error, or interrupt) so a failed run can't strand a
# world-readable copy of the secrets next to .env.
cleanup() {
  [ -n "${INSTALL_DIR:-}" ] && rm -f "$INSTALL_DIR/.env.bak" 2>/dev/null || true
  rm -f .env.bak 2>/dev/null || true
}
trap cleanup EXIT INT TERM

REPO_URL="${DOCKCONTROL_REPO:-https://github.com/SnowdenShadow/DockControl.git}"
INSTALL_DIR="${DOCKCONTROL_DIR:-/opt/dockcontrol}"
BRANCH="${DOCKCONTROL_BRANCH:-main}"
RESET="${DOCKCONTROL_RESET:-0}"

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

# ─── 2. install base tools (git, curl, openssl) ─────────────────────
# The installer itself needs git (clone/fetch), curl (Docker bootstrap,
# IP detection, API wait-loop) and openssl (secret generation) — none of
# which a minimal VPS image or get.docker.com guarantees. Same distro
# detection as above: apt for Ubuntu/Debian, dnf/yum/apk as fallbacks.
NEED_PKGS=""
for c in git curl openssl; do
  command -v "$c" >/dev/null 2>&1 || NEED_PKGS="$NEED_PKGS $c"
done
if [ -n "$NEED_PKGS" ]; then
  say "Installing missing tools:$NEED_PKGS"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    # shellcheck disable=SC2086 — NEED_PKGS is a deliberate word list
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $NEED_PKGS ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y $NEED_PKGS ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y $NEED_PKGS ca-certificates
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache $NEED_PKGS ca-certificates
  else
    die "Missing tools ($NEED_PKGS ) and no supported package manager (apt-get/dnf/yum/apk) — install them manually and re-run"
  fi
  ok "Tools installed:$NEED_PKGS"
else
  ok "git / curl / openssl already present"
fi

# ─── 2b. install Docker ──────────────────────────────────────────────
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

# ─── 3. handle DOCKCONTROL_RESET=1 BEFORE touching files ──────────────
# This is the "uninstall + reinstall fresh" path. We do it BEFORE the clone
# so that even a corrupted /opt/dockcontrol directory is recovered.
#
# caddy_data is deliberately PRESERVED: it holds the Let's Encrypt
# certificates + ACME account. Wiping it forces a fresh issuance on every
# reset, and LE rate-limits at 5 certs per exact domain per 7 days — a few
# test resets in a row used to brick the panel domain with
# ERR_SSL_PROTOCOL_ERROR until the window expired (Caddy falls back to a
# staging cert browsers reject). Certs carry no user data; reusing them
# across resets is safe AND keeps the domain working immediately.
# DOCKCONTROL_RESET_CERTS=1 opts into the full wipe if ever needed.
if [ "$RESET" = "1" ]; then
  warn "DOCKCONTROL_RESET=1 — wiping all data (this is destructive)"
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    ( cd "$INSTALL_DIR" && docker compose down --remove-orphans 2>/dev/null || true )
  fi
  for v in $(docker volume ls --quiet --filter "name=dockcontrol" 2>/dev/null); do
    case "$v" in
      *caddy_data*)
        if [ "${DOCKCONTROL_RESET_CERTS:-0}" = "1" ]; then
          docker volume rm "$v" 2>/dev/null || true
        else
          ok "Keeping TLS certificates volume ($v) — avoids Let's Encrypt rate limits"
        fi
        ;;
      *)
        docker volume rm "$v" 2>/dev/null || true
        ;;
    esac
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
  say "Cloning DockControl to $INSTALL_DIR"
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

# The API builds email CTA links from PUBLIC_DASHBOARD_URL — without it
# every production email points at http://localhost:3000. Same host as
# the API, port 3000 (the dashboard's published port). Operators fronting
# the dashboard with a domain via Caddy can override with the env var or
# edit .env later.
if [ -n "${PUBLIC_DASHBOARD_URL:-}" ]; then
  PUBLIC_DASHBOARD_URL_RESOLVED="$PUBLIC_DASHBOARD_URL"
  ok "Using operator-supplied PUBLIC_DASHBOARD_URL=$PUBLIC_DASHBOARD_URL_RESOLVED"
else
  # Swap the API port for the dashboard port; if PUBLIC_API_URL has no
  # :4000 suffix (custom domain), just append :3000 to the same origin.
  case "$PUBLIC_API_URL_RESOLVED" in
    *:4000) PUBLIC_DASHBOARD_URL_RESOLVED=$(printf '%s' "$PUBLIC_API_URL_RESOLVED" | sed 's|:4000$|:3000|') ;;
    *)      PUBLIC_DASHBOARD_URL_RESOLVED="$PUBLIC_API_URL_RESOLVED:3000" ;;
  esac
fi

# ─── 6. .env consistency check ───────────────────────────────────────
# CRITICAL: the Postgres volume bakes POSTGRES_PASSWORD on first init only.
# If we drop the .env without dropping the volume, the API will then mint a
# NEW password and Postgres rejects it forever (P1000 auth failure).
# Solution: if .env is missing BUT a dockcontrol_postgres_data volume exists,
# we wipe the volume too so Postgres re-init with the new password.
NEEDS_DASHBOARD_REBUILD=0

if [ ! -f .env ]; then
  # The dockcontrol_ prefix is guaranteed by `name: dockcontrol` at the top of
  # docker-compose.yml (project name no longer depends on the cwd basename).
  STALE_PG_VOLUME=$(docker volume ls --quiet --filter "name=dockcontrol_postgres_data" 2>/dev/null)
  if [ -n "$STALE_PG_VOLUME" ]; then
    # A Postgres volume WITHOUT a .env means the new random password won't
    # match the one baked into the volume (P1000). The fix is wiping the
    # volume — but that destroys the database, so never do it silently:
    # a merely-misplaced .env would otherwise cost the operator all data.
    if [ "${DOCKCONTROL_RESET:-0}" = "1" ]; then
      warn "DOCKCONTROL_RESET=1 — wiping stale Postgres volume (ALL DATA LOST)"
      docker volume rm "$STALE_PG_VOLUME" 2>/dev/null || true
    else
      die "Found a Postgres data volume but no .env. If the old .env is recoverable, restore it to $INSTALL_DIR/.env and re-run. To start FRESH and DELETE ALL DATA, re-run with DOCKCONTROL_RESET=1."
    fi
  fi

  say "Generating $INSTALL_DIR/.env with secure random secrets"
  JWT_SECRET=$(openssl rand -hex 32)
  JWT_REFRESH_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 16)
  POSTGRES_PASSWORD=$(openssl rand -hex 16)

  cat > .env <<EOF
# DockControl runtime config — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
JWT_SECRET=$JWT_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
PUBLIC_API_URL=$PUBLIC_API_URL_RESOLVED
PUBLIC_DASHBOARD_URL=$PUBLIC_DASHBOARD_URL_RESOLVED
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
    # sed -i.bak inherits the default umask (often 0022 → world-readable);
    # the .bak holds every secret, so lock it down before the trap removes it.
    chmod 600 .env.bak 2>/dev/null || true
    NEEDS_DASHBOARD_REBUILD=1
  else
    ok ".env already exists — leaving it alone"
  fi
  # Older installs never wrote PUBLIC_DASHBOARD_URL → emails pointed at
  # http://localhost:3000. Backfill it (append-only; never overwrite an
  # operator-set value).
  if ! grep -qE '^PUBLIC_DASHBOARD_URL=' .env; then
    say "Backfilling PUBLIC_DASHBOARD_URL=$PUBLIC_DASHBOARD_URL_RESOLVED"
    printf 'PUBLIC_DASHBOARD_URL=%s\n' "$PUBLIC_DASHBOARD_URL_RESOLVED" >> .env
  fi
fi

# ─── 6b. pin the HOST install paths in .env ──────────────────────────
# The compose file falls back to ${PWD} for these, which is only correct
# when `docker compose` runs from the install root ON THE HOST. The
# auto-updater runs compose inside a docker:cli container — there ${PWD}
# would resolve to a container path, making every API-generated bind
# mount (marketplace apps, mail server, Caddyfile) point at host paths
# that don't exist. Pinning the absolute values here makes the stack
# path-stable no matter where compose is invoked from. Rewritten on every
# install run so a moved checkout self-heals.
set_env_var() {
  # set_env_var KEY VALUE — idempotent upsert into .env
  if grep -qE "^$1=" .env; then
    sed -i.bak "s|^$1=.*|$1=$2|" .env
    # The .bak copy holds every secret; sed creates it with the default
    # umask (world-readable). Restrict it before the EXIT trap removes it.
    chmod 600 .env.bak 2>/dev/null || true
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
set_env_var DOCKCONTROL_HOST_INSTALL_DIR "$INSTALL_DIR"
set_env_var DOCKCONTROL_HOST_DATA_DIR "$INSTALL_DIR/.dockcontrol"
rm -f .env.bak
ok "Host paths pinned: DOCKCONTROL_HOST_INSTALL_DIR=$INSTALL_DIR"

# ─── 7. seed the Caddyfile so Caddy can mount it on first boot ──────
# The API regenerates this file on every domain change, but the file MUST exist
# (and be a regular file, not a directory) before `docker compose up` mounts it
# into the Caddy container — otherwise Docker creates an empty dir at that path
# and Caddy crashes with "not a directory".
CADDY_DIR="$INSTALL_DIR/.dockcontrol/reverse-proxy"
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
  email dockcontrol@localhost
}
:80 {
  respond "DockControl: no domain configured yet." 404
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
# Auto-managed by DockControl API — extra Caddy port publications go here.
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
say "Pulling images & starting DockControl..."
docker compose pull 2>&1 | grep -vE "Skipped|^$" || true

if [ "$NEEDS_DASHBOARD_REBUILD" = "1" ]; then
  say "Rebuilding dashboard with --no-cache so Next picks up the new PUBLIC_API_URL"
  docker compose build --no-cache dashboard
fi

docker compose up -d --build --remove-orphans

# ─── 8b. auto-update ─────────────────────────────────────────────────
# Auto-update is handled BY THE API ITSELF (system-updates.service.ts):
# it polls GitHub every 60s for a new commit on the tracked branch and,
# when one lands, spawns update.sh in a one-off docker:cli container
# (with a marker-file mutex so concurrent runs are impossible). No timer,
# no cron, no extra moving parts on the host.
UPDATE_SCRIPT="$INSTALL_DIR/update.sh"
if [ -f "$UPDATE_SCRIPT" ]; then
  chmod +x "$UPDATE_SCRIPT"
fi

# Older installs shipped a dockcontrol-update systemd timer that ran
# update.sh unconditionally every 5 min, racing the in-API updater.
# Remove it if present.
if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/dockcontrol-update.timer ]; then
  say "Removing legacy dockcontrol-update.timer (auto-update now runs inside the API)"
  systemctl disable --now dockcontrol-update.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/dockcontrol-update.timer /etc/systemd/system/dockcontrol-update.service
  systemctl daemon-reload || true
  ok "Legacy auto-update timer removed"
fi

# ─── 9. wait for the API ────────────────────────────────────────────
# Polls /api/settings/public (an unauthenticated endpoint) until it
# answers 200/401 or the 180s deadline passes.
say "Waiting for the API to come up (up to 180s)..."
DEADLINE=$((`date +%s` + 180))
LAST_TICK=$(date +%s)
while :; do
  # NOTE: don't `|| echo 000` on the same line — curl with -w prints the
  # code even on failure (e.g. "401" with -f), so the fallback would
  # CONCATENATE ("401000"). Capture first, then default only if empty.
  CODE=$(curl -fsS -o /dev/null -w "%{http_code}" http://localhost:4000/api/settings/public 2>/dev/null) || true
  [ -n "$CODE" ] || CODE="000"
  if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then
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
│  DockControl is ready                                       │
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
  docker compose down -v              # stop + wipe DB (destructive — also
                                      # deletes TLS certs: prefer the
                                      # DOCKCONTROL_RESET=1 installer flow,
                                      # which keeps them)

Update later — re-run the installer:
  curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/DockControl/$BRANCH/install.sh | sudo sh

Fresh start (drops DB, sessions, agent tokens):
  DOCKCONTROL_RESET=1 sh -c "\$(curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/DockControl/$BRANCH/install.sh)"

EOF
