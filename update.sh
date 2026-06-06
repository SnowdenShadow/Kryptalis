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

# ─── self-heal systemd timer ────────────────────────────────────────
# Older installs shipped with OnUnitActiveSec=10min. We can't ship a new
# timer interval through `git pull` alone — systemd only reads the unit
# file from /etc/systemd/system/. So on every run, check what's installed
# and rewrite + reload if the interval is stale. Idempotent — does nothing
# when the file already has the desired value.
TIMER_FILE="/etc/systemd/system/kryptalis-update.timer"
DESIRED_INTERVAL="30s"
if [ -w /etc/systemd/system ] && [ -f "$TIMER_FILE" ]; then
  if ! grep -q "^OnUnitActiveSec=$DESIRED_INTERVAL\$" "$TIMER_FILE" 2>/dev/null; then
    cat > "$TIMER_FILE" <<TIMEREOF
[Unit]
Description=Run Kryptalis self-update every $DESIRED_INTERVAL
Requires=kryptalis-update.service

[Timer]
OnBootSec=1min
OnUnitActiveSec=$DESIRED_INTERVAL
Unit=kryptalis-update.service
Persistent=true

[Install]
WantedBy=timers.target
TIMEREOF
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl restart kryptalis-update.timer >/dev/null 2>&1 || true
  fi
fi

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
# Default to the GitHub REST API (anonymous, 60 req/h per IP is plenty for a
# 30-second polling cadence) — way faster than `git fetch`, and we don't pay
# the round-trip when nothing changed. Falls back to `git fetch` if the API is
# unreachable or the repo isn't on GitHub.
#
# Resolution order for the API repo:
#   1. KRYPTALIS_GITHUB_REPO env var (e.g. "SnowdenShadow/Kryptalis")
#   2. Parse the `origin` remote URL
CURRENT=$(git rev-parse HEAD)

GH_REPO="${KRYPTALIS_GITHUB_REPO:-}"
if [ -z "$GH_REPO" ]; then
  ORIGIN_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
  # Strip protocol + .git + handle both git@host:owner/repo and https://host/owner/repo
  GH_REPO=$(printf '%s' "$ORIGIN_URL" \
    | sed -E 's#^(https?://[^/]+/|git@[^:]+:)##; s#\.git$##' \
    | grep -E '^[^/]+/[^/]+$' || true)
fi

