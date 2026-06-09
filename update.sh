#!/bin/sh
# Kryptalis self-update.
#
# Triggered by the Nest API when its 60s GitHub poll spots a new commit
# on the tracked branch. Runs inside a one-off `docker run --rm docker:cli`
# container with the install dir + the host docker socket bind-mounted in.
#
# Logs are tee'd to .kryptalis/update.log so the API can stream them
# back to the dashboard even after `docker compose up -d --build`
# recreates the API container and kills the spawning process's pipes.

set -eu

INSTALL_DIR="${KRYPTALIS_DIR:-/app}"
BRANCH="${KRYPTALIS_BRANCH:-main}"
LOG_DIR="$INSTALL_DIR/.kryptalis"
LOG_FILE="$LOG_DIR/update.log"

mkdir -p "$LOG_DIR"

cd "$INSTALL_DIR" 2>/dev/null || { echo "ERR: $INSTALL_DIR not present" | tee -a "$LOG_FILE"; exit 1; }
[ -d .git ] || { echo "ERR: $INSTALL_DIR is not a git checkout" | tee -a "$LOG_FILE"; exit 1; }

# docker:cli is alpine-based — install git lazily (cached after first run).
command -v git >/dev/null 2>&1 || apk add --no-cache git >>"$LOG_FILE" 2>&1

# Reset the log for this run. Caller (API) tracks position by reading
# size after each update finishes; keeping it short is fine.
date -u +'[%Y-%m-%dT%H:%M:%SZ] === update start ===' > "$LOG_FILE"

log() { echo "$*" | tee -a "$LOG_FILE"; }
run() { "$@" 2>&1 | tee -a "$LOG_FILE"; }

log "→ fetching origin/$BRANCH"
run git fetch --depth=1 origin "$BRANCH"

log "→ resetting to origin/$BRANCH"
run git reset --hard "origin/$BRANCH"

# Windows checkouts drop the +x bit on shell scripts — restore.
chmod +x "$INSTALL_DIR/update.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/install.sh" 2>/dev/null || true

log "→ docker compose pull"
run docker compose pull || true

log "→ docker compose up -d --build --remove-orphans"
if ! run docker compose up -d --build --remove-orphans; then
  log "ERR: docker compose up failed"
  exit 1
fi

date -u +'[%Y-%m-%dT%H:%M:%SZ] ✓ update complete' | tee -a "$LOG_FILE"
