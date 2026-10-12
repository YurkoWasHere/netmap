// SNMP driver (v2c, read-only): managed switches and anything else that speaks the standard MIBs.
// The device row's `password` holds the community string and `port` the SNMP port (default 161).
//
// Returns the same normalised shape as the OpenWrt driver (see drivers/openwrt.js):
//   system      sysName, sysDescr, uptime, location
//   interfaces  interfaces that have an IP address (IP-MIB)
//   ports       physical ports from IF-MIB: link, speed, your port description (ifAlias), MAC
//   clients     MACs behind each port (Q-BRIDGE-MIB, falling back to BRIDGE-MIB) and the ARP table
//   neighbors   LLDP-MIB remote systems
//   ownMacs     bridge base MAC and port MACs
//   poe         PoE switches only: { budgetW, usedW, on } (POWER-ETHERNET-MIB, whole switch)
//   probes      which MIBs answered
const snmp = require("net-snmp");

const SYS = { descr: "1.3.6.1.2.1.1.1.0", objectId: "1.3.6.1.2.1.1.2.0", uptime: "1.3.6.1.2.1.1.3.0", contact: "1.3.6.1.2.1.1.4.0", name: "1.3.6.1.2.1.1.5.0", location: "1.3.6.1.2.1.1.6.0" };
const OID = {
  ifDescr: "1.3.6.1.2.1.2.2.1.2", ifType: "1.3.6.1.2.1.2.2.1.3", ifPhys: "1.3.6.1.2.1.2.2.1.6",
  ifAdmin: "1.3.6.1.2.1.2.2.1.7", ifOper: "1.3.6.1.2.1.2.2.1.8",
  ifName: "1.3.6.1.2.1.31.1.1.1.1", ifHcIn: "1.3.6.1.2.1.31.1.1.1.6", ifHcOut: "1.3.6.1.2.1.31.1.1.1.10",
  ifHighSpeed: "1.3.6.1.2.1.31.1.1.1.15", ifAlias: "1.3.6.1.2.1.31.1.1.1.18",
  ipAdIfIndex: "1.3.6.1.2.1.4.20.1.2", ipAdMask: "1.3.6.1.2.1.4.20.1.3",
  arp: "1.3.6.1.2.1.4.22.1.2",
  bridgeMac: "1.3.6.1.2.1.17.1.1.0", basePortIf: "1.3.6.1.2.1.17.1.4.1.2",
  qFdbPort: "1.3.6.1.2.1.17.7.1.2.2.1.2", qFdbStatus: "1.3.6.1.2.1.17.7.1.2.2.1.3",
  dFdbPort: "1.3.6.1.2.1.17.4.3.1.2", dFdbStatus: "1.3.6.1.2.1.17.4.3.1.3",
  lldpChassis: "1.0.8802.1.1.2.1.4.1.1.5", lldpPortId: "1.0.8802.1.1.2.1.4.1.1.7",
  lldpPortDesc: "1.0.8802.1.1.2.1.4.1.1.8", lldpSysName: "1.0.8802.1.1.2.1.4.1.1.9",
  poeMain: "1.3.6.1.2.1.105.1.3.1.1" // pethMainPseTable: .2 budget W, .3 status, .4 consumption W
};
// Ethernet-ish port types; leaves out VLAN interfaces, loopbacks, tunnels and LAG/CPU pseudo-ports.
const PORT_TYPES = new Set([6, 62, 69, 71, 117]);
const FDB_LEARNED = 3;

const text = (v) => (Buffer.isBuffer(v) ? v.toString("utf8").replace(/\0+$/, "").trim() : v == null ? "" : String(v));
const big = (v) => (Buffer.isBuffer(v) ? v.reduce((a, b) => a * 256n + BigInt(b), 0n) : BigInt(v || 0));
const hexMac = (v) => (Buffer.isBuffer(v) && v.length === 6 ? [...v].map((b) => b.toString(16).padStart(2, "0")).join(":") : "");
// LLDP fields can be binary (a MAC or other ID); show those as hex instead of garbled text.
const lldpText = (v) => (Buffer.isBuffer(v) && v.length === 6 && [...v].some((b) => b < 0x20 || b > 0x7e) ? hexMac(v)
  : Buffer.isBuffer(v) && [...v].some((b) => b < 0x20 || b > 0x7e) ? [...v].map((b) => b.toString(16).padStart(2, "0")).join(":") : text(v));
