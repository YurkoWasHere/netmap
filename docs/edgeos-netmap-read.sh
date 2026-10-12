#!/bin/sh
# netmap: read-only dump for netmap's "EdgeOS MAC table" data source. Install on the router as
# /config/scripts/netmap-read (survives firmware upgrades) and give netmap an SSH key that can only run it:
# see docs/edgeos-setup.md. Ignores its arguments and whatever command the SSH client asked for.
PATH=/sbin:/usr/sbin:/bin:/usr/bin

# which MAC is behind which switch port: switch0 is a Linux bridge over the jacks (eth0..eth5 on an ER-X)
echo "== fdb"
bridge fdb show 2>/dev/null
# the same from brctl (port numbers), for firmware without iproute2's bridge tool
echo "== brctl"
brctl showmacs switch0 2>/dev/null
echo "== brports"
for p in /sys/class/net/switch0/brif/*; do [ -e "$p/port_no" ] && echo "$(basename "$p") $(cat "$p/port_no")"; done 2>/dev/null
exit 0
