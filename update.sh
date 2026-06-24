#!/bin/sh
# DockControl self-update.
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
# Logs are tee'd to .dockcontrol/update.log so the API can stream them
# back to the dashboard even after `docker compose up -d --build`
# recreates the API container and kills the spawning process's pipes.

set -eu

# Default to the directory this script lives in — works both inside the
# updater container (mounted at /app) and run manually from the host
# checkout (e.g. /opt/dockcontrol). DOCKCONTROL_DIR still overrides.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR="${DOCKCONTROL_DIR:-$SCRIPT_DIR}"
BRANCH="${DOCKCONTROL_BRANCH:-main}"
LOG_DIR="$INSTALL_DIR/.dockcontrol"
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

# Remember the SHA we're on BEFORE the reset, so a later build failure can
# roll the working tree back to it. Without this, a failed build leaves new
# source on disk but the OLD image running — the API then reads the new SHA off
# .git/HEAD and reports "up to date" while stale code is actually serving
# (disk/runtime split-brain). Rollback is scoped to the BUILD failure only:
# once `up` has started recreating containers (and migrations may have run) we
# do NOT roll code back — that could pair old code with a forward-migrated DB.
PREV_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

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

# Build BEFORE up so a build failure rolls the tree back cleanly — no container
# has been touched yet at this point (compose recreates containers only at `up`).
log "→ docker compose build"
if ! run docker compose build; then
  log "ERR: docker compose build failed"
  if [ -n "$PREV_SHA" ]; then
    log "→ rolling working tree back to $PREV_SHA (build failed before any container changed)"
    run git reset --hard "$PREV_SHA" || true
  fi
  exit 1
fi

# `--wait` makes the exit code reflect REAL health, not just "containers
# started". The api entrypoint (docker-start.sh) runs `prisma migrate deploy`
# before `node dist/main`; a failed migration crashloops the container under
# `restart: unless-stopped`. Plain `up -d` returns 0 the instant the container
# is STARTED, so a crash-looping API used to be reported as a successful update.
# With `--wait --wait-timeout`, compose blocks until every service is healthy
# (or the timeout elapses) and returns non-zero otherwise — so the wrapper
# records a real failure and the dashboard shows ERROR instead of "✓ up to date".
log "→ docker compose up -d --wait --wait-timeout 300 --remove-orphans"
if ! run docker compose up -d --wait --wait-timeout 300 --remove-orphans; then
  log "ERR: docker compose up failed or the stack did not become healthy in time"
  exit 1
fi

date -u +'[%Y-%m-%dT%H:%M:%SZ] ✓ update complete' | tee -a "$LOG_FILE"
