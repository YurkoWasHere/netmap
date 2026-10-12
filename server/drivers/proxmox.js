// Proxmox VE driver: one netmap device per cluster node. Logs in with a PVE-realm account (user@pve, e.g. with
// the PVEAuditor role: read-only) and only makes GET requests after that.
// The device row: host/port = any node's API (default 8006, HTTPS), username/password, node = which node this
// device is. Cluster-wide reads are shared between the node devices of one cluster for a short while.
//
// Returns the normalised shape (see drivers/openwrt.js), plus:
//   guests   this node's VMs and containers: vmid, name, type, status, cpu, mem, nics [{ mac, bridge, tag }]
//   ownIps   the node's IP: Proxmox doesn't report the node's MAC, so the map finds it through ARP
//   cluster  { name, quorate, nodes: [{ name, ip, online }] }
// Running guests' NICs are clients `via: "vm"` on their bridge, which beats what the switches see.
const https = require("https");

const TICKET_MS = 90 * 60 * 1000;   // PVE tickets last 2 h
const SHARED_MS = 20 * 1000;        // cluster-wide reads shared between node devices
const CONFIG_MS = 10 * 60 * 1000;   // guest configs (MACs, bridges) rarely change

const tickets = new Map();  // host|port|user -> { ticket, at }
const shared = new Map();   // host|port|user|route -> { at, data }
const configs = new Map();  // host|node|type|vmid -> { at, data }

// "monitor" -> "monitor@pve": netmap logs in through the PVE realm, not PAM.
const realmUser = (u) => (String(u || "").includes("@") ? String(u) : `${u}@pve`);

function request(dev, method, route, { body, ticket } = {}) {
  const payload = body ? new URLSearchParams(body).toString() : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: dev.host, port: dev.port || 8006, path: "/api2/json" + route, method,
      rejectUnauthorized: !!dev.verify_tls, // Proxmox ships a self-signed certificate
      timeout: 10000, agent: false,
      headers: Object.assign(
        ticket ? { Cookie: "PVEAuthCookie=" + ticket } : {},
        payload ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) } : {}
      )
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode === 401) return reject(new Error("login failed: wrong user or password (the account must be in the PVE realm, e.g. monitor@pve)"));
        if (res.statusCode === 403) return reject(new Error(`${route}: permission denied (give the account the PVEAuditor role on /)`));
        if (res.statusCode !== 200) return reject(new Error(`${route} returned HTTP ${res.statusCode}${buf ? ": " + buf.slice(0, 120).trim() : ""}`));
        try { resolve(JSON.parse(buf).data); } catch (e) { reject(new Error(`${route}: bad JSON`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => reject(e.code === "ECONNREFUSED" ? new Error(`nothing answering on ${dev.host}:${dev.port || 8006}`) : e));
    req.end(payload);
  });
}

async function session(dev) {
  const user = realmUser(dev.username);
  if (/@pam$/i.test(user)) throw new Error("use a PVE-realm account (user@pve), not a PAM one");
  const key = `${dev.host}|${dev.port || 8006}|${user}`;
  const t = tickets.get(key);
  let ticket = t && Date.now() - t.at < TICKET_MS ? t.ticket : null;
  if (!ticket) {
    const auth = await request(dev, "POST", "/access/ticket", { body: { username: user, password: dev.password } });
    ticket = auth.ticket;
    tickets.set(key, { ticket, at: Date.now() });
  }
  const get = (route) => request(dev, "GET", route, { ticket }).catch((e) => {
    if (/login failed/.test(e.message)) tickets.delete(key);
    throw e;
  });
  const getShared = async (route) => {
    const k = key + "|" + route;
    const hit = shared.get(k);
    if (hit && Date.now() - hit.at < SHARED_MS) return hit.data;
    const data = await get(route);
    shared.set(k, { at: Date.now(), data });
    return data;
  };
  return { get, getShared, key };
}

// "virtio=BC:24:11:69:BD:5E,bridge=vmbr0,tag=500,firewall=1" (VM) or
// "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:69:BD:5E,ip=192.168.42.238/24,type=veth" (container)
function parseNic(s) {
  const kv = Object.fromEntries(String(s).split(",").map((p) => { const i = p.indexOf("="); return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)]; }));
  const model = Object.keys(kv).find((k) => /^(virtio|e1000e?|rtl8139|vmxnet3|ne2k_pci|pcnet|i82551|i82557b|i82559er|ne2k_isa)$/.test(k));
  const mac = (kv.hwaddr || (model && kv[model]) || "").toLowerCase();
  const ip = kv.ip && kv.ip !== "dhcp" && kv.ip !== "manual" ? kv.ip.split("/")[0] : "";
  return { mac, bridge: kv.bridge || "", tag: kv.tag ? Number(kv.tag) : null, ip, model: model || kv.type || "" };
}

async function listNodes(dev) {
  const s = await session(dev);
  const status = await s.get("/cluster/status");
  const cluster = status.find((r) => r.type === "cluster");
  return { cluster: cluster ? cluster.name : "", nodes: status.filter((r) => r.type === "node").map((n) => ({ name: n.name, ip: n.ip || "", online: !!n.online })) };
}

