#!/bin/sh
# DockControl SFTP entrypoint.
#
# Responsibilities:
#   1. Persist host keys across container recreates without masking
#      the rest of /etc/ssh. The sftp_host_keys volume mounts at
#      /var/lib/dockcontrol-sftp-keys; we generate any missing keys
#      there, then symlink them into /etc/ssh so sshd finds them at
#      the standard paths.
#   2. Ensure the `sftpusers` group exists. (The per-user sshd_config
#      drop-ins don't actually match on the group anymore — the
#      historic `Match Group sftpusers` block was removed because
#      sshd's first-match-wins semantics shadowed per-user includes —
#      but we keep the group around for `useradd -G sftpusers` so
#      operators can identify SFTP-only accounts at a glance.)
#   3. Pre-create the runtime directories sshd insists on
#      (/run/sshd, /var/empty, /etc/ssh/sshd_config.d).
#   4. exec the command (sshd by default).
#
# Account CRUD is NOT done here. DockControl API drives it at runtime
# via `docker exec dockcontrol-sftp useradd ...` / `userdel ...`.

set -e

# ── 1. host keys ────────────────────────────────────────────────────
KEYDIR=/var/lib/dockcontrol-sftp-keys
mkdir -p "$KEYDIR"
chmod 0700 "$KEYDIR"

# Generate any missing keys directly in the persisted dir. We do NOT
# use `ssh-keygen -A` because it always writes to /etc/ssh — we want
# the keys in $KEYDIR so they survive a container recreate.
for type in ed25519 rsa; do
    priv="$KEYDIR/ssh_host_${type}_key"
    if [ ! -f "$priv" ]; then
        if [ "$type" = "rsa" ]; then
            ssh-keygen -q -N '' -t rsa -b 4096 -f "$priv"
        else
            ssh-keygen -q -N '' -t "$type" -f "$priv"
        fi
    fi
done

# Permissions: sshd refuses to start if host private keys aren't 0600.
chmod 0600 "$KEYDIR"/ssh_host_*_key 2>/dev/null || true
chmod 0644 "$KEYDIR"/ssh_host_*_key.pub 2>/dev/null || true

# Project the keys into /etc/ssh via symlinks. sshd_config references
# /etc/ssh/ssh_host_*_key paths and sshd will follow symlinks. We
# replace any pre-existing files (the baked image has none, but a
# stale upgrade might) so the link always points at the persisted
# copy.
for f in "$KEYDIR"/ssh_host_*_key "$KEYDIR"/ssh_host_*_key.pub; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    ln -sf "$f" "/etc/ssh/$base"
done

# ── 2. sftpusers group ─────────────────────────────────────────────
# `groupadd -f` is idempotent — no error if the group already exists.
groupadd -f -g 65530 sftpusers

# ── 3. runtime dirs ────────────────────────────────────────────────
# Per-user sshd_config drop-in directory. DockControl API drops one
# .conf file per account here at runtime. sshd's `Include` directive
# only succeeds if the directory exists at sshd startup.
mkdir -p /etc/ssh/sshd_config.d
chmod 0755 /etc/ssh/sshd_config.d

# Alpine's sshd needs a privsep dir and an empty dir to chroot into.
mkdir -p /run/sshd && chmod 0755 /run/sshd
mkdir -p /var/empty && chmod 0755 /var/empty

echo "[entrypoint] sshd ready — exec $*"
exec "$@"
