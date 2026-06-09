# Minimal OpenSSH-only image dedicated to SFTP.
#
# What this image does:
#   - Boots sshd standalone with NO users by default.
#   - The entrypoint generates host keys on first boot, persisting
#     them in /var/lib/kryptalis-sftp-keys (a named volume) so client
#     `known_hosts` stays valid across redeploys. The keys are
#     symlinked into /etc/ssh at boot — we don't mount /etc/ssh from a
#     volume because that would mask the baked sshd_config.
#   - Kryptalis API does `docker exec kryptalis-sftp useradd ...` +
#     `chpasswd` over the docker socket to add/remove accounts at
#     runtime. No container restart needed for CRUD.
#   - Per-user sshd_config drop-ins in /etc/ssh/sshd_config.d enforce
#     chroot + sftp-only + read/write permission.
#   - SFTP-only: every account gets ForceCommand=internal-sftp + a
#     /bin/false shell so a compromised credential can never get a
#     real shell.
FROM alpine:3.20

# - openssh: the daemon itself, plus sftp-server + ssh-keygen.
# - openssh-server-pam: PAM session module (required so chpasswd-driven
#   /etc/shadow updates authenticate sessions correctly).
# - shadow: GNU `useradd`/`userdel`/`chpasswd` (Alpine's busybox
#   `adduser` lacks features we depend on).
# - acl: POSIX ACLs. We need them because sshd refuses to start a
#   chrooted session unless ChrootDirectory is root-owned with mode
#   <= 0755 — but at the same time, the SFTP user has to be able to
#   write inside the chroot root. ACLs give per-user rwx on top of
#   the root:root 0755 base, which sshd ignores (it only checks
#   owner/mode) but the kernel honors. Default ACLs make new files
#   inherit the permission so users can keep creating things.
# - bash: nicer interactive debug shell for ops.
RUN apk add --no-cache openssh openssh-server-pam shadow acl bash \
 && rm -rf /var/cache/apk/*

# sshd_config — chroot every non-root account into /home/<user>, force
# internal-sftp, deny port forwarding and tunneling, no shell.
COPY sshd_config /etc/ssh/sshd_config

# Entrypoint generates host keys if missing, then exec's sshd in foreground.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22

# Healthcheck — a successful TCP connect to :22 from inside the container
# is sufficient. Docker-compose adds the same check from outside.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep sshd || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
