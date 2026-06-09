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
#   We don't install openssh-server-pam: the Alpine `openssh` binary
#   isn't built with PAM support, and we don't need it — sshd reads
#   /etc/shadow directly via crypt(3), and chpasswd writes SHA-512
#   crypt entries there.
# - shadow: GNU `useradd`/`userdel`/`chpasswd` (Alpine's busybox
#   `adduser` lacks features we depend on).
# - acl: POSIX ACLs (setfacl/getfacl). The chroot leaf at /home/<user>
#   must stay root:root 0755 (sshd hard requirement — it walks
#   ancestors and refuses anything else), so we bind-mount the
#   writable app data at /home/<user>/app and layer the per-user ACL
#   on the bind target. sshd never inspects the bind target so the
#   ACL doesn't trip its safety check.
# - util-linux: provides `mountpoint`, used to make the per-user
#   bind mount idempotent across container restarts.
# - bash: nicer interactive debug shell for ops.
RUN apk add --no-cache openssh shadow acl util-linux bash \
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
