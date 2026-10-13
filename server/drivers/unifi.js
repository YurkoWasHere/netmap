// UniFi driver: one netmap device per UniFi device (AP, switch, gateway), read from the UniFi Network controller.
// Logs in with a local controller account (a View Only admin is enough) and only makes GET requests after that.
// The device row: host/port = the controller (default 8443, HTTPS; a UniFi OS console such as a UDM or Cloud Key
// Gen2 answers on 443), username/password, node = "<site>/<device MAC>". Controller-wide reads are shared between
// the devices of one controller for a short while.
//
// Returns the normalised shape (see drivers/openwrt.js), plus:
//   ownIps     the device's IP, as the controller knows it
//   poe        PoE switches: { budgetW, usedW, on }
// Clients: Wi-Fi clients on the AP they're associated with (SSID, signal), wired clients on the switch port the
// controller last saw them on. Cabling between UniFi devices comes from the controller's uplink records and goes
// out as LLDP-style neighbours on the upstream device.
const https = require("https");

const LOGIN_MS = 60 * 60 * 1000;  // sessions last much longer; log in again hourly anyway
const SHARED_MS = 20 * 1000;      // controller-wide reads shared between the devices of one controller

const sessions = new Map(); // host|port|user -> { cookie, csrf, prefix, at }
const shared = new Map();   // host|port|user|route -> { at, data }

const normMac = (m) => String(m || "").toLowerCase();
const speedText = (mbps) => (!mbps ? "" : mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);
const KIND = { uap: "ap", usw: "switch", ugw: "gateway", udm: "gateway", uxg: "gateway" };

function request(dev, method, path, { body, cookie, csrf } = {}) {
  const payload = body ? JSON.stringify(body) : null;
  const port = dev.port || 8443;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: dev.host, port, path, method,
      rejectUnauthorized: !!dev.verify_tls, // controllers ship a self-signed certificate
      timeout: 10000, agent: false,
      headers: Object.assign({ Accept: "application/json" },
        cookie ? { Cookie: cookie } : {}, csrf ? { "X-Csrf-Token": csrf } : {},
        payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => reject(e.code === "ECONNREFUSED" ? new Error(`nothing answering on ${dev.host}:${port}`) : e));
    req.end(payload);
  });
}

const cookiesOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");

// Classic controller (self-hosted, port 8443): POST /api/login, API under /api.
// UniFi OS console (UDM, Cloud Key Gen2+, port 443): POST /api/auth/login, API under /proxy/network/api.
async function login(dev) {
  const creds = { username: dev.username, password: dev.password, remember: false };
  let res = await request(dev, "POST", "/api/login", { body: creds });
  let prefix = "";
  if (res.status === 404) {
    res = await request(dev, "POST", "/api/auth/login", { body: creds });
    prefix = "/proxy/network";
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    let msg = "";
    try { msg = (JSON.parse(res.body).meta || {}).msg || ""; } catch (e) { /* not JSON */ }
    throw new Error(`login failed: wrong user or password${/2fa|mfa|ubic/i.test(msg) ? " (two-factor is on: use a local account without it)" : " (use a local controller account, not a UI.com login)"}`);
  }
  if (res.status !== 200) throw new Error(`login returned HTTP ${res.status}: is this a UniFi Network controller?`);
  return { cookie: cookiesOf(res), csrf: res.headers["x-csrf-token"] || res.headers["x-updated-csrf-token"] || "", prefix, at: Date.now() };
}

async function session(dev) {
  const key = `${dev.host}|${dev.port || 8443}|${dev.username}`;
  let s = sessions.get(key);
  if (!s || Date.now() - s.at > LOGIN_MS) { s = await login(dev); sessions.set(key, s); }
  const get = async (route, retried) => {
    const res = await request(dev, "GET", s.prefix + "/api" + route, { cookie: s.cookie, csrf: s.csrf });
    // an expired session can come back as 401 or 403: log in again once before believing either
    if ((res.status === 401 || res.status === 403) && !retried) { s = await login(dev); sessions.set(key, s); return get(route, true); }
    if (res.status === 401) throw new Error("login failed: the controller doesn't accept the session");
    if (res.status === 403) throw new Error(`${route}: permission denied (give the account at least View Only on this site)`);
    if (res.status !== 200) throw new Error(`${route} returned HTTP ${res.status}`);
    try { return JSON.parse(res.body).data || []; } catch (e) { throw new Error(`${route}: bad JSON`); }
  };
  const getShared = async (route) => {
    const k = key + "|" + route;
    const hit = shared.get(k);
    if (hit && Date.now() - hit.at < SHARED_MS) return hit.data;
    const data = await get(route);
    shared.set(k, { at: Date.now(), data });
    return data;
  };
  return { get, getShared };
}