const isUnicast = (m) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m) && !(parseInt(m.slice(0, 2), 16) & 1) && m !== "00:00:00:00:00:00";
const fmtSpeed = (mbps) => (!mbps ? "" : mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);

function walk(session, oid) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    session.subtree(oid, 40, (vbs) => {
      for (const vb of vbs) if (!snmp.isVarbindError(vb)) out.set(vb.oid.slice(oid.length + 1), vb.value);
    }, (err) => (err ? reject(err) : resolve(out)));
  });
}
function get(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, vbs) => (err ? reject(err) : resolve(vbs.map((vb) => (snmp.isVarbindError(vb) ? null : vb.value)))));
  });
}
const explain = (e) => (/timed? ?out/i.test(e.message) ? "no answer (wrong community, SNMP turned off, or a firewall)" : e.message);

async function poll(dev) {
  const session = snmp.createSession(dev.host, dev.password || "public", { port: dev.port || 161, version: snmp.Version2c, timeout: 4000, retries: 1 });
  session.on("error", () => {});
  const out = { system: null, interfaces: [], ports: [], wifi: [], clients: [], neighbors: [], ownMacs: [], names: {}, probes: {} };
  const probe = async (name, fn) => {
    try { await fn(); out.probes[name] = "ok"; } catch (e) { out.probes[name] = explain(e); }
  };
  const w = {};
  const walkAll = async (keys, required) => {
    for (const k of keys) {
      try { w[k] = await walk(session, OID[k]); }
      catch (e) { if (required) throw e; w[k] = new Map(); }
    }
  };

  try {
    await probe("system", async () => {
      const v = await get(session, Object.values(SYS));
      const s = Object.fromEntries(Object.keys(SYS).map((k, i) => [k, v[i]]));
      const descr = text(s.descr);
      out.system = {
        hostname: text(s.name), model: descr.split(/[,\n]/)[0].slice(0, 80), descr, objectId: s.objectId ? String(s.objectId) : "",
        release: "", uptime: Math.round(Number(s.uptime || 0) / 100), location: text(s.location), contact: text(s.contact), load: [], memory: null
      };
    });
    if (out.probes.system !== "ok") throw new Error(out.probes.system);

    const ifName = {};
    await probe("ports", async () => {
      await walkAll(["ifType", "ifOper"], true);
      await walkAll(["ifDescr", "ifPhys", "ifAdmin", "ifName", "ifHcIn", "ifHcOut", "ifHighSpeed", "ifAlias"], false);
      for (const [i] of w.ifType) ifName[i] = text(w.ifName.get(i)) || text(w.ifDescr.get(i)) || `if${i}`;
      out.ports = [...w.ifType]
        .filter(([i, t]) => PORT_TYPES.has(Number(t)) && !/cpu|loopback|^lo$/i.test(ifName[i]))
        .map(([i]) => {
          const up = Number(w.ifOper.get(i)) === 1;
          return {
            name: ifName[i], ifIndex: Number(i), type: "port", up: Number(w.ifAdmin.get(i)) !== 2, carrier: up,
            speed: up ? fmtSpeed(Number(w.ifHighSpeed.get(i))) : "", mac: hexMac(w.ifPhys.get(i)), bridge: null, members: [],
            alias: text(w.ifAlias.get(i)), rxBytes: Number(big(w.ifHcIn.get(i))), txBytes: Number(big(w.ifHcOut.get(i)))
          };
        })
        .sort((a, b) => a.ifIndex - b.ifIndex);
    });

    await probe("addresses", async () => {
      await walkAll(["ipAdIfIndex", "ipAdMask"], true);
      const byIf = {};
      for (const [ip, ifi] of w.ipAdIfIndex) {
        if (ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
        const mask = text(w.ipAdMask.get(ip));
        const bits = mask ? mask.split(".").reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length, 0) : 32;
        (byIf[ifi] || (byIf[ifi] = [])).push(`${ip}/${bits}`);
      }
      // A VLAN interface named just "1" reads like port 1; call it what it is.
      const label = (i) => (!PORT_TYPES.has(Number(w.ifType && w.ifType.get(i))) && /^\d+$/.test(ifName[i] || "") ? `VLAN ${ifName[i]}` : ifName[i] || `if${i}`);
      out.interfaces = Object.entries(byIf).map(([i, ips]) => ({
        name: label(i), up: !w.ifOper || Number(w.ifOper.get(i)) === 1, proto: "static", device: ifName[i] || "", ipv4: ips, ipv6: [], uptime: 0
      }));
    });

    // MAC table: Q-BRIDGE (VLAN-aware) first, plain BRIDGE-MIB if the switch doesn't have it.
    await probe("fdb", async () => {
      await walkAll(["basePortIf"], false);
      const portToIf = (bp) => Number(text(w.basePortIf.get(String(bp)))) || Number(bp);
      let rows = [];
      try {
        await walkAll(["qFdbPort", "qFdbStatus"], true);
        for (const [suffix, bp] of w.qFdbPort) {
          const p = suffix.split(".").map(Number);
          rows.push({ vlan: p[0], mac: p.slice(1).map((b) => b.toString(16).padStart(2, "0")).join(":"), bp, status: Number(w.qFdbStatus.get(suffix)) });
        }
      } catch (e) { rows = []; }
      if (!rows.length) {
        await walkAll(["dFdbPort", "dFdbStatus"], true);
        for (const [suffix, bp] of w.dFdbPort) {
          rows.push({ vlan: null, mac: suffix.split(".").map((b) => Number(b).toString(16).padStart(2, "0")).join(":"), bp, status: Number(w.dFdbStatus.get(suffix)) });
        }
      }
      if (!rows.length) throw new Error("MAC table is empty or not exposed");
      for (const r of rows) {
        if (!isUnicast(r.mac) || (r.status && r.status !== FDB_LEARNED) || !Number(r.bp)) continue;
        const ifi = portToIf(r.bp);
        out.clients.push({ mac: r.mac, via: "fdb", iface: ifName[ifi] || `port ${r.bp}`, detail: { vlan: r.vlan } });
      }
    });

    await probe("lldp", async () => {
      await walkAll(["lldpSysName"], true);
      await walkAll(["lldpChassis", "lldpPortId", "lldpPortDesc"], false);
      for (const [suffix, sysName] of w.lldpSysName) {
        const local = suffix.split(".")[1];
        out.neighbors.push({
          localPort: ifName[local] || local, sysName: lldpText(sysName),
          chassisId: (() => { const c = w.lldpChassis.get(suffix); return hexMac(c) || lldpText(c); })(),
          portId: lldpText(w.lldpPortId.get(suffix)), portDescr: lldpText(w.lldpPortDesc.get(suffix)), mgmtIp: ""
        });
      }
    });

    await probe("arp", async () => {
      await walkAll(["arp"], true);
      for (const [suffix, phys] of w.arp) {
        const parts = suffix.split(".");
        const mac = hexMac(phys);
        if (isUnicast(mac)) out.clients.push({ mac, via: "arp", iface: ifName[parts[0]] || "", ip: parts.slice(1).join("."), detail: null });
      }
    });

    // PoE (POWER-ETHERNET-MIB): budget and power being delivered right now. Only switches with PoE answer;
    // the others get no "poe" line in their checklist.
    try {
      const pse = await walk(session, OID.poeMain);
      const col = (c) => [...pse].filter(([k]) => k.split(".")[0] === String(c)).map(([, v]) => Number(v));
      if (pse.size) {
        const sum = (a) => (a.length ? a.reduce((x, y) => x + y, 0) : null);
        out.poe = { budgetW: sum(col(2)), usedW: sum(col(4)), on: col(3).some((v) => v === 1) };
        out.probes.poe = "ok";
      }
    } catch (e) { /* no PoE */ }

    const bm = await get(session, [OID.bridgeMac]).catch(() => [null]);
    out.ownMacs = [...new Set([hexMac(bm[0]), ...out.ports.map((p) => p.mac)].filter(isUnicast))];
    const own = new Set(out.ownMacs);
    out.clients = out.clients.filter((c) => !own.has(c.mac)).map((c) => ({ ...c, ip: c.ip || "", hostname: c.hostname || "" }));
    return out;
  } finally {
    session.close();
  }
}

module.exports = { poll };
