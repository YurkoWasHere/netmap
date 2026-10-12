// Turns the stored polls into { nodes, edges } for the map.
//
// Devices form a tree from the top of the network (the gateway) down:
//   root      the device marked "Internet gateway", else the OpenWrt device with an up WAN, else the one
//             handing out DHCP leases, else the first device.
//   unmanaged a dumb switch (never polled) sits where you plugged it, or where its MAC is seen if you gave one;
//             whatever else is only seen on that same port moves behind it.
//   core      devices marked "Core switch" always hang directly off the gateway (drawn on the row under it).
//             If one is really cabled through another core switch, that cable is returned as a `cross` edge.
//   uplink    on every other device, the port where it sees the root's MAC.
//   parent    of device Y: among devices X that see Y on a port that isn't X's uplink, the closest one, i.e.
//             the one whose port has the fewest MACs behind it. A hand-drawn cable beats LLDP, which beats
//             the MAC tables. LLDP only counts on a physical port: OpenWrt's lldpd on br-lan hears every
//             other box on the LAN, so it says "same network", not "cable".
// Every tree edge goes parent -> child with the port on each end. Cables that don't fit the tree (drawn by
// hand or LLDP between devices that already have a parent) are returned too, marked `cross`.
//
// Clients: every MAC a device sees right now on Wi-Fi, in a MAC table or as a running VM, that isn't a managed
// device. A DHCP lease or an ARP entry alone doesn't count: both outlive the device. Each client is attached to the device where it's seen
// most directly: Wi-Fi association first, then the bridge port with the fewest MACs behind it (a leaf port,
// not an uplink), then ARP on the router. Names come from DHCP leases and host hints; makers from the OUI list.
const { all, plain } = require("./db.js");

// An LLDP neighbour heard on a bridge (br-lan) shares the network but isn't necessarily on a cable to us.
const isBridgePort = (p) => !p || /^(br-|bridge)/.test(p);

function pickRoot(devices, results) {
  const marked = devices.find((d) => d.is_root);
  if (marked) return marked.id;
  const withWan = devices.find((d) => {
    const r = results[d.id];
    return r && (r.interfaces || []).some((i) => /^wan$|^wan\d*$|pppoe/i.test(i.name) && i.up && i.ipv4.length);
  });
  if (withWan) return withWan.id;
  const dhcp = devices.find((d) => results[d.id] && Object.keys(results[d.id].names || {}).length && results[d.id].probes && results[d.id].probes.dhcp === "ok");
  if (dhcp) return dhcp.id;
  return devices.length ? devices[0].id : null;
}

