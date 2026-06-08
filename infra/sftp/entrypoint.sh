#!/bin/sh
# Kryptalis SFTP entrypoint.
#
# Responsibilities:
#   1. Generate host keys on first boot. Persisted across container
#      restarts via the sftp_host_keys volume mounted at /etc/ssh.
#   2. Create the `sftpusers` group every account lands in. The
#      sshd_config's `Match Group sftpusers` block keys off this name
#      so accounts get chrooted + sftp-locked automatically.
#   3. exec the command (sshd by default).
#
# Account CRUD is NOT done here. Kryptalis API drives it at runtime via
# `docker exec kryptalis-sftp useradd ...` / `userdel ...`.

set -e

# ── 1. host keys ────────────────────────────────────────────────────
# ssh-keygen -A creates only the algorithms that are missing — safe
# to re-run on every boot. First boot writes ed25519 + rsa under
# /etc/ssh; subsequent boots no-op.
ssh-keygen -A

# Permissions: sshd refuses to start if host private keys aren't 0600.
chmod 0600 /etc/ssh/ssh_host_*_key 2>/dev/null || true
chmod 0644 /etc/ssh/ssh_host_*_key.pub 2>/dev/null || true

# ── 2. sftpusers group ─────────────────────────────────────────────
# `groupadd -f` is idempotent: no error if the group already exists.
groupadd -f -g 65530 sftpusers

# ── 3. /run/sshd ───────────────────────────────────────────────────
# Alpine's sshd needs a privsep dir to exist.
mkdir -p /run/sshd
chmod 0755 /run/sshd

# Some Alpine sshd builds also require this directory.
mkdir -p /var/empty
chmod 0755 /var/empty

echo "[entrypoint] sshd ready — exec $*"
exec "$@"
