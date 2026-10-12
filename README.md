# netmap

A live map of your network. Add devices to a SQLite database; the server polls them every minute and the web
app draws the internet gateway, switches, routers, access points, hypervisors and every client on them as a
tree, with live traffic, front-panel views of each device, and PoE power.

Supported devices:

| Device | How it's read | What you get |
|---|---|---|
| **OpenWrt** routers and APs | ubus JSON-RPC with a read-only login (netmap can set it up for you) | interfaces, Wi-Fi clients, bridge MAC table, switch-chip jacks (swconfig), LLDP, DHCP names, ARP |
| **SNMP v2c** managed switches | IF-MIB, Q-BRIDGE / BRIDGE-MIB, LLDP-MIB, IP-MIB, POWER-ETHERNET-MIB | ports, speeds, traffic, MAC table, neighbours, PoE total and per-port class |
| **TP-Link Easy Smart** switches (TL-SG105E/108E/116E …) | their web pages | ports, speeds, packet counters (MAC table only with patched firmware, see below) |
| **Proxmox VE** nodes | the API, with a read-only `user@pve` account | VMs and containers, their NICs and bridges |
| **Netgear smart switches** (S350 …) | web UI, as an extra data source next to SNMP | per-port PoE watts, volts, mA and class |
| **Unmanaged switches** | never polled | drawn where you say, or where their MAC is seen |

Drivers live in `server/drivers/`, extra data sources (collectors) in `server/collectors/`.

## Install

Needs Linux (or macOS) with **Node.js 22.13 or newer** (it uses the built-in `node:sqlite`, so there are no
native modules to compile). If your distribution's Node is older, the installer can fetch a private copy.

```sh
git clone https://github.com/YurkoWasHere/netmap.git && cd netmap
scripts/install.sh                         # dependencies, web build, server/config.json
cd server && node server.js                # then open http://localhost:8090
```