async function poll(dev) {
  if (!dev.node) throw new Error("no node chosen for this device");
  const out = { system: null, interfaces: [], ports: [], wifi: [], clients: [], neighbors: [], ownMacs: [], ownIps: [], names: {}, guests: [], cluster: null, probes: {} };
  const probe = async (name, fn) => {
    try { await fn(); out.probes[name] = "ok"; } catch (e) { out.probes[name] = e.message || String(e); }
  };
  const s = await session(dev); // login errors fail the poll
  const node = encodeURIComponent(dev.node);

  let resources = [];
  await probe("cluster", async () => {
    const [status, res] = await Promise.all([s.getShared("/cluster/status"), s.getShared("/cluster/resources")]);
    resources = res;
    const c = status.find((r) => r.type === "cluster") || {};
    const nodes = status.filter((r) => r.type === "node");
    out.cluster = { name: c.name || "", quorate: !!c.quorate, nodes: nodes.map((n) => ({ name: n.name, ip: n.ip || "", online: !!n.online })) };
    const me = nodes.find((n) => n.name === dev.node);
    if (!me) throw new Error(`no node called ${dev.node} in this cluster (it has ${nodes.map((n) => n.name).join(", ")})`);
    if (!me.online) throw new Error(`${dev.node} is offline according to the cluster`);
    if (me.ip) out.ownIps.push(me.ip);
  });
  if (out.probes.cluster !== "ok" && /no node called|offline/.test(out.probes.cluster)) throw new Error(out.probes.cluster);

  await probe("node", async () => {
    const st = await s.get(`/nodes/${node}/status`);
    const ver = String(st.pveversion || "").split("/")[1] || st.pveversion || "";
    out.system = {
      hostname: dev.node, model: `Proxmox VE node${st.cpuinfo && st.cpuinfo.model ? " · " + st.cpuinfo.model.replace(/\s+/g, " ") : ""}`,
      release: ver ? `Proxmox VE ${ver}` : "Proxmox VE", kernel: st["current-kernel"] ? st["current-kernel"].release : st.kversion || "",
      uptime: st.uptime || 0, load: (st.loadavg || []).map(Number),
      memory: st.memory ? { total: st.memory.total, free: st.memory.free, available: st.memory.available ?? null } : null,
      cpu: st.cpu ?? null, cpus: st.cpuinfo ? st.cpuinfo.cpus : null
    };
  });

  await probe("network", async () => {
    const net = await s.get(`/nodes/${node}/network`);
    const memberOf = {};
    for (const n of net) for (const p of String(n.bridge_ports || n.slaves || "").split(/\s+/).filter(Boolean)) memberOf[p] = n.iface;
    out.ports = net.filter((n) => /^(eth|bond|bridge|vlan|OVSBridge|OVSPort)$/.test(n.type))
      .map((n) => ({ name: n.iface, type: n.type === "bridge" ? "bridge" : n.type, up: !!n.active, carrier: !!n.active, speed: "", mac: "", bridge: memberOf[n.iface] || null,
        members: String(n.bridge_ports || n.slaves || "").split(/\s+/).filter(Boolean), alias: n.comments ? String(n.comments).trim() : "" }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    out.interfaces = net.filter((n) => n.cidr || n.address).map((n) => ({
      name: n.iface, up: !!n.active, proto: n.method || "static", device: n.iface, ipv4: [n.cidr || `${n.address}/${n.netmask || 32}`], ipv6: n.cidr6 ? [n.cidr6] : [], uptime: 0
    }));
  });

  // This node's guests, with NICs from their configs (cached: MACs and bridges rarely change).
  await probe("guests", async () => {
    const mine = resources.filter((r) => (r.type === "qemu" || r.type === "lxc") && r.node === dev.node && !r.template);
    let failed = 0;
    for (const g of mine.sort((a, b) => a.vmid - b.vmid)) {
      const ck = `${dev.host}|${dev.node}|${g.type}|${g.vmid}`;
      let cfg = configs.get(ck);
      if (!cfg || Date.now() - cfg.at > CONFIG_MS) {
        try { cfg = { at: Date.now(), data: await s.get(`/nodes/${node}/${g.type}/${g.vmid}/config`) }; configs.set(ck, cfg); }
        catch (e) { failed++; cfg = cfg || { at: 0, data: {} }; }
      }
      const nics = Object.entries(cfg.data).filter(([k]) => /^net\d+$/.test(k)).map(([k, v]) => ({ id: k, ...parseNic(v) })).filter((n) => n.mac);
      const guest = {
        vmid: g.vmid, name: g.name || `${g.type} ${g.vmid}`, type: g.type, status: g.status, cpu: g.cpu || 0, maxcpu: g.maxcpu || 0,
        mem: g.mem || 0, maxmem: g.maxmem || 0, uptime: g.uptime || 0, nics,
        netin: g.netin ?? null, netout: g.netout ?? null // byte counters, turned into rates by rates.js
      };
      out.guests.push(guest);
      for (const n of nics) {
        // Names for every guest's MACs (stopped ones too), so a VM is labelled wherever a switch sees it.
        out.names[n.mac] = { hostname: guest.name, ip: n.ip };
        if (g.status === "running") {
          out.clients.push({
            mac: n.mac, via: "vm", iface: n.bridge + (n.tag ? `.${n.tag}` : ""), ip: n.ip, hostname: guest.name,
            detail: { vmid: g.vmid, type: g.type, guest: guest.name, nic: n.id, model: n.model, vlan: n.tag, cpu: guest.cpu, mem: guest.mem, maxmem: guest.maxmem }
          });
        }
      }
    }
    if (failed && failed === mine.length) throw new Error("couldn't read any guest config (the account needs VM.Audit, e.g. the PVEAuditor role)");
  });

  if (!out.system && out.probes.cluster !== "ok") throw new Error(out.probes.cluster || out.probes.node);
  return out;
}

module.exports = { poll, listNodes, realmUser, parseNic };
