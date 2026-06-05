#!/bin/sh
# Kryptalis — first-boot installer
# ─────────────────────────────────────────────────────────────────────
# Usage on a fresh Ubuntu / Debian VPS (as root):
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/kryptalis/main/install.sh | sudo sh
#
# Or after cloning:  sudo ./install.sh
#
# What it does:
#   1. Installs Docker + docker compose plugin
#   2. Clones (or updates) Kryptalis to /opt/kryptalis
#   3. Writes a .env with secure random secrets
#   4. Brings the full stack up (postgres + redis + caddy + api + dashboard)
#   5. Prints the dashboard URL + initial credentials
#
# Re-running it is safe — it skips already-completed steps.
# ─────────────────────────────────────────────────────────────────────

set -eu

REPO_URL="${KRYPTALIS_REPO:-https://github.com/SnowdenShadow/Kryptalis.git}"
INSTALL_DIR="${KRYPTALIS_DIR:-/opt/kryptalis}"
BRANCH="${KRYPTALIS_BRANCH:-main}"
PUBLIC_URL_DEFAULT="${PUBLIC_API_URL:-http://localhost:4000}"

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

# ─── 3. clone / update repo ──────────────────────────────────────────
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

# ─── 4. .env (preserve existing) ─────────────────────────────────────
if [ ! -f .env ]; then
  say "Generating /opt/kryptalis/.env with secure random secrets"
  JWT_SECRET=$(openssl rand -hex 32)
  JWT_REFRESH_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 16)
  POSTGRES_PASSWORD=$(openssl rand -hex 16)
  PUBLIC_URL="${PUBLIC_API_URL:-$PUBLIC_URL_DEFAULT}"

  cat > .env <<EOF
# Kryptalis runtime config — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
JWT_SECRET=$JWT_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
PUBLIC_API_URL=$PUBLIC_URL
EOF
  chmod 600 .env
  ok ".env created (kept private at /opt/kryptalis/.env)"
else
  ok ".env already exists — leaving it alone"
fi

# ─── 5. start the stack ──────────────────────────────────────────────
say "Pulling images & starting Kryptalis..."
docker compose pull
docker compose up -d --remove-orphans

# Wait for the API to answer
say "Waiting for the API to come up..."
DEADLINE=$((`date +%s` + 120))
while :; do
  if curl -fsS -o /dev/null -w "%{http_code}" http://localhost:4000/api/settings/public | grep -qE "200|401"; then
    ok "API ready"
    break
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    warn "API did not come up in 120s — check: docker compose logs api"
    break
  fi
  sleep 2
done

# ─── 6. final hint ───────────────────────────────────────────────────
HOST_IP=$(curl -fsSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
cat <<EOF

╭───────────────────────────────────────────────────────────╮
│  Kryptalis is ready                                       │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  Dashboard: http://$HOST_IP:3000                           │
│  API:       http://$HOST_IP:4000/api                       │
│                                                           │
│  → Open the dashboard and create the first account.       │
│    The first user gets SUPERADMIN automatically.          │
│                                                           │
╰───────────────────────────────────────────────────────────╯

Useful:
  cd /opt/kryptalis
  docker compose logs -f api          # follow API logs
  docker compose ps                   # container health
  docker compose down                 # stop everything
  docker compose up -d --pull always  # update

EOF
