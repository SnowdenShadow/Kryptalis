#!/bin/sh
# Kryptalis self-update.
#
# Idempotent: git fetch + reset + docker compose up -d --build.
#
# Triggered exclusively by the Nest API (SystemUpdatesService) when its
# 60s GitHub poll spots a new commit on the tracked branch. No systemd
# timer, no status file, no auto-update.pref — that's all gone.
#
# The Nest service spawns this via `docker run --rm docker:cli` with
# the install dir + host docker socket mounted, so all `docker compose`
# calls below talk to the host daemon.

set -eu

INSTALL_DIR="${KRYPTALIS_DIR:-/app}"
BRANCH="${KRYPTALIS_BRANCH:-main}"

cd "$INSTALL_DIR" 2>/dev/null || { echo "ERR: $INSTALL_DIR not present"; exit 1; }
[ -d .git ] || { echo "ERR: $INSTALL_DIR is not a git checkout"; exit 1; }

# Make sure git is available (alpine image already includes it).
command -v git >/dev/null 2>&1 || apk add --no-cache git >/dev/null 2>&1

echo "→ fetching origin/$BRANCH"
git fetch --depth=1 origin "$BRANCH"

echo "→ resetting to origin/$BRANCH"
git reset --hard "origin/$BRANCH"

# Windows checkouts drop the +x bit on shell scripts — restore.
chmod +x "$INSTALL_DIR/update.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/install.sh" 2>/dev/null || true

echo "→ docker compose pull"
docker compose pull || true

echo "→ docker compose up -d --build --remove-orphans"
docker compose up -d --build --remove-orphans

echo "✓ update complete"
