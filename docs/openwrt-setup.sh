#!/bin/sh
# Prepares an OpenWrt router or AP to be read by netmap. Run it on the device:
#
#   scp docs/openwrt-setup.sh root@192.168.1.1:/tmp/ && ssh root@192.168.1.1 sh /tmp/openwrt-setup.sh 'a-long-password'
#
# What it does (all read-only for netmap; see openwrt-setup.md for the why of each step):
#   1. installs uhttpd-mod-ubus, rpcd-mod-file, rpcd-mod-iwinfo, ip-bridge, lldpd (and luci-base if missing)
#   2. adds two no-argument helper scripts: /usr/libexec/netmap/fdb and /usr/libexec/netmap/lldp
#   3. adds an rpcd ACL "netmap" that can call only the methods netmap uses
#   4. adds an rpcd login "monitor" with that ACL and the password you pass
#   5. keeps all of it across sysupgrade
set -e
PASS="$1"
USER="${2:-monitor}"
[ -n "$PASS" ] || { echo "usage: $0 <password> [username]"; exit 1; }

echo "== Installing packages"
if command -v apk >/dev/null 2>&1; then PM="apk"; apk update; ADD="apk add"
else PM="opkg"; opkg update; ADD="opkg install"; fi
PKGS="uhttpd uhttpd-mod-ubus rpcd rpcd-mod-file rpcd-mod-iwinfo ip-bridge lldpd"
# luci-rpc (DHCP leases, host names) comes with luci-base; skip on a box without LuCI if you don't want it.
[ -e /usr/share/rpcd/ucode/luci ] || [ -e /usr/libexec/rpcd/luci ] || PKGS="$PKGS luci-base"
# shellcheck disable=SC2086
$ADD $PKGS || echo "Some packages failed to install with $PM; netmap will report which probes are missing."

# Serve ubus at /ubus (faster than going through LuCI, and works on devices without LuCI).
uci -q get uhttpd.main.ubus_prefix >/dev/null || { uci set uhttpd.main.ubus_prefix='/ubus'; uci commit uhttpd; }

echo "== Adding helper scripts and the netmap ACL"
mkdir -p /usr/libexec/netmap
cat > /usr/libexec/netmap/fdb <<'EOF'
#!/bin/sh
# netmap: bridge forwarding table as JSON. Ignores arguments on purpose.
exec /usr/sbin/bridge -j fdb show
EOF
cat > /usr/libexec/netmap/lldp <<'EOF'
#!/bin/sh
# netmap: LLDP neighbours as JSON. Ignores arguments on purpose.
exec /usr/sbin/lldpcli -f json show neighbors details
EOF
chmod 755 /usr/libexec/netmap/fdb /usr/libexec/netmap/lldp

cat > /usr/share/rpcd/acl.d/netmap.json <<'EOF'
{
  "netmap": {
    "description": "Read-only access for netmap",
    "read": {
      "ubus": {
        "system": ["board", "info"],
        "network.interface": ["dump"],
        "network.device": ["status"],
        "iwinfo": ["devices", "info", "assoclist"],
        "luci-rpc": ["getDHCPLeases", "getHostHints"],
        "file": ["read", "exec"]
      },
      "file": {
        "/proc/net/arp": ["read"],
        "/usr/libexec/netmap/fdb": ["exec"],
        "/usr/libexec/netmap/lldp": ["exec"]
      }
    }
  }
}
EOF

echo "== Creating rpcd login '$USER'"
# rpcd login with an MD5-crypt hash of the password (not the plain password).
HASH="$(uhttpd -m "$PASS")"
for s in $(uci -q show rpcd | sed -n "s/^rpcd\.\([^.]*\)\.username='$USER'$/\1/p"); do uci delete "rpcd.$s"; done
S="$(uci add rpcd login)"
uci set "rpcd.$S.username=$USER"
uci set "rpcd.$S.password=$HASH"
uci add_list "rpcd.$S.read=netmap"
uci commit rpcd

echo "== Enabling LLDP on lan"
# LLDP on the LAN so routers, APs and the Aruba switches find each other.
if [ -e /etc/config/lldpd ]; then
  uci -q delete lldpd.config.interface || true
  uci add_list lldpd.config.interface='lan'
  uci commit lldpd
  /etc/init.d/lldpd enable && /etc/init.d/lldpd restart || true
fi

for f in /usr/libexec/netmap/ /usr/share/rpcd/acl.d/netmap.json; do
  grep -qxF "$f" /etc/sysupgrade.conf || echo "$f" >> /etc/sysupgrade.conf
done

# netmap's automatic setup runs this script through rpcd itself, so it restarts rpcd after the script exits.
if [ -z "$NETMAP_DEFER_RESTART" ]; then
  /etc/init.d/rpcd restart
  /etc/init.d/uhttpd restart
fi
echo "Done. Add this device in netmap with user '$USER' and the password you gave."
