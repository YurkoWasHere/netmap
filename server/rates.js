// Traffic rates from byte counters: each poll's counters are compared with the previous poll's, and the
// difference over the time between them becomes bits per second. Kept in memory: after a restart, rates come
// back on the second poll.
//   ports[]    rxBps / txBps from rxBytes / txBytes (SNMP ifHC*Octets, OpenWrt interface statistics). rx is what
//              the port receives (from whatever is plugged into it), tx what it sends to it. Ports with only
//              packet counters (rxPkts / txPkts) get rxPps / txPps instead.
//   guests[]   inBps / outBps from Proxmox netin / netout, copied onto the guest's VM clients too.
const prev = new Map(); // deviceId -> { t, ports: { name: { rx, tx } }, guests: { vmid: { in, out } } }

const perSec = (now, before, secs) => (before != null && now != null && now >= before && secs > 0 ? (now - before) / secs : null);
const rate = (now, before, secs) => (before != null && now != null && now >= before && secs > 0 ? ((now - before) * 8) / secs : null);

function apply(deviceId, r, t = Date.now()) {
  const last = prev.get(deviceId);
  const secs = last ? (t - last.t) / 1000 : 0;
  const next = { t, ports: {}, guests: {} };
  for (const p of r.ports || []) {
    const b = last && last.ports[p.name];
    if (p.rxBytes != null || p.txBytes != null) {
      next.ports[p.name] = { rx: p.rxBytes, tx: p.txBytes };
      if (b) { p.rxBps = rate(p.rxBytes, b.rx, secs); p.txBps = rate(p.txBytes, b.tx, secs); }
    } else if (p.rxPkts != null || p.txPkts != null) {
      // switches that only count packets (TP-Link Easy Smart): packets per second instead
      next.ports[p.name] = { rxP: p.rxPkts, txP: p.txPkts };
      if (b) { p.rxPps = perSec(p.rxPkts, b.rxP, secs); p.txPps = perSec(p.txPkts, b.txP, secs); }
    }
  }
  for (const g of r.guests || []) {
    if (g.netin == null) continue;
    next.guests[g.vmid] = { in: g.netin, out: g.netout };
    const b = last && last.guests[g.vmid];
    // netin is what the guest received; seen from the node's bridge that's traffic going to the guest
    if (b) { g.inBps = rate(g.netin, b.in, secs); g.outBps = rate(g.netout, b.out, secs); }
  }
  const byVmid = Object.fromEntries((r.guests || []).map((g) => [g.vmid, g]));
  for (const c of r.clients || []) {
    const g = c.via === "vm" && c.detail && byVmid[c.detail.vmid];
    if (g) c.detail = { ...c.detail, inBps: g.inBps ?? null, outBps: g.outBps ?? null };
  }
  prev.set(deviceId, next);
  return r;
}

module.exports = { apply };
