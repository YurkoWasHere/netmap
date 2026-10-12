// OpenWrt driver: reads a router or AP over ubus JSON-RPC (POST /ubus, served by uhttpd-mod-ubus + rpcd).
// Read-only: logs in as a limited rpcd user and only calls the methods listed in docs/openwrt-setup.md.
//
// poll(device) returns the normalised shape every driver returns:
//   system      hostname, model, release, uptime, load, memory
//   interfaces  logical networks (lan, wan, ...) with addresses
//   ports       kernel net devices (eth0, lan1, br-lan, phy0-ap0, ...) with link state and bridge membership
//   wifi        access points: ssid, channel, client count
//   clients     MACs seen on this device right now: { mac, via: wifi|fdb|arp, iface, ip, hostname, detail }
//   names       mac -> { hostname, ip } from DHCP leases and host hints. Only used to label clients that
//               are online somewhere; a lease alone doesn't put a client on the map (it outlives the device).
//   neighbors   LLDP neighbours: { localPort, chassisId, sysName, portId, portDescr, mgmtIp }
//   ownMacs     this device's own MAC addresses (so other devices can recognise it)
//   probes      { <probe>: "ok" | error text } — which data sources answered, for the setup checklist
const http = require("http");
const https = require("https");

const NO_SESSION = "00000000000000000000000000000000";
// Wrapper scripts installed on the router (see docs/openwrt-setup.md). They take no arguments,
// so granting exec on them can't be used to change bridge or LLDP settings.
const FDB_CMD = "/usr/libexec/netmap/fdb";
const LLDP_CMD = "/usr/libexec/netmap/lldp";
const SWCONFIG_CMD = "/usr/libexec/netmap/swconfig";

const UBUS_ERRORS = { 1: "invalid command", 2: "invalid argument", 3: "method not found", 4: "not found", 5: "no data", 6: "permission denied (check the ACL)", 7: "timeout", 8: "not supported", 9: "unknown error", 10: "connection failed" };

// uhttpd-mod-ubus serves /ubus. Without it (e.g. a stock OpenWrt 19.07), LuCI relays the same JSON-RPC
// at /cgi-bin/luci/admin/ubus. Try /ubus first and remember which one each device answers on.
const UBUS_PATHS = ["/ubus", "/cgi-bin/luci/admin/ubus"];
const pathFor = new Map(); // "host:port:https" -> path
const key = (dev) => `${dev.host}:${dev.port || ""}:${dev.https ? 1 : 0}`;

async function post(dev, body) {
  const k = key(dev);
  const known = pathFor.get(k);
  if (known) return postTo(dev, known, body);
  let last;
  for (const p of UBUS_PATHS) {
    try { const r = await postTo(dev, p, body); pathFor.set(k, p); return r; }
    catch (e) { last = e; if (!e.notFound) throw e; }
  }
  last.message = "no ubus endpoint: /ubus and LuCI's /cgi-bin/luci/admin/ubus both returned 404 (install uhttpd-mod-ubus)";
  throw last;
}

function postTo(dev, urlPath, body) {
  const lib = dev.https ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      host: dev.host, port: dev.port || (dev.https ? 443 : 80), path: urlPath, method: "POST",
      rejectUnauthorized: !!dev.verify_tls, // OpenWrt ships a self-signed certificate
      // A fresh connection per request: uhttpd answers a 404 without reading the body, which corrupts
      // the next request on a kept-alive connection (seen on 19.07 as a 400 from the LuCI relay).
      agent: false,
      timeout: 8000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          const e = new Error(`${urlPath} returned HTTP ${res.statusCode}`);
          e.notFound = res.statusCode === 404;
          return reject(e);
        }
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`${urlPath}: bad JSON`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

let rpcId = 0;
async function call(dev, session, object, method, args) {
  const r = await post(dev, { jsonrpc: "2.0", id: ++rpcId, method: "call", params: [session, object, method, args || {}] });
  if (r.error) throw new Error(`${object}.${method}: ${r.error.message || "error " + r.error.code}${r.error.code === -32002 ? " (not allowed by the ACL)" : ""}`);
  const [code, data] = r.result || [];
  if (code !== 0) throw new Error(`${object}.${method}: ${UBUS_ERRORS[code] || "ubus error " + code}`);
  return data || {};
}

