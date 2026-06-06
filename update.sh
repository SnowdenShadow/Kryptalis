#!/bin/sh
# Kryptalis — self-update script
# ─────────────────────────────────────────────────────────────────────
# Runs every ~10 min from a systemd timer (installed by install.sh).
# Idempotent: if no new commit on origin/<branch>, exits in <1s.
# Otherwise: git pull → docker compose pull → docker compose up -d --build.
#
# Status is written to .kryptalis/update-status.json so the dashboard can
# show "you're up to date" / "update in progress" / "new version available".
#
# Manual usage:
#   sudo /opt/kryptalis/update.sh           # check + apply if needed
#   sudo /opt/kryptalis/update.sh --check   # just check, don't apply
#   sudo /opt/kryptalis/update.sh --force   # rebuild even if no new commit
# ─────────────────────────────────────────────────────────────────────

set -eu

INSTALL_DIR="${KRYPTALIS_DIR:-/opt/kryptalis}"
BRANCH="${KRYPTALIS_BRANCH:-main}"
STATUS_DIR="$INSTALL_DIR/.kryptalis"
STATUS_FILE="$STATUS_DIR/update-status.json"
LOCK_FILE="$STATUS_DIR/update.lock"
LOG_FILE="$STATUS_DIR/update.log"

CHECK_ONLY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

cd "$INSTALL_DIR" 2>/dev/null || { echo "Not installed at $INSTALL_DIR"; exit 1; }
[ -d .git ] || { echo "$INSTALL_DIR is not a git checkout"; exit 1; }

mkdir -p "$STATUS_DIR"

# ─── respect dashboard auto-update toggle ───────────────────────────
# The dashboard writes "disabled" to this file when the operator turns auto-
# update off. We honour it for both scheduled and --check runs; --force still
# applies (manual override). This is the in-container signal — the systemd
# timer keeps firing but the script no-ops politely.
PREF_FILE="$STATUS_DIR/auto-update.pref"
if [ "$FORCE" = "0" ] && [ "$CHECK_ONLY" = "0" ] && [ -f "$PREF_FILE" ] && grep -q "disabled" "$PREF_FILE" 2>/dev/null; then
  # Still keep the status fresh so the UI can show "disabled" without
  # confusing the user with stale timestamps.
  CUR=$(git rev-parse HEAD 2>/dev/null || echo "")
  cat > "$STATUS_FILE" <<EOF
{
  "state": "UP_TO_DATE",
  "message": "Auto-update is disabled (toggle in dashboard).",
  "currentSha": "$CUR",
  "latestSha": "",
  "branch": "$BRANCH",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  exit 0
fi

# ─── lock — prevent concurrent runs (timer + manual click) ──────────
if [ -e "$LOCK_FILE" ]; then
  PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Another update is already running (pid $PID)"; exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ─── status helpers ─────────────────────────────────────────────────
write_status() {
  # args: state message currentSha latestSha
  STATE="$1"; MSG="$2"; CUR="${3:-}"; LATEST="${4:-}"
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Escape backslashes and double quotes for JSON safety.
  ESCAPED_MSG=$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r')
  cat > "$STATUS_FILE" <<EOF
{
  "state": "$STATE",
  "message": "$ESCAPED_MSG",
  "currentSha": "$CUR",
  "latestSha": "$LATEST",
  "branch": "$BRANCH",
  "updatedAt": "$TS"
}
EOF
}

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG_FILE"; }
trim_log() { tail -n 500 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" || true; }

# ─── fetch & compare ────────────────────────────────────────────────
CURRENT=$(git rev-parse HEAD)
git fetch --depth=1 origin "$BRANCH" >/dev/null 2>&1 || {
  write_status "ERROR" "git fetch failed" "$CURRENT" ""
  log "git fetch failed"
  exit 1
}
LATEST=$(git rev-parse "origin/$BRANCH")

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$CURRENT" = "$LATEST" ] && [ "$FORCE" = "0" ]; then
    write_status "UP_TO_DATE" "No new commits" "$CURRENT" "$LATEST"
  else
    write_status "UPDATE_AVAILABLE" "New commit on origin/$BRANCH" "$CURRENT" "$LATEST"
  fi
  exit 0
fi

if [ "$CURRENT" = "$LATEST" ] && [ "$FORCE" = "0" ]; then
  write_status "UP_TO_DATE" "No new commits" "$CURRENT" "$LATEST"
  exit 0
fi

# ─── apply ──────────────────────────────────────────────────────────
write_status "UPDATING" "Pulling new code from origin/$BRANCH" "$CURRENT" "$LATEST"
log "Updating $CURRENT → $LATEST"

if ! git reset --hard "origin/$BRANCH" >>"$LOG_FILE" 2>&1; then
  write_status "ERROR" "git reset failed" "$CURRENT" "$LATEST"
  trim_log
  exit 1
fi

write_status "UPDATING" "Pulling docker images" "$LATEST" "$LATEST"
log "docker compose pull"
docker compose pull >>"$LOG_FILE" 2>&1 || true

write_status "UPDATING" "Rebuilding and restarting services" "$LATEST" "$LATEST"
log "docker compose up -d --build --remove-orphans"
if ! docker compose up -d --build --remove-orphans >>"$LOG_FILE" 2>&1; then
  write_status "ERROR" "docker compose up failed — see /opt/kryptalis/.kryptalis/update.log" "$LATEST" "$LATEST"
  trim_log
  exit 1
fi

write_status "UP_TO_DATE" "Updated successfully to $LATEST" "$LATEST" "$LATEST"
log "Update complete"
trim_log
