#!/bin/sh
# Kryptalis self-update.
#
# The Nest API is the auto-update brain (system-updates.service.ts): it
# polls GitHub every 60s and, when a new commit lands on the tracked
# branch, runs this script inside a one-off `docker run --rm docker:cli`
# container with the install dir + the host docker socket bind-mounted in
# (a marker-file mutex in the API prevents concurrent runs).
#
# Manual usage on the host:
#   ./update.sh           apply: fetch + reset to origin/<branch> + rebuild
#   ./update.sh --check   report only — exit 0 if up to date, 1 if behind
#   ./update.sh --force   same as no-arg (kept for symmetry with the docs)
#
# Logs are tee'd to .kryptalis/update.log so the API can stream them
# back to the dashboard even after `docker compose up -d --build`
# recreates the API container and kills the spawning process's pipes.

set -eu

INSTALL_DIR="${KRYPTALIS_DIR:-/app}"
BRANCH="${KRYPTALIS_BRANCH:-main}"
LOG_DIR="$INSTALL_DIR/.kryptalis"
LOG_FILE="$LOG_DIR/update.log"
MODE="${1:-apply}"

mkdir -p "$LOG_DIR"

cd "$INSTALL_DIR" 2>/dev/null || { echo "ERR: $INSTALL_DIR not present" | tee -a "$LOG_FILE"; exit 1; }
[ -d .git ] || { echo "ERR: $INSTALL_DIR is not a git checkout" | tee -a "$LOG_FILE"; exit 1; }

# docker:cli is alpine-based — install git lazily (cached after first run).
command -v git >/dev/null 2>&1 || apk add --no-cache git >>"$LOG_FILE" 2>&1

# --check: compare local HEAD to origin/<branch> without modifying anything.
if [ "$MODE" = "--check" ]; then
  git fetch --depth=1 origin "$BRANCH" >/dev/null 2>&1 || { echo "ERR: git fetch failed"; exit 2; }
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$BRANCH")
  if [ "$LOCAL" = "$REMOTE" ]; then
    echo "up to date ($LOCAL)"
    exit 0
  fi
  echo "update available: $LOCAL → $REMOTE"
  exit 1
fi

# Reset the log for this run. Caller (API) tracks position by reading
# size after each update finishes; keeping it short is fine.
date -u +'[%Y-%m-%dT%H:%M:%SZ] === update start ===' > "$LOG_FILE"

log() { echo "$*" | tee -a "$LOG_FILE"; }
# Mirror command output to the log AND propagate the command's exit code.
# A plain `cmd | tee` returns tee's status (always 0), which made every
# failed fetch/reset/build log "✓ update complete". POSIX sh has no
# pipefail, so capture the real status through a temp file.
run() {
  _rc_file=$(mktemp)
  { "$@" 2>&1; echo "$?" >"$_rc_file"; } | tee -a "$LOG_FILE"
  _rc=$(cat "$_rc_file")
  rm -f "$_rc_file"
  return "$_rc"
}

log "→ fetching origin/$BRANCH"
if ! run git fetch --depth=1 origin "$BRANCH"; then
  log "ERR: git fetch failed"
  exit 1
fi

log "→ resetting to origin/$BRANCH"
if ! run git reset --hard "origin/$BRANCH"; then
  log "ERR: git reset failed"
  exit 1
fi

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