Options for `scripts/install.sh` (it's safe to run again after a `git pull`):

- `--with-node`: download Node.js into `./node` (checksum-verified) and use that.
- `--listen 0.0.0.0`: let other machines on your network open the map (default: this machine only).
- `--service`: install and start a systemd service that runs as your user (asks for sudo). Logs:
  `journalctl -u netmap -f`. Template: `deploy/netmap.service`.

A typical always-on install on a small Linux box: `scripts/install.sh --with-node --listen 0.0.0.0 --service`.

Settings are in `server/config.json` (copied from `server/config.example.json`): `host`, `port` (8090),
`db` (the database file), `pollSeconds` (60) and `clientMaxAgeMinutes` (how long a client stays on the map after
it was last seen). `HOST`, `PORT`, `POLL_SECONDS`, `NETMAP_DB` and `NETMAP_CONFIG` environment variables override them.

To update: `git pull && scripts/install.sh`, then restart the server (`sudo systemctl restart netmap`).

### Security

- **The web app and API have no login.** Anyone who can open the page can add, change and remove devices. Keep it
  on `127.0.0.1` (the default) or a network you trust, or put it behind a reverse proxy with authentication.
- Device logins (read-only accounts, SNMP communities) are stored in plain text in the database
  (`server/netmap.db`), because the poller needs them. The API never returns them. Keep the file private and
  out of git (it's in `.gitignore`), and give netmap read-only accounts wherever the device allows it.
- Admin passwords used for automatic OpenWrt setup are used once and never stored.
- netmap only reads. The only things it sends to a device's web UI are logins (and, for the Netgear collector,
  a logout of its own session).

### Development

`npm start` in `server/` plus `npm run dev` in `web/` (Vite forwards `/api` to port 8090). From the top folder:
`npm start`, `npm run dev`, `npm run build`.

**Trying it without hardware:** `npm run mock` in `server/` starts fake OpenWrt devices on `127.0.0.1`: a router
on port 8181 and an AP on 8182 (already set up: user `monitor`, password `monitor`), and a fresh AP on 8183 that
only has `root` / `root`, for trying automatic setup.

## Adding an OpenWrt device

Click **Add device**, choose **Set it up for me**, and give it the device's IP and admin (root) password.
netmap logs in once over SSH (or root over the web API if SSH is closed), runs `docs/openwrt-setup.sh` on
the device (installs a few packages, creates a read-only `monitor` login with a random password) and adds
the device with that login. The root password is never saved. The device needs internet access for packages.
See [docs/openwrt-setup.md](docs/openwrt-setup.md).

## Adding an SNMP device

**Add device → SNMP switch**: name, IP and a read-only community (port 161 unless you've changed it).
netmap reads system info, ports and their descriptions (IF-MIB), the MAC table (Q-BRIDGE / BRIDGE-MIB),
LLDP neighbours, IP addresses and ARP. The community is stored in the database (the `password` column)
so it can poll; the API never returns it.

## Adding a TP-Link Easy Smart switch

**Add device → TP-Link Easy Smart switch** (TL-SG105E / 108E / 116E …): IP, admin user and password. netmap reads
the web pages: system info, link and speed per port, and packet counters (these switches only count packets).
netmap never logs out, because Logout.htm ends every session on the switch, yours in a browser included.

Stock firmware has **no MAC address table**, so clients behind such a switch are placed by the "behind it" rule.
Switches running a **custom, patched firmware** get `MacTableRpm.htm` and `/MacTableNN.dat` blocks;
(not a TP-Link feature): see [TL-SG108E-V5-custom-firmware](https://github.com/YurkoWasHere/TL-SG108E-V5-custom-firmware) (TL-SG108E v5 only). The driver checks for it on every poll and only then reads the table (front
socket = ASIC port + 1, checked on a TL-SG108E v5); on any other switch it carries on without it.

## Adding a Proxmox VE node

Each node of a cluster is its own device, so its VMs and containers hang off the right node. **Add device →
Proxmox VE node**: the IP of any node, a **PVE-realm** account (`user@pve`, not PAM), **Look up nodes**, pick the
node. Add the other nodes the same way; they share one login and one read of the cluster.

A read-only account, on any node:

```sh
pveum user add monitor@pve --password 'a-long-password'
pveum acl modify / --users monitor@pve --roles PVEAuditor
```

netmap reads the cluster's nodes and guests, each guest's config (for its NICs' MACs and bridges), and the node's
network. Running guests appear under their node, grouped by bridge (`vmbr0`, `vmbr500`, ...), even though the
switches see them behind the node's port. Proxmox doesn't report a node's own MAC, so netmap finds it from the
node's IP in the ARP tables it already has, and places the node in the tree like any other device.

## Adding an unmanaged switch

**Add device → Unmanaged switch**: a name, and either what it's plugged into (device and port) or its MAC, if the
managed switches see it. Everything else the switches only see on that same port is drawn behind it. Clients and
devices can also be put on it by hand: **Plugged into** in their panel.

## How the map is built

- **Devices** are drawn as a tree from the internet down. Each device has a **Role on the map** (dropdown in
  its panel):
  - **Internet gateway**: top of the map, with an Internet node above its WAN port. If no device has this
    role, the OpenWrt device with an up WAN is used.
  - **Core switch**: always on the row right under the gateway. A real cable between two core switches is
    drawn beside the tree.
  - **Automatic**: placed wherever it's plugged in. When the gateway has core switches, its other ports,
    clients and non-core devices go on the rows below the core switches.

  Where a device is plugged in comes from the MAC tables: its uplink is the port where it sees the gateway's
  MAC, and its parent is the device that sees it on a non-uplink port with the fewest MACs behind that port
  (the closest one). A cable you draw beats LLDP, which beats the MAC tables. LLDP only counts on a physical
  port: OpenWrt's lldpd on `br-lan` hears every OpenWrt box on the LAN, cable or not. Each device hangs off
  the port it's plugged into, next to that port's clients; the device panel shows what it's plugged into and
  how that was worked out.
- **Clients** are MACs a device sees right now: associated on Wi-Fi, in a MAC/bridge table, or in an ARP
  table. A DHCP lease alone doesn't count (leases outlive the device); leases and host hints are only used to
  name clients that are online. Each client is attached where it's seen most directly: Wi-Fi first, then the
  LAN port with the fewest MACs behind it (a leaf port, not an uplink), then ARP on the router.
- **Makers** come from the MAC's OUI prefix, using Wireshark's `manuf` list (IEEE registries). The server
  downloads it into the database on first run and refreshes it monthly (`POST /api/oui/update` forces it).
  Randomized "private" MACs, which phones and laptops use on Wi-Fi, are labelled as such.
- Under each device, clients are grouped by the port (or SSID) they're on. Ports with more than six
  clients, usually uplinks or hypervisors, start folded; click a port to fold or unfold it.
- The layout is always automatic; nothing on the map can be dragged. To say where something is plugged in,
  use **Plugged into** in its panel (devices and clients); that beats what the switches report.

## Extra data sources (collectors)

A device has one driver and can have extra data sources for things its driver can't read. In the device's
**Details** tab, **Extra data sources → Add**:

- **Netgear web UI (PoE per port)**: for Netgear smart switches (S350 series and others with the same web UI)
  whose SNMP has no POWER-ETHERNET-MIB. Logs in to the web page with the admin user and reads the PoE port and
  PoE unit pages: watts, volts, mA and class per port, and the total. netmap keeps one web session open between
  polls (the switch has only a few), so you may see it in the switch's session list.

Collectors run after the driver on every poll; what they find shows up like the driver's own data.

## PoE energy

On PoE switches (POWER-ETHERNET-MIB, or a collector) netmap samples the power delivered every poll and adds it
up per day: the device panel shows now, today, the last 7 days and the total. It's the power delivered to
powered devices, not the switch's own use. Ports that report watts show them on the map (⚡ on the port tag).

## Other things in the device panel

- **Open web page**: the device's own web interface.
- **Pause polling** for 15 minutes to a day, or until resumed (e.g. while you're logged in to a switch that
  allows one web session).
- **Plugged into**: say where a device or client is cabled when the switches can't tell.
- **Update on the device** (OpenWrt): re-run the setup to install netmap's newest read-only helpers.

## Files

- `server/server.js`: HTTP API, static files and the poll loop. The API is listed at the top of the file.
- `server/db.js`: the SQLite schema (devices, collectors, polls, clients, sightings, names, links, uplinks, oui).
- `server/drivers/`: `openwrt.js`, `snmp.js`, `tplink.js`, `proxmox.js`. Each returns the same normalised shape.
- `server/collectors/`: extra data sources (`netgear-web.js`); `index.js` merges their results.
- `server/setup.js`: automatic OpenWrt setup with the root login, over SSH (`ssh2`) or ubus.
- `server/graph.js`: turns stored polls into map nodes and edges.
- `server/rates.js`, `server/energy.js`, `server/oui.js`: traffic rates, PoE energy, MAC manufacturer lookup.
- `server/dev/mock-openwrt.js`: fake OpenWrt devices for development.
- `web/src/NetworkMap.jsx`: the React Flow map component, usable on its own with `makeApi(baseUrl)`.
- `web/src/App.jsx`, `Faceplate.jsx`: the page around it (device list, forms, details panel) and device front panels.
- `docs/openwrt-setup.sh` / `.md`: what an OpenWrt device needs, and the script that sets it up.
- `scripts/install.sh`, `deploy/netmap.service`: installer and systemd unit.
