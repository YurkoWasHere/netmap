#!/bin/sh
# netmap: read-only dump for netmap's "EdgeOS MAC table" data source. Install on the router as
# /config/scripts/netmap-read (survives firmware upgrades) and give netmap an SSH key that can only run it:
# see docs/edgeos-setup.md. Ignores its arguments and whatever command the SSH client asked for.
PATH=/sbin:/usr/sbin:/bin:/usr/bin

# which MAC is behind which switch port. EdgeRouter X / X-SFP (MT7621): the switch chip's own table, from
# MediaTek's switch tool (chip port N = ethN, port 6 = the CPU); Linux's bridge never learns those MACs.
echo "== switchdump"
if command -v switch > /dev/null 2>&1; then sudo -n switch dump 2>/dev/null || switch dump 2>/dev/null; fi
# other EdgeRouters: switch0 as a Linux bridge
echo "== fdb"
bridge fdb show 2>/dev/null
# the same from brctl (port numbers), for firmware without iproute2's bridge tool
echo "== brctl"
brctl showmacs switch0 2>/dev/null
echo "== brports"
for p in /sys/class/net/switch0/brif/*; do [ -e "$p/port_no" ] && echo "$(basename "$p") $(cat "$p/port_no")"; done 2>/dev/null
exit 0