function build(db, { clientMaxAgeMinutes = 60, lookup = () => null, energy = {} } = {}) {
  const devices = all(db.prepare(`select d.id, d.name, d.driver, d.host, d.enabled, d.notes, d.x, d.y, d.is_root, d.is_core, d.mac, d.node, d.paused_until,
      p.polled_at, p.ok, p.error, p.last_ok_at, p.result
    from devices d left join polls p on p.device_id = d.id order by d.id`));
  const results = {};
  const byMac = {};
  for (const d of devices) {
    const r = d.result ? JSON.parse(d.result) : null;
    results[d.id] = r;
    for (const m of (r && r.ownMacs) || []) byMac[m] = d.id;
    if (d.mac) byMac[d.mac] = d.id; // an unmanaged switch's MAC, if you gave one
  }
  // Devices that only know their IP (a Proxmox node): find their MAC through what the ARP tables and DHCP
  // leases say has that IP.
  const ipToMac = {};
  for (const r of all(db.prepare("select mac, ip from clients where ip != '' union all select mac, ip from names where ip != ''"))) ipToMac[r.ip] = ipToMac[r.ip] || r.mac;
  // ...and the other way round, for unmanaged switches you gave a MAC: any IP or name ever recorded for it
  // (ARP or DHCP, stale or not), since an unmanaged switch can't tell us itself.
  const macInfo = {};
  for (const r of all(db.prepare(`select mac, ip, hostname, 'ARP/DHCP' src from names union all select mac, ip, hostname, 'ARP' src from clients`))) {
    const cur = macInfo[r.mac] || (macInfo[r.mac] = { ip: "", hostname: "", src: "" });
    if (!cur.ip && r.ip) { cur.ip = r.ip; cur.src = r.src; }
    if (!cur.hostname && r.hostname) cur.hostname = r.hostname;
  }
  for (const d of devices) {
    for (const ip of (results[d.id] && results[d.id].ownIps) || []) {
      const m = ipToMac[ip];
      if (m && byMac[m] == null) byMac[m] = d.id;
    }
  }

  // Sightings within the time window, grouped per MAC.
  const since = new Date(Date.now() - clientMaxAgeMinutes * 60000).toISOString();
  const sightings = all(db.prepare("select * from sightings where seen_at >= ?"), since);
  const macsPerPort = {};
  for (const s of sightings) if (s.via === "fdb") { const k = s.device_id + "|" + s.iface; macsPerPort[k] = (macsPerPort[k] || 0) + 1; }
  const perMac = {};
  for (const s of sightings) (perMac[s.mac] || (perMac[s.mac] = [])).push({ ...s, detail: s.detail ? JSON.parse(s.detail) : null });

  // ---------- device tree ----------
  const root = pickRoot(devices, results);
  // seen[x][y] = { port, macs }: the port on device x where device y's MAC is in the MAC table.
  const seen = {};
  for (const [mac, list] of Object.entries(perMac)) {
    const y = byMac[mac];
    if (!y) continue;
    for (const s of list) {
      if (s.via !== "fdb" || s.device_id === y) continue;
      const macs = macsPerPort[s.device_id + "|" + s.iface] || 0;
      const cur = (seen[s.device_id] || (seen[s.device_id] = {}))[y];
      if (!cur || macs < cur.macs) seen[s.device_id][y] = { port: s.iface, macs };
    }
  }
  const uplink = {};
  for (const d of devices) if (d.id !== root && seen[d.id] && seen[d.id][root]) uplink[d.id] = seen[d.id][root].port;

  // LLDP on physical ports, matched to managed devices by chassis MAC, management IP or name.
  const byName = {};
  for (const d of devices) {
    byName[d.name.toLowerCase()] = d.id;
    const h = results[d.id] && results[d.id].system && results[d.id].system.hostname;
    if (h) byName[h.toLowerCase()] = d.id;
  }
  // (empty hosts and names never match: an unmanaged switch has no host, and many LLDP entries no IP)
  const byHost = Object.fromEntries(devices.filter((x) => x.host).map((x) => [x.host, x.id]));
  const lldp = []; // { a, aPort, b, bPort }
  for (const d of devices) {
    for (const n of (results[d.id] && results[d.id].neighbors) || []) {
      const other = (n.chassisId && byMac[n.chassisId]) || (n.mgmtIp && byHost[n.mgmtIp]) || (n.sysName && byName[n.sysName.toLowerCase()]);
      if (!other || other === d.id || isBridgePort(n.localPort)) continue;
      lldp.push({ a: d.id, aPort: n.localPort, b: other, bPort: n.portDescr || n.portId });
    }
  }
  const manual = all(db.prepare("select * from links"));

  // Candidates for each device's parent, best first: drawn cable, LLDP, then MAC table (fewest MACs wins).
  const parentOf = {};
  const isCore = new Set(devices.filter((d) => d.is_core && d.id !== root).map((d) => d.id));
  const coreLinks = []; // real cables between core switches, drawn beside the tree
  for (const y of devices.map((d) => d.id)) {
    if (y === root) continue;
    const cands = [];
    // A drawn cable runs from the upstream device (a) down to b.
    for (const l of manual) {
      if (l.b_device === y) cands.push({ x: l.a_device, xPort: l.a_port, yPort: l.b_port, via: "manual", rank: 0, macs: 0, linkId: l.id });
    }
    for (const l of lldp) {
      if (l.b === y && l.aPort !== uplink[l.a]) cands.push({ x: l.a, xPort: l.aPort, yPort: l.bPort, via: "lldp", rank: 1, macs: (macsPerPort[l.a + "|" + l.aPort] || 0) });
    }
    for (const x of Object.keys(seen).map(Number)) {
      const s = seen[x][y];
      if (x !== y && s && s.port !== uplink[x]) cands.push({ x, xPort: s.port, yPort: uplink[y] || "", via: "fdb", rank: 2, macs: s.macs });
    }
    // A drawn cable or LLDP link to a device that is itself below y would make a loop; prefer candidates
    // that y does not see on a downlink.
    cands.sort((a, b) => a.rank - b.rank || a.macs - b.macs);
    const best = cands.find((c) => !(seen[y] && seen[y][c.x] && seen[y][c.x].port !== uplink[y]) || c.via === "manual") || cands[0];
    if (isCore.has(y) && root != null) {
      if (best && best.x === root) parentOf[y] = best; // really cabled to the gateway
      else {
        // The role puts it on the core row under the gateway, but that's a position, not a cable: the edge is
        // layout-only, and the real cable (if known) is drawn beside it.
        parentOf[y] = { x: root, xPort: "", yPort: "", via: "role", layoutOnly: true, real: best || null, rank: 9, macs: 0 };
        if (best) coreLinks.push({ a: best.x, aPort: best.xPort, b: y, bPort: best.yPort, via: best.via, linkId: best.linkId });
      }
    } else if (best) parentOf[y] = best;
  }
  // Break any loop left over (e.g. contradictory hand-drawn cables): walk up from each device.
  for (const y of Object.keys(parentOf).map(Number)) {
    const path = new Set([y]);
    let cur = parentOf[y] && parentOf[y].x;
    while (cur != null && parentOf[cur]) {
      if (path.has(cur)) { delete parentOf[y]; break; }
      path.add(cur);
      cur = parentOf[cur].x;
    }
  }

  // An unmanaged switch with a known place (a port on its parent) is in front of everything else the switches
  // only see on that same port: those devices and clients move behind it. Direct evidence (LLDP, a cable or
  // placement you set) keeps things where they are. Only when exactly one unmanaged switch is on that port.
  // (also switches that report links but have no MAC table, like TP-Link Easy Smart)
  const unmanaged = new Set(devices.filter((d) => d.driver === "none" || (results[d.id] && results[d.id].noMacTable)).map((d) => d.id));
  const behind = {}; // "parent|port" -> unmanaged switch id
  const onPort = {};
  for (const u of unmanaged) {
    const p = parentOf[u];
    if (p && p.xPort) (onPort[p.x + "|" + p.xPort] = onPort[p.x + "|" + p.xPort] || []).push(u);
  }
  for (const [k, list] of Object.entries(onPort)) if (list.length === 1) behind[k] = list[0];
  for (const [y, p] of Object.entries(parentOf)) {
    const u = behind[p.x + "|" + p.xPort];
    if (u != null && u !== Number(y) && p.via === "fdb" && !isCore.has(Number(y))) parentOf[y] = { ...p, x: u, xPort: "", via: "behind" };
  }

  const depth = {};
  const depthOf = (id, guard = 0) => (depth[id] != null ? depth[id] : (depth[id] = parentOf[id] && guard < 50 ? depthOf(parentOf[id].x, guard + 1) + 1 : 0));
  const nodes = devices.map((d) => {
    const r = results[d.id];
    const p = parentOf[d.id];
    return {
      // a Proxmox device logs in through any node's API; show the node's own address
      id: "d" + d.id, kind: "device", deviceId: d.id, name: d.name, apiHost: d.host,
      host: (d.driver === "proxmox" && r && r.ownIps && r.ownIps[0]) || (d.driver === "none" && d.mac && macInfo[d.mac] ? macInfo[d.mac].ip : "") || d.host,
      // an unmanaged switch's IP and name, looked up from its MAC
      macIp: d.driver === "none" && d.mac && macInfo[d.mac] ? macInfo[d.mac] : null, mac: d.mac || "", driver: d.driver, enabled: !!d.enabled,
      status: d.driver === "none" ? "unmanaged" : !d.polled_at ? "pending" : d.ok ? "ok" : "error", error: d.error || null, polledAt: d.polled_at, lastOkAt: d.last_ok_at,
      // polling paused (until pausedUntil); the last data stays, but it isn't live
      pausedUntil: d.paused_until && d.paused_until > new Date().toISOString() ? d.paused_until : null,
      notes: d.notes, x: d.x, y: d.y, isRoot: d.id === root, rootMarked: !!d.is_root, isCore: isCore.has(d.id), depth: depthOf(d.id),
      // the gateway's WAN, drawn as a link up to the internet
      wan: d.id === root && r ? (r.interfaces || []).filter((i) => /^wan|pppoe|^lte|^wwan/i.test(i.name) && i.up)
        .map((i) => ({ name: i.name, device: i.device, ipv4: i.ipv4, proto: i.proto })) : [],
      parent: p ? "d" + p.x : null, parentPort: p ? p.xPort : null, uplinkPort: p ? p.yPort : uplink[d.id] || null, parentVia: p ? p.via : null,
      // the device's own name for its uplink port (where it sees the gateway), for drawing it on its faceplate
      localUplink: uplink[d.id] || null,
      // where it's really plugged in, when the role places it somewhere else on the map
      realParent: p && p.real ? "d" + p.real.x : null, realPort: p && p.real ? p.real.xPort : null, realUplinkPort: p && p.real ? p.real.yPort : null, realVia: p && p.real ? p.real.via : null,
      system: r && r.system, interfaces: (r && r.interfaces) || [], ports: (r && r.ports) || [], wifi: (r && r.wifi) || [],
      neighbors: (r && r.neighbors) || [], probes: (r && r.probes) || {},
      guests: (r && r.guests) || [], cluster: (r && r.cluster) || null, proxmoxNode: d.node || "",
      // PoE switches: power now and budget from the last poll, energy recorded so far
      poe: r && r.poe ? { ...r.poe, ...(energy[d.id] || {}) } : null
    };
  });

  const edges = [];
  const inTree = new Set();
  for (const [y, p] of Object.entries(parentOf)) {
    inTree.add([p.x, Number(y)].sort().join("|"));
    edges.push({ id: `t-${p.x}-${y}`, linkId: p.linkId || null, source: "d" + p.x, target: "d" + y, kind: p.via, tree: true, layoutOnly: !!p.layoutOnly, sourcePort: p.xPort || "", targetPort: p.yPort || "" });
  }
  const crossSeen = new Set();
  for (const l of coreLinks) {
    const k = [l.a, l.b].sort().join("|");
    if (inTree.has(k) || crossSeen.has(k)) continue;
    crossSeen.add(k);
    edges.push({ id: `core-${l.a}-${l.b}`, linkId: l.linkId || null, source: "d" + l.a, target: "d" + l.b, kind: l.via, cross: true, core: true, sourcePort: l.aPort, targetPort: l.bPort });
  }
  for (const l of manual) {
    const k = [l.a_device, l.b_device].sort().join("|");
    if (inTree.has(k) || crossSeen.has(k)) continue;
    crossSeen.add(k);
    edges.push({ id: "l" + l.id, linkId: l.id, source: "d" + l.a_device, target: "d" + l.b_device, kind: "manual", cross: true, sourcePort: l.a_port, targetPort: l.b_port, note: l.note });
  }
  for (const l of lldp) {
    const k = [l.a, l.b].sort().join("|");
    if (inTree.has(k) || crossSeen.has(k)) continue;
    crossSeen.add(k);
    edges.push({ id: `x-${l.a}-${l.b}`, source: "d" + l.a, target: "d" + l.b, kind: "lldp", cross: true, sourcePort: l.aPort, targetPort: l.bPort });
  }

  // On the map = seen right now on Wi-Fi, in a MAC table, or as a running VM. An ARP entry alone doesn't count:
  // Linux keeps stale ones after a device leaves (and /proc/net/arp can't tell them apart), so ARP only adds IPs,
  // like DHCP adds names. Exception: ARP on the gateway's WAN side, which is how the ISP's router is found.
  const clients = all(db.prepare(`select c.*, n.hostname as lease_name, n.ip as lease_ip from clients c
    left join names n on n.mac = c.mac
    where c.mac in (select mac from sightings where seen_at >= ?)`), since);
  // The gateway's WAN side (the ISP's router, a modem) is the internet, not a LAN client: anything seen only
  // on the gateway's WAN interfaces goes into the gateway's `upstream` list, shown in the Internet node.
  const rootNode = nodes.find((n) => n.isRoot);
  // a client you placed by hand still needs to be seen somewhere, but ARP is enough for it
  const placedOk = (c) => c.placed_device && devices.some((d) => d.id === c.placed_device);
  const wanIfaces = new Set(rootNode ? rootNode.wan.flatMap((i) => [i.device, i.name]).filter(Boolean) : []);
  if (rootNode) rootNode.upstream = [];
  for (const c of clients) {
    if (byMac[c.mac]) continue;
    const list = perMac[c.mac] || [];
    const wanOnly = rootNode && list.length && list.every((s) => s.device_id === rootNode.deviceId && wanIfaces.has(s.iface));
    if (!wanOnly && !placedOk(c) && !list.some((s) => s.via !== "arp")) continue; // only a (possibly stale) ARP entry
    if (wanOnly) {
      const maker = lookup(c.mac) || {};
      rootNode.upstream.push({ mac: c.mac, ip: c.lease_ip || c.ip, hostname: c.lease_name || c.hostname, vendor: maker.vendor || null });
      continue;
    }
    const wifi = list.filter((s) => s.via === "wifi").sort((a, b) => ((b.detail && b.detail.signal) ?? -999) - ((a.detail && a.detail.signal) ?? -999))[0];
    // Bridge ports that aren't wireless: a Wi-Fi client also appears in the fdb on the AP's wlan port.
    const wifiIfaces = new Set(list.filter((s) => s.via === "wifi").map((s) => s.device_id + "|" + s.iface));
    const fdb = list.filter((s) => s.via === "fdb" && !wifiIfaces.has(s.device_id + "|" + s.iface))
      .sort((a, b) => macsPerPort[a.device_id + "|" + a.iface] - macsPerPort[b.device_id + "|" + b.iface])[0];
    const l3 = list.find((s) => s.via === "arp");
    // Where you said it's plugged in beats anything the switches report.
    const placed = c.placed_device && devices.some((d) => d.id === c.placed_device)
      ? { device_id: c.placed_device, via: "manual", iface: c.placed_port || "", detail: null } : null;
    // A VM or container is on the Proxmox node that runs it, whatever port the switches see it behind.
    const vm = list.find((s) => s.via === "vm");
    let at = placed || vm || wifi || fdb || l3;
    if (at && at === fdb && behind[at.device_id + "|" + at.iface] != null) at = { ...at, device_id: behind[at.device_id + "|" + at.iface], via: "fdb", iface: "" };
    const id = "c" + c.mac;
    const hostname = c.lease_name || c.hostname, ip = c.lease_ip || c.ip;
    const maker = { ...(lookup(c.mac) || {}) };
    // Proxmox makes up locally administered MACs for VMs: that's a virtual NIC, not a phone's privacy MAC.
    if (at && at.via === "vm" && maker.randomized) { maker.randomized = false; maker.vendor = "Virtual NIC (Proxmox)"; }
    nodes.push({
      id, kind: "client", mac: c.mac, name: c.label || hostname || c.mac, label: c.label, hostname, ip,
      vendor: maker.vendor || null, randomized: !!maker.randomized,
      firstSeen: c.first_seen, lastSeen: c.last_seen, x: c.x, y: c.y,
      via: at ? at.via : null, placedDevice: placed ? c.placed_device : null, placedPort: placed ? c.placed_port : "", sightings: list.map(({ device_id, via, iface, detail, seen_at }) => ({ deviceId: device_id, via, iface, detail, seenAt: seen_at }))
    });
    if (at) edges.push({
      id: "e" + c.mac, source: "d" + at.device_id, target: id, kind: at.via, sourcePort: at.iface,
      ssid: at.detail && at.detail.ssid, signal: at.detail && at.detail.signal
    });
  }

  return { generatedAt: new Date().toISOString(), nodes, edges };
}

module.exports = { build, plain };
