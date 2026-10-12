# Preparing an OpenWrt device for netmap

netmap reads OpenWrt over **ubus JSON-RPC** (`POST http(s)://<device>/ubus`), the same API LuCI uses.
It logs in as a dedicated rpcd user whose ACL allows only the calls below, so it can read but not change
anything.

**Easiest:** in netmap, **Add device → Set it up for me** with the device's root password. netmap logs in
over SSH and runs `openwrt-setup.sh` for you, then adds the device with the new read-only login. If SSH is
closed it tries root over the web API instead (works on recent OpenWrt; 19.07's permissions don't allow it).
The device needs internet access for the packages.

**By hand over SSH**, `openwrt-setup.sh` in this folder does the same in one go:

```sh
scp docs/openwrt-setup.sh root@192.168.1.1:/tmp/
ssh root@192.168.1.1 sh /tmp/openwrt-setup.sh 'a-long-password'
```

Then, in netmap, click **Add device** and enter the IP address, user `monitor` and that password. The device
panel shows a checklist of which probes answered, and what's missing for any that didn't.

## What netmap reads, and what each part needs

| Probe | ubus call | Package | Gives the map |
|---|---|---|---|
| System | `system board`, `system info` | rpcd (built in) | model, firmware, hostname, uptime, load |
| Interfaces | `network.interface dump` | netifd (built in) | lan/wan/guest networks and their IPs |
| Ports | `network.device status` | netifd (built in) | physical ports and link state, bridge membership, the device's own MACs |
| Wi-Fi clients | `iwinfo devices / info / assoclist` | `rpcd-mod-iwinfo` | SSID, channel, every associated station with signal and rates |
| Bridge table | `file exec /usr/libexec/netmap/fdb` (runs `bridge -j fdb show`) | `rpcd-mod-file`, `ip-bridge` | which MAC is behind which LAN port: wired clients, and which port leads to the next switch or AP |
| LLDP | `file exec /usr/libexec/netmap/lldp` (runs `lldpcli -f json show neighbors`) | `lldpd` | device-to-device cabling with port names, including the Aruba switches |
| DHCP leases | `luci-rpc getDHCPLeases` | `luci-base` | client IPs and host names (main router only) |
| Host names | `luci-rpc getHostHints` | `luci-base` | names and IPs for MACs without a lease |
| ARP | `file read /proc/net/arp` | `rpcd-mod-file` | IPs for static-address devices |

The HTTP side is `uhttpd-mod-ubus` at `/ubus`; the setup script installs it. Until then netmap falls back to
LuCI's relay at `/cgi-bin/luci/admin/ubus` (OpenWrt 19.07 ships without `uhttpd-mod-ubus`).

Only **system** and **ports** are required. Everything else is optional, and the map gets more complete
with each one. A dumb AP has no DHCP leases, which is expected: those come from the main router.

### Why helper scripts instead of calling `bridge` and `lldpcli` directly

rpcd's `file exec` runs commands as root. Allowing `/usr/sbin/bridge` itself would also allow
`bridge fdb del …` or `bridge link set … state disabled`, and `lldpcli` can reconfigure lldpd. The helper
scripts take no arguments and only print, so the ACL grants exactly "read the table" and nothing more.

## Doing it by hand

1. Install packages (`opkg install …` on 24.10 and older, `apk add …` on newer):
   `uhttpd-mod-ubus rpcd-mod-file rpcd-mod-iwinfo ip-bridge lldpd` (+ `luci-base` if LuCI isn't installed).
2. Create `/usr/libexec/netmap/fdb` and `/usr/libexec/netmap/lldp` as in the script, `chmod 755`.
3. Create `/usr/share/rpcd/acl.d/netmap.json` (copy it from the script).
4. Add a login to `/etc/config/rpcd`, using a hash from `uhttpd -m 'your-password'`:
   ```
   config login
       option username 'monitor'
       option password '$1$…hash…'
       list read 'netmap'
   ```
5. For LLDP: `uci add_list lldpd.config.interface='lan'; uci commit lldpd; /etc/init.d/lldpd restart`.
6. `/etc/init.d/rpcd restart`.
7. Add `/usr/libexec/netmap/` and `/usr/share/rpcd/acl.d/netmap.json` to `/etc/sysupgrade.conf` so they
   survive firmware upgrades.

### Checking it from your computer

```sh
# log in (returns ubus_rpc_session)
curl -s http://192.168.1.1/ubus -d '{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","session","login",{"username":"monitor","password":"…"}]}'
# then call something with that session
curl -s http://192.168.1.1/ubus -d '{"jsonrpc":"2.0","id":2,"method":"call","params":["<session>","iwinfo","devices",{}]}'
```
`[6]` in the result means the ACL doesn't allow that call; `-32002` means the session isn't allowed at all.

## Security notes

- The password is stored in `server/netmap.db` so the poller can log in. Keep that file private (it's in
  `.gitignore`), and use this dedicated read-only user, not root.
- Use HTTPS if the device has it (tick HTTPS when adding). OpenWrt's certificate is self-signed, so leave
  "Verify certificate" off unless you've installed a real one.