async function login(dev) {
  try {
    const d = await call(dev, NO_SESSION, "session", "login", { username: dev.username, password: dev.password, timeout: 120 });
    return d.ubus_rpc_session;
  } catch (e) {
    if (/permission denied|ubus error|not allowed/.test(e.message)) throw new Error("login failed: wrong username or password, or no rpcd login entry for this user");
    throw e;
  }
}

const normMac = (m) => (m || "").toLowerCase();
const isUnicast = (m) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m) && !(parseInt(m.slice(0, 2), 16) & 1) && m !== "00:00:00:00:00:00";

// --- parsers for each probe; each takes the raw answer and fills `out` ---

function parseSystem(board, info, out) {
  out.system = {
    hostname: board.hostname || "", model: board.model || "", boardName: board.board_name || "",
    release: board.release ? `${board.release.distribution || "OpenWrt"} ${board.release.version || ""}`.trim() : "",
    kernel: board.kernel || "", uptime: info.uptime || 0,
    load: (info.load || []).map((l) => l / 65536),
    memory: info.memory ? { total: info.memory.total, free: info.memory.free, available: info.memory.available ?? null } : null
  };
}

function parseInterfaces(dump, out) {
  out.interfaces = (dump.interface || []).map((i) => ({
    name: i.interface, up: !!i.up, proto: i.proto || "", device: i.l3_device || i.device || "",
    ipv4: (i["ipv4-address"] || []).map((a) => `${a.address}/${a.mask}`),
    ipv6: (i["ipv6-address"] || []).map((a) => `${a.address}/${a.mask}`),
    uptime: i.uptime || 0
  }));
}

