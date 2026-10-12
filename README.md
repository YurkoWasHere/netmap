# netmap

A live network map. Add devices to a SQLite database; the server polls them and the web app draws
routers, APs, switches and their clients with React Flow.

Standalone on purpose: it doesn't depend on the closet site, so you can copy this folder to another
network. Supported so far: **OpenWrt** routers and APs (ubus), **SNMP v2c** devices such as managed switches,
**Proxmox VE** nodes (API), and **unmanaged switches** (drawn, never polled). Drivers live in `server/drivers/`.

## Run it

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`, so there are no native modules to build).
Run `npm install` in `server/` once (SSH client for automatic setup, and the SNMP library).

```sh
cd web && npm install && npm run build      # first time, and after UI changes
cd ../server && npm install && cp config.example.json config.json && npm start
```

Open http://localhost:8090. To reach it from other machines, set `"host": "0.0.0.0"` in `server/config.json`.

Front-end work: `npm start` in `server/` plus `npm run dev` in `web/` (Vite forwards `/api` to port 8090).

### Trying it without hardware

`npm run mock` in `server/` starts fake OpenWrt devices on `127.0.0.1`: a router on port 8181 and an AP on
8182 (already set up: user `monitor`, password `monitor`), and a fresh AP on 8183 that only has
`root` / `root`, for trying automatic setup.

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
Some switches here run a **custom, patched firmware** that adds `MacTableRpm.htm` and `/MacTableNN.dat` blocks;
that is not a TP-Link feature. The driver checks for it on every poll and only then reads the table (front
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

## Files

- `server/server.js`: HTTP API, static files and the poll loop. The API is listed at the top of the file.
- `server/db.js`: the SQLite schema (devices, polls, clients, sightings, names, links, oui).
- `server/drivers/openwrt.js`, `snmp.js`, `proxmox.js`: the pollers. Each driver returns the same normalised shape.
- `server/setup.js`: automatic setup with the root login, over SSH (`ssh2`) or ubus.
- `server/graph.js`: turns stored polls into map nodes and edges.
- `server/oui.js`: MAC manufacturer lookup.
- `web/src/NetworkMap.jsx`: the React Flow map component, usable on its own with `makeApi(baseUrl)`.
- `web/src/App.jsx`: the page around it: device list, add/edit form, details panel.
