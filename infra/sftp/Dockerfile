# Minimal OpenSSH-only image dedicated to SFTP.
#
# Why not atmoz/sftp:
#   - Refuses to boot without users at CLI args.
#   - Hot-reloading users requires an entrypoint dance the project
#     doesn't actually support cleanly.
#   - users.conf format isn't documented and the parsing is fragile.
#
# What this image does instead:
#   - Boots sshd standalone with NO users by default.
#   - Idle entrypoint generates host keys on first boot (persisted in
#     a named volume) so client `known_hosts` stays valid across
#     redeploys.
#   - Kryptalis API does `docker exec kryptalis-sftp useradd ...` +
#     `chpasswd -e` over the docker socket to add/remove accounts at
#     runtime. No restart needed for CRUD.
#   - SFTP-only: every account gets ForceCommand=internal-sftp + a
#     /bin/false shell so a compromised credential can never get a
#     real shell.
FROM alpine:3.20

# - openssh: the daemon itself, plus sftp-server.
# - shadow: GNU `useradd` / `chpasswd` (Alpine's busybox `adduser` doesn't
#   support `--no-create-home` cleanly + crypt-encrypted passwords via -e).
# - openssh-server-pam: PAM session module so chroot works.
# - bash: entrypoint reads /etc/profile etc. for nicer interactive debug.
RUN apk add --no-cache openssh openssh-server-pam shadow bash \
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
