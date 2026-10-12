#!/bin/sh
# netmap: lock the netmap-ssh login to /config/scripts/netmap-read. EdgeOS can't put command="..." on an SSH
# key (no double quotes in config values), so sshd forces the command for that user instead. Install as
# /config/scripts/post-config.d/netmap-ssh-lock: EdgeOS rewrites /etc/ssh/sshd_config at boot and runs
# post-config.d after it. Run it again by hand after changing "service ssh" in the config.
CONF=/etc/ssh/sshd_config
USER_NAME=netmap-ssh
grep -q "^Match User $USER_NAME\$" "$CONF" && { echo "$USER_NAME is already locked to netmap-read"; exit 0; }
cp "$CONF" "$CONF.netmap-bak"
cat >> "$CONF" <<EOT

Match User $USER_NAME
    ForceCommand /config/scripts/netmap-read
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
EOT
if /usr/sbin/sshd -t; then
  kill -HUP "$(cat /var/run/sshd.pid)" 2>/dev/null || /etc/init.d/ssh reload
  echo "$USER_NAME locked to netmap-read"
else
  cp "$CONF.netmap-bak" "$CONF"
  echo "sshd rejected the block; sshd_config left as it was" >&2
  exit 1
fi