// "default/aa:bb:cc:dd:ee:ff" -> { site, mac }
function parseNode(node) {
  const s = String(node || "");
  const i = s.lastIndexOf("/");
  return i < 0 ? { site: "default", mac: normMac(s) } : { site: s.slice(0, i) || "default", mac: normMac(s.slice(i + 1)) };
}

// Every device on every site the account can see, for the add form.
async function listDevices(dev) {
  const s = await session(dev);
  const sites = await s.get("/self/sites");
  const out = [];
  for (const site of sites) {
    let devs = [];
    try { devs = await s.get(`/s/${encodeURIComponent(site.name)}/stat/device`); } catch (e) { continue; }
    for (const d of devs) {
      out.push({ node: `${site.name}/${normMac(d.mac)}`, site: site.name, siteName: site.desc || site.name, mac: normMac(d.mac),
        name: d.name || d.model || normMac(d.mac), model: d.model || "", type: KIND[d.type] || d.type || "", ip: d.ip || "", online: d.state === 1 });
    }
  }
  return { version: (await s.get("/s/default/stat/sysinfo").catch(() => [{}]))[0].version || "", devices: out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) };
}

async function poll(dev) {
  const { site, mac } = parseNode(dev.node);
  if (!mac) throw new Error("no UniFi device chosen for this netmap device");
  const out = { system: null, interfaces: [], ports: [], wifi: [], clients: [], neighbors: [], ownMacs: [], ownIps: [], names: {}, probes: {} };
  const probe = async (name, fn) => {
    try { await fn(); out.probes[name] = "ok"; } catch (e) { out.probes[name] = e.message || String(e); }
  };
  const s = await session(dev); // login errors fail the poll
  const base = `/s/${encodeURIComponent(site)}`;

  const devices = await s.getShared(`${base}/stat/device`);
  const d = devices.find((x) => normMac(x.mac) === mac);
  if (!d) throw new Error(`the controller has no device ${mac} on site ${site}`);
  if (d.state !== 1) throw new Error(`the controller says ${d.name || mac} isn't connected (state ${d.state})`);

  await probe("system", async () => {
    const st = d.sys_stats || {};
    out.system = {
      hostname: d.name || mac, model: `UniFi ${d.model || d.type || ""}`.trim(), kind: KIND[d.type] || "",
      release: d.version ? `UniFi ${d.version}` : "", kernel: "", uptime: d.uptime || 0,
      load: [st.loadavg_1, st.loadavg_5, st.loadavg_15].filter((x) => x != null).map(Number),
      memory: st.mem_total ? { total: st.mem_total, free: st.mem_total - (st.mem_used || 0), available: null } : null
    };
    out.ownMacs.push(mac);
    if (d.ip) out.ownIps.push(d.ip);
    if (d.ip) out.interfaces.push({ name: "mgmt", up: true, proto: d.config_network && d.config_network.type === "static" ? "static" : "dhcp", device: "", ipv4: [`${d.ip}/${netmaskBits(d.netmask)}`], ipv6: [], uptime: 0 });
  });

  await probe("ports", async () => {
    let usedW = 0, delivering = false;
    out.ports = (d.port_table || []).map((p) => {
      const name = String(p.port_idx ?? p.name);
      const port = {
        name, ifIndex: p.port_idx || 0, type: "port", up: p.enable !== false, carrier: !!p.up, speed: p.up ? speedText(p.speed) : "",
        mac: normMac(p.mac), bridge: null, alias: p.name && !/^port \d+$/i.test(p.name) ? p.name : "",
        rxBytes: p.rx_bytes ?? null, txBytes: p.tx_bytes ?? null, uplink: !!p.is_uplink
      };
      if (p.port_poe) {
        const w = Number(p.poe_power) || 0;
        const on = p.poe_enable && (p.poe_good || w > 0);
        if (on) { usedW += w; delivering = true; }
        port.poe = { status: on ? "delivering" : "searching", cls: p.poe_class != null ? String(p.poe_class).replace(/^Class\s*/i, "") : null,
          volts: p.poe_voltage != null ? Number(p.poe_voltage) : null, mA: p.poe_current != null ? Number(p.poe_current) : null, mW: Math.round(w * 1000) };
      }
      if (port.mac) out.ownMacs.push(port.mac);
      return port;
    }).sort((a, b) => a.ifIndex - b.ifIndex);
    if ((d.port_table || []).some((p) => p.port_poe)) out.poe = { budgetW: d.total_max_power != null ? Number(d.total_max_power) : null, usedW: Math.round(usedW * 10) / 10, on: delivering };
  });

  await probe("wifi", async () => {
    out.wifi = (d.vap_table || []).filter((v) => v.up !== false).map((v) => ({
      iface: v.name || `${v.radio}:${v.essid}`, ssid: v.essid || "", mode: "ap", channel: v.channel ?? null, frequency: null, clients: v.num_sta || 0
    }));
  });

  // Clients: names for all of them; the ones on this AP or this switch become sightings.
  await probe("clients", async () => {
    const sta = await s.getShared(`${base}/stat/sta`);
    const vapOf = (c) => (d.vap_table || []).find((v) => v.essid === c.essid && (!c.radio || v.radio === c.radio));
    for (const c of sta) {
      const cmac = normMac(c.mac);
      const hostname = c.name || c.hostname || "";
      if (hostname || c.ip) out.names[cmac] = { hostname, ip: c.ip || "" };
      if (!c.is_wired && normMac(c.ap_mac) === mac) {
        const v = vapOf(c);
        out.clients.push({ mac: cmac, via: "wifi", iface: v ? v.name || `${v.radio}:${v.essid}` : c.essid || "wifi", ip: c.ip || "", hostname,
          detail: { ssid: c.essid || "", signal: c.signal ?? c.rssi ?? null, channel: c.channel ?? null, radio: c.radio || "", rxRate: c.rx_rate ?? null, txRate: c.tx_rate ?? null } });
      } else if (c.is_wired && normMac(c.sw_mac) === mac && c.sw_port != null) {
        out.clients.push({ mac: cmac, via: "fdb", iface: String(c.sw_port), ip: c.ip || "", hostname, detail: { vlan: c.vlan ?? null, source: "unifi" } });
      }
    }
  });

  // Cabling: UniFi devices whose uplink is this device, and whatever this device hears over LLDP.
  await probe("uplinks", async () => {
    for (const o of devices) {
      const u = o.uplink || o.last_uplink || {};
      if (normMac(o.mac) === mac || normMac(u.uplink_mac) !== mac || u.uplink_remote_port == null) continue;
      out.neighbors.push({ localPort: String(u.uplink_remote_port), chassisId: normMac(o.mac), sysName: o.name || "",
        portId: u.port_idx != null ? String(u.port_idx) : "", portDescr: u.port_idx != null ? String(u.port_idx) : "", mgmtIp: o.ip || "" });
    }
    for (const n of d.lldp_table || []) {
      if (n.local_port_idx == null || devices.some((o) => normMac(o.mac) === normMac(n.chassis_id))) continue;
      out.neighbors.push({ localPort: String(n.local_port_idx), chassisId: normMac(n.chassis_id), sysName: n.chassis_descr || n.chassis_name || "",
        portId: n.port_id || "", portDescr: n.port_descr || n.port_id || "", mgmtIp: n.mgmt_ip || "" });
    }
  });

  if (!out.system) throw new Error(out.probes.system);
  return out;
}

function netmaskBits(mask) {
  if (!mask) return 24;
  return String(mask).split(".").reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length, 0);
}

module.exports = { poll, listDevices, parseNode };