LATEST=""
if [ -n "$GH_REPO" ]; then
  # Use cached ETag so unchanged responses return 304 and don't consume the
  # 60/h anonymous quota. State files in STATUS_DIR persist across runs.
  ETAG_FILE="$STATUS_DIR/api-etag"
  CACHED_SHA_FILE="$STATUS_DIR/api-cached-sha"
  ETAG_HEADER=""
  if [ -f "$ETAG_FILE" ]; then
    ETAG_HEADER="If-None-Match: $(cat "$ETAG_FILE" 2>/dev/null)"
  fi

  # Capture body + headers so we can read ETag AND the response code.
  TMP_BODY=$(mktemp 2>/dev/null || echo "/tmp/kryptalis-api-body.$$")
  TMP_HEAD=$(mktemp 2>/dev/null || echo "/tmp/kryptalis-api-head.$$")
  HTTP_CODE=$(curl -sS --max-time 5 \
    -o "$TMP_BODY" -D "$TMP_HEAD" -w "%{http_code}" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: kryptalis-update" \
    ${ETAG_HEADER:+-H "$ETAG_HEADER"} \
    "https://api.github.com/repos/$GH_REPO/commits/$BRANCH" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "304" ]; then
    # Not Modified — reuse the SHA we cached last time. Free of quota cost.
    LATEST=$(cat "$CACHED_SHA_FILE" 2>/dev/null || echo "")
  elif [ "$HTTP_CODE" = "200" ]; then
    LATEST=$(grep -oE '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]{40}"' "$TMP_BODY" 2>/dev/null \
      | head -1 \
      | sed -E 's/.*"([0-9a-f]{40})"/\1/')
    # Persist new ETag + SHA so the NEXT call benefits from the 304 fast-path.
    NEW_ETAG=$(grep -i '^etag:' "$TMP_HEAD" 2>/dev/null \
      | head -1 | sed -E 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//' | tr -d '\r\n')
    [ -n "$NEW_ETAG" ] && printf '%s' "$NEW_ETAG" > "$ETAG_FILE"
    [ -n "$LATEST" ] && printf '%s' "$LATEST" > "$CACHED_SHA_FILE"
  fi
  # 403 (rate limit), 404, 5xx, 000 (timeout) → fall through to git fetch.
  rm -f "$TMP_BODY" "$TMP_HEAD" 2>/dev/null
fi

# Fallback to local git fetch (covers self-hosted repos, network blips, etc.)
if [ -z "$LATEST" ]; then
  if git fetch --depth=1 origin "$BRANCH" >/dev/null 2>&1; then
    LATEST=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")
  fi
fi

if [ -z "$LATEST" ]; then
  write_status "ERROR" "Could not reach GitHub API or origin" "$CURRENT" ""
  log "no-op: could not determine latest SHA"
  exit 0
fi

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$CURRENT" = "$LATEST" ] && [ "$FORCE" = "0" ]; then
    write_status "UP_TO_DATE" "No new commits" "$CURRENT" "$LATEST"
  else
    write_status "UPDATE_AVAILABLE" "New commit on origin/$BRANCH" "$CURRENT" "$LATEST"
  fi
  exit 0
fi

if [ "$CURRENT" = "$LATEST" ] && [ "$FORCE" = "0" ]; then
  # Don't rewrite STATUS_FILE every minute when nothing changed — that file's
  # mtime is what the API uses to detect the timer is alive (detectAutoUpdate).
  # Touch it instead to keep the timestamp fresh without re-doing the JSON.
  touch "$STATUS_FILE" 2>/dev/null || write_status "UP_TO_DATE" "No new commits" "$CURRENT" "$LATEST"
  exit 0
fi

# New commit detected via API — we MUST `git fetch` before reset to actually
# bring the new objects into the local repo.
if ! git fetch --depth=1 origin "$BRANCH" >/dev/null 2>&1; then
  write_status "ERROR" "git fetch failed after API detected update" "$CURRENT" "$LATEST"
  log "git fetch failed"
  exit 1
fi

# ─── apply ──────────────────────────────────────────────────────────
write_status "UPDATING" "Pulling new code from origin/$BRANCH" "$CURRENT" "$LATEST"
log "Updating $CURRENT → $LATEST"

if ! git reset --hard "origin/$BRANCH" >>"$LOG_FILE" 2>&1; then
  write_status "ERROR" "git reset failed" "$CURRENT" "$LATEST"
  trim_log
  exit 1
fi

# Re-assert the executable bit on shell scripts — Windows checkouts don't
# preserve the +x flag, so files pushed from Windows land here mode 0644
# after `git reset --hard`. Without this, the NEXT timer fire fails with
# "command not found" because systemd ExecStarts the script directly.
chmod +x "$INSTALL_DIR/update.sh" "$INSTALL_DIR/install.sh" 2>/dev/null || true

write_status "UPDATING" "Pulling docker images" "$LATEST" "$LATEST"
log "docker compose pull"
docker compose pull >>"$LOG_FILE" 2>&1 || true

# Seed bind-mounted files BEFORE compose up — when these don't exist as
# regular files, docker creates an empty DIRECTORY at the bind path and
# the affected service crashes ("not a directory" / "is a directory").
# Idempotent: only touches the file when it's missing or a stray dir.
seed_bind_file() {
  TARGET="$1"
  CONTENT="$2"
  if [ -d "$TARGET" ] && [ ! -f "$TARGET" ]; then
    rmdir "$TARGET" 2>/dev/null || rm -rf "$TARGET"
  fi
  if [ ! -f "$TARGET" ]; then
    mkdir -p "$(dirname "$TARGET")"
    printf '%s' "$CONTENT" > "$TARGET"
  fi
}

seed_bind_file "$INSTALL_DIR/docker-compose.override.yml" '# Auto-managed by Kryptalis API — do not edit.
services:
  caddy:
    ports: []
'

seed_bind_file "$INSTALL_DIR/.kryptalis/reverse-proxy/Caddyfile" '# Seeded by update.sh — the API rewrites this once domains are created.
{
  admin :2019
  email kryptalis@localhost
}
:80 {
  respond "Kryptalis: no domain configured yet." 404
}
'

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