function parseDevices(status, out) {
  const masterOf = {};
  for (const [name, d] of Object.entries(status)) for (const m of d["bridge-members"] || []) masterOf[m] = name;
  out.ports = Object.entries(status).map(([name, d]) => ({
    name, type: d.type || "", up: !!d.up, carrier: d.carrier ?? null,
    speed: d.speed || "", mac: normMac(d.macaddr), bridge: masterOf[name] || null,
    members: d["bridge-members"] || [],
    rxBytes: d.statistics ? d.statistics.rx_bytes : null, txBytes: d.statistics ? d.statistics.tx_bytes : null
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  out.ownMacs = [...new Set(out.ports.map((p) => p.mac).filter(isUnicast))];
}

function parseFdb(list, out) {
  for (const e of Array.isArray(list) ? list : []) {
    const mac = normMac(e.mac);
    const flags = e.flags || [];
    // skip our own addresses (permanent/self) and multicast
    if (!isUnicast(mac) || e.state === "permanent" || flags.includes("self") || !e.master) continue;
    // iproute2 calls the port "ifname"; older versions (OpenWrt 18.06/19.07) call it "dev".
    out.clients.push({ mac, via: "fdb", iface: e.ifname || e.dev || "", detail: { bridge: e.master, vlan: e.vlan ?? null } });
  }
}

// lldpcli -f json output nests oddly: interface is an object for one neighbour, an array for several,
// and chassis is keyed by system name.
function parseLldp(j, out) {
  const ifs = j && j.lldp && j.lldp.interface;
  const list = !ifs ? [] : Array.isArray(ifs) ? ifs : Object.entries(ifs).map(([k, v]) => ({ [k]: v }));
  for (const entry of list) {
    for (const [localPort, v] of Object.entries(entry)) {
      const ch = v.chassis || {};
      const [sysName, c] = ch.id ? ["", ch] : Object.entries(ch)[0] || ["", {}];
      const mgmt = c["mgmt-ip"];
      out.neighbors.push({
        localPort, sysName: sysName || (c.name && c.name.value) || "",
        chassisId: normMac(c.id && c.id.value), chassisIdType: c.id && c.id.type,
        portId: (v.port && v.port.id && v.port.id.value) || "", portDescr: (v.port && v.port.descr) || "",
        mgmtIp: Array.isArray(mgmt) ? mgmt[0] : mgmt || ""
      });
    }
  }
}

// Routers whose jacks sit on a switch chip (swconfig: older TP-Links, Archer C7, ...) show Linux one port for
// all of them. The helper prints `swconfig dev <sw> show`: per port a "link:" line and MIB byte counters, per
// VLAN its member ports ("0t 2 3 4 5", t = tagged). Each jack becomes a port: the CPU port(s) (tagged-only, the
// chip's link to the router itself) are left out; jacks untagged in the WAN interface's VLAN are WAN, the rest LAN.
function parseSwconfig(text, out) {
  const wanVid = (() => {
    const wan = out.interfaces.find((i) => /^wan$/.test(i.name)) || out.interfaces.find((i) => /^wan/.test(i.name));
    const m = wan && String(wan.device).match(/\.(\d+)$/);
    return m ? Number(m[1]) : null;
  })();
  for (const block of String(text).split(/^== switch /m).slice(1)) {
    const sw = block.split("\n")[0].trim();
    const ports = {}, vlans = [];
    const sections = block.split(/^(?=(?:Port|VLAN) \d+:)/m);
    for (const sec of sections) {
      let m = sec.match(/^Port (\d+):/);
      if (m) {
        const n = Number(m[1]);
        const link = sec.match(/link:\s*port:\d+\s+link:(up|down)(?:\s+speed:(\d+)base)?/);
        const num = (re) => { const x = sec.match(re); return x ? Number(x[1]) : null; };
        ports[n] = { n, up: !!(link && link[1] === "up"), speed: link && link[2] ? Number(link[2]) : 0,
          rx: num(/RxGoodByte\s*:\s*(\d+)/), tx: num(/TxByte\s*:\s*(\d+)/) };
        continue;
      }
      m = sec.match(/^VLAN (\d+):/);
      if (m) {
        const vid = Number((sec.match(/vid:\s*(\d+)/) || [])[1] || m[1]);
        const members = ((sec.match(/ports:\s*([^\n]*)/) || [])[1] || "").trim().split(/\s+/).filter(Boolean)
          .map((t) => ({ n: Number(t.replace(/t$/, "")), tagged: /t$/.test(t) }));
        vlans.push({ vid, members });
      }
    }
    const untaggedIn = (n) => vlans.filter((v) => v.members.some((x) => x.n === n && !x.tagged)).map((v) => v.vid);
    const taggedOnly = (n) => vlans.some((v) => v.members.some((x) => x.n === n && x.tagged)) && !untaggedIn(n).length;
    const jacks = Object.values(ports).filter((p) => !taggedOnly(p.n) && untaggedIn(p.n).length).sort((a, b) => a.n - b.n);
    let lan = 0;
    for (const p of jacks) {
      const isWan = wanVid != null && untaggedIn(p.n).includes(wanVid);
      out.ports.push({
        name: isWan ? "wan" : `lan${++lan}`, type: "swport", switch: sw, switchPort: p.n, up: true, carrier: p.up,
        speed: p.speed >= 1000 ? `${p.speed / 1000}G` : p.speed ? `${p.speed}M` : "", mac: "", bridge: null, members: [],
        alias: `${sw} port ${p.n}${untaggedIn(p.n).length ? ", VLAN " + untaggedIn(p.n).join("/") : ""}`, rxBytes: p.rx, txBytes: p.tx
      });
    }
  }
}

function parseLeases(l, out) {
  for (const x of l.dhcp_leases || []) {
    const mac = normMac(x.macaddr);
    if (isUnicast(mac) && (x.hostname || x.ipaddr)) out.names[mac] = { hostname: x.hostname || "", ip: x.ipaddr || "" };
  }
}

// Host hints fill gaps the leases leave (static IPs, /etc/ethers); leases win where both exist.
function parseHints(h, out) {
  for (const [m, v] of Object.entries(h || {})) {
    const mac = normMac(m), cur = out.names[mac] || {};
    // Newer LuCI sends ipaddrs: [..]; 19.07 sends ipv4: "a.b.c.d" (a string, not a list).
    const ips = v.ipaddrs || v.ipv4 || [];
    const hint = { hostname: v.name || "", ip: (Array.isArray(ips) ? ips[0] : ips) || "" };
    if (isUnicast(mac) && (hint.hostname || hint.ip)) out.names[mac] = { hostname: cur.hostname || hint.hostname, ip: cur.ip || hint.ip };
  }
}

function parseArp(text, out) {
  for (const line of String(text).split("\n").slice(1)) {
    const [ip, , flags, mac, , dev] = line.trim().split(/\s+/);
    if (!ip || flags === "0x0") continue; // incomplete entry
    const m = normMac(mac);
    if (isUnicast(m)) out.clients.push({ mac: m, via: "arp", iface: dev || "", ip, detail: null });
  }
}

async function poll(dev) {
  const session = await login(dev);
  const c = (obj, m, a) => call(dev, session, obj, m, a);
  const out = { system: null, interfaces: [], ports: [], wifi: [], clients: [], neighbors: [], ownMacs: [], names: {}, probes: {} };
  const probe = async (name, fn) => {
    try { await fn(); out.probes[name] = "ok"; } catch (e) { out.probes[name] = e.message || String(e); }
  };

  await probe("system", async () => parseSystem(await c("system", "board"), await c("system", "info"), out));
  await probe("interfaces", async () => parseInterfaces(await c("network.interface", "dump"), out));
  await probe("devices", async () => parseDevices(await c("network.device", "status"), out));

  // Wi-Fi: iwinfo (rpcd-mod-iwinfo) lists APs and their associated stations.
  await probe("wifi", async () => {
    const { devices = [] } = await c("iwinfo", "devices");
    for (const ifname of devices) {
      const info = await c("iwinfo", "info", { device: ifname }).catch(() => ({}));
      if (info.mode && !/master|ap/i.test(info.mode)) continue; // skip client/mesh/monitor interfaces
      const { results = [] } = await c("iwinfo", "assoclist", { device: ifname });
      out.wifi.push({ iface: ifname, ssid: info.ssid || "", mode: info.mode || "", channel: info.channel ?? null, frequency: info.frequency ?? null, clients: results.length });
      for (const s of results) {
        out.clients.push({
          mac: normMac(s.mac), via: "wifi", iface: ifname,
          detail: { ssid: info.ssid || "", signal: s.signal ?? null, noise: s.noise ?? null, inactiveMs: s.inactive ?? null,
            rxRate: s.rx && s.rx.rate ? s.rx.rate / 1000 : null, txRate: s.tx && s.tx.rate ? s.tx.rate / 1000 : null }
        });
      }
    }
  });

  // Which MAC is behind which bridge port (tells us what is plugged into lan1, lan2, ... and the uplink).
  await probe("fdb", async () => {
    const r = await c("file", "exec", { command: FDB_CMD });
    if (r.code) throw new Error(`${FDB_CMD} exited ${r.code}: ${(r.stderr || "").trim()}`);
    parseFdb(JSON.parse(r.stdout || "[]"), out);
  });
  // LLDP neighbours: how routers, APs and managed switches are cabled together.
  await probe("lldp", async () => {
    const r = await c("file", "exec", { command: LLDP_CMD });
    if (r.code) throw new Error(`${LLDP_CMD} exited ${r.code}: ${(r.stderr || "").trim()}`);
    parseLldp(JSON.parse(r.stdout || "{}"), out);
  });
  // DHCP leases and host hints only exist on the device that runs dnsmasq (usually the main router);
  // on a dumb AP these come back empty, which is fine.
  // The jacks on a switch chip, on routers that have one (needs the swconfig helper from the setup script).
  let hasSwitch = true;
  await probe("switch", async () => {
    const r = await c("file", "exec", { command: SWCONFIG_CMD });
    if (r.code) throw new Error(`${SWCONFIG_CMD} exited ${r.code}: ${(r.stderr || "").trim()}`);
    if (!/== switch/.test(r.stdout || "")) { hasSwitch = false; return; }
    parseSwconfig(r.stdout, out);
  });
  if (!hasSwitch) delete out.probes.switch; // no switch chip on this one: nothing to list
  await probe("dhcp", async () => parseLeases(await c("luci-rpc", "getDHCPLeases"), out));
  await probe("hosts", async () => parseHints(await c("luci-rpc", "getHostHints"), out));
  await probe("arp", async () => parseArp((await c("file", "read", { path: "/proc/net/arp" })).data, out));

  // Fill names and IPs from leases and hints, and drop our own MACs.
  const own = new Set(out.ownMacs);
  out.clients = out.clients.filter((x) => !own.has(x.mac)).map((x) => {
    const h = out.names[x.mac];
    return { ...x, ip: x.ip || (h && h.ip) || "", hostname: x.hostname || (h && h.hostname) || "" };
  });
  if (out.probes.system !== "ok" && out.probes.devices !== "ok") throw new Error(`no data: ${out.probes.system}`);
  return out;
}

// Forget the remembered endpoint (after setup installs uhttpd-mod-ubus, /ubus becomes available).
const resetEndpoint = (dev) => pathFor.delete(key(dev));

module.exports = { poll, call, login, resetEndpoint, parseSwconfig, FDB_CMD, LLDP_CMD, SWCONFIG_CMD };
