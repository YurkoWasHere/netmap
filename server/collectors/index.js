// Collectors: extra ways to read a device, next to its main driver. A device has one driver (it decides what
// the device is: ports, MAC table, ...) and any number of collectors, each filling in something the driver can't
// get, e.g. a Netgear switch is read over SNMP, plus its web UI for per-port PoE watts SNMP doesn't offer.
//
// A collector's collect(col) gets its row from the collectors table (host blank = the device's host) and returns
//   { probes: { name: "ok" | error }, portPoe?: { "<port>": { status, cls, volts, mA, mW } }, poe?: { budgetW, usedW, on },
//     names?: { mac: { hostname, ip } }, clients?: [{ mac, via, iface, detail }] }
// merge() folds that into the driver's result, so the map, faceplate and energy log need no changes.
const kinds = { "netgear-web": require("./netgear-web.js"), "edgeos-web": require("./edgeos-web.js"), "edgeos-ssh": require("./edgeos-ssh.js") };

// Driver port names for a collector's port number: "5" matches 5, g5, gi5, GigabitEthernet5, 1/0/5, ...
const portNumber = (name) => { const m = String(name).match(/(\d+)$/); return m ? m[1] : null; };

function merge(r, kind, got) {
  for (const [k, v] of Object.entries(got.probes || {})) r.probes[`${kind}:${k}`] = v;
  // names (DHCP leases): fill in what the driver didn't have
  if (got.names) {
    r.names = r.names || {};
    for (const [mac, n] of Object.entries(got.names)) {
      const cur = r.names[mac] || {};
      r.names[mac] = { hostname: cur.hostname || n.hostname || "", ip: cur.ip || n.ip || "" };
    }
  }
  // which physical jack an interface rides on (pppoe0 -> eth5): marks the WAN's port
  if (got.ifaceJacks) for (const i of r.interfaces || []) if (got.ifaceJacks[i.name] && !i.port) i.port = got.ifaceJacks[i.name];
  // clients (a MAC table): replace the driver's sighting of the same MAC the same way, never the device's own MACs
  if (got.clients) {
    const own = new Set(r.ownMacs || []);
    const add = got.clients.filter((c) => !own.has(c.mac));
    const key = (c) => c.mac + "|" + c.via;
    const theirs = new Set(add.map(key));
    r.clients = (r.clients || []).filter((c) => !theirs.has(key(c))).concat(add.map((c) => {
      const n = r.names && r.names[c.mac];
      const arp = (r.clients || []).find((x) => x.mac === c.mac && x.ip);
      return { ...c, ip: c.ip || (arp && arp.ip) || (n && n.ip) || "", hostname: c.hostname || (n && n.hostname) || "" };
    }));
  }
  if (got.portPoe) {
    const ports = (r.ports || []).filter((p) => p.type === "port" || !p.type);
    for (const p of ports) {
      const n = portNumber(p.name);
      const x = n != null ? got.portPoe[n] : null;
      if (x) p.poe = { ...(p.poe || {}), ...x, cls: x.cls ?? (p.poe && p.poe.cls) };
    }
  }
  if (got.poe) r.poe = { ...(r.poe || {}), ...got.poe, source: kind };
  else if (got.portPoe && !r.poe) {
    // no total from the unit: add up the ports
    const mW = Object.values(got.portPoe).reduce((a, x) => a + (x.mW || 0), 0);
    r.poe = { usedW: Math.round(mW / 100) / 10, budgetW: null, on: mW > 0, source: kind };
  }
}

// Run each enabled collector; one failing doesn't fail the poll (its probe shows the error).
async function runAll(dev, cols, r) {
  for (const c of cols) {
    const k = kinds[c.kind];
    if (!k) { r.probes[`${c.kind}:collector`] = "unknown collector"; continue; }
    const col = { ...c, host: c.host || dev.host };
    try { merge(r, c.kind, await k.collect(col)); }
    catch (e) {
      const names = Object.keys(k.probes || { collector: 1 });
      for (const n of names) r.probes[`${c.kind}:${n}`] = e.message || String(e);
    }
  }
  return r;
}

// Drop a collector's session (logging out where the kind can), e.g. when it's removed or its login changes.
async function forget(col) {
  const k = kinds[col.kind];
  if (k && k.logout) await k.logout(col).catch(() => {});
}

module.exports = { kinds, runAll, merge, forget };
