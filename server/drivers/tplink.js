// TP-Link "Easy Smart" switches (TL-SG105E, TL-SG108E, TL-SG116E, ... on the 1.0.0 web firmware): no SNMP or
// API, so this reads the web interface's pages. Each page carries its data as a JavaScript object
// (`var all_info = { state:[...], ... }`), which is parsed as data, never run.
// Logins are per client IP, but Logout.htm ends EVERY session on the switch (yours in a browser too), and nothing
// shows whether someone else is logged in. So netmap never logs out: each poll first reads with the session it
// already has and only logs in when that has expired (or someone's logout ended it).
//
// Returns the normalised shape (see drivers/openwrt.js). What these switches can't give:
//   no LLDP, and on stock firmware no MAC address table: clients behind the switch are then placed by the
//   "behind it" rule (noMacTable: true), like an unmanaged switch. Switches patched with a MacTableRpm.htm page
//   expose the ASIC's address table as /MacTable00.dat .. /MacTable40.dat (65 blocks of 64 slots); those are
//   read and decoded the way that page does it, and clients land on their real sockets.
//   packet counters only, no byte counters: ports carry rxPkts/txPkts and rates.js turns them into packets/s
const http = require("http");

// spd_act / link_status codes on the Port Setting and Port Statistics pages
const SPEED = { 0: "", 1: "auto", 2: "10M half", 3: "10M", 4: "100M half", 5: "100M", 6: "1G", 7: "10G" };

function request(dev, method, path, body) {
  const payload = body ? new URLSearchParams(body).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: dev.host, port: dev.port || 80, path, method, timeout: 8000, agent: false,
      headers: Object.assign({ Referer: `http://${dev.host}/` }, payload ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) } : {})
    }, (res) => {
      let buf = "";
      res.setEncoding("latin1");
      res.on("data", (c) => (buf += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(buf) : reject(new Error(`${path} returned HTTP ${res.statusCode}`))));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    // the firmware drops the connection for pages it doesn't have
    req.on("error", (e) => reject(e.code === "ECONNRESET" ? new Error(`${path}: not on this switch`) : e.code === "ECONNREFUSED" ? new Error(`nothing answering on ${dev.host}`) : e));
    req.end(payload);
  });
}

// `var name = { a:[1,"x"], b:0x1f };` -> object. Quotes the keys and converts hex, then JSON.parse: no eval.
function readVar(html, name) {
  const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`));
  if (!m) return null;
  const json = m[1]
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    .replace(/\b0x([0-9a-fA-F]+)\b/g, (_, h) => String(parseInt(h, 16)))
    .replace(/,\s*([\]}])/g, "$1");
  try { return JSON.parse(json); } catch (e) { throw new Error(`couldn't read ${name} from the page`); }
}
const readNum = (html, name) => { const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*(\\d+)`)); return m ? Number(m[1]) : null; };

async function poll(dev) {
  const out = { system: null, interfaces: [], ports: [], wifi: [], clients: [], neighbors: [], ownMacs: [], ownIps: [], names: {}, noMacTable: true, probes: {} };
  const probe = async (name, fn) => {
    try { await fn(); out.probes[name] = "ok"; } catch (e) { out.probes[name] = e.message || String(e); }
  };

  // reuse this host's session if it's still open; log in only when it isn't
  let sys = await request(dev, "GET", "/SystemInfoRpm.htm");
  if (!/info_ds/.test(sys)) {
    await request(dev, "POST", "/logon.cgi", { username: dev.username || "admin", password: dev.password || "", cpassword: "", logon: "Login" });
    sys = await request(dev, "GET", "/SystemInfoRpm.htm");
  }
  {
    if (!/info_ds/.test(sys)) throw new Error("login failed: wrong user or password");
    await probe("system", async () => {
      const i = readVar(sys, "info_ds");
      const first = (k) => (i && i[k] && i[k][0]) || "";
      out.system = { hostname: first("descriStr"), model: `TP-Link ${first("hardwareStr")}`.trim(), release: first("firmwareStr"), uptime: 0, load: [], memory: null };
      const mac = first("macStr").toLowerCase();
      if (mac) out.ownMacs.push(mac);
      const ip = first("ipStr");
      if (ip) {
        out.ownIps.push(ip);
        const bits = first("netmaskStr").split(".").reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length, 0) || 24;
        out.interfaces.push({ name: "management", up: true, proto: "static", device: "", ipv4: [`${ip}/${bits}`], ipv6: [], uptime: 0, gateway: first("gatewayStr") });
      }
    });

    let count = 0, link = [], enabled = [];
    await probe("ports", async () => {
      const html = await request(dev, "GET", "/PortSettingRpm.htm");
      const a = readVar(html, "all_info");
      count = readNum(html, "max_port_num") || (a.state || []).filter((x, i) => i < 64).length;
      enabled = a.state || []; link = a.spd_act || [];
    });
    let pkts = [];
    await probe("traffic", async () => {
      const html = await request(dev, "GET", "/PortStatisticsRpm.htm");
      const a = readVar(html, "all_info");
      count = count || readNum(html, "max_port_num") || 0;
      if (!link.length) link = a.link_status || [];
      if (!enabled.length) enabled = a.state || [];
      pkts = a.pkts || []; // per port: tx good, tx bad, rx good, rx bad
    });
    for (let i = 0; i < count; i++) {
      const sp = Number(link[i]) || 0;
      out.ports.push({
        name: String(i + 1), type: "port", up: Number(enabled[i]) === 1, carrier: sp > 0, speed: SPEED[sp] || "", mac: "", bridge: null, members: [], alias: "",
        txPkts: pkts.length ? Number(pkts[i * 4]) : null, rxPkts: pkts.length ? Number(pkts[i * 4 + 2]) : null,
        errors: pkts.length ? Number(pkts[i * 4 + 1]) + Number(pkts[i * 4 + 3]) : null
      });
    }

    // Patched firmware only: the MAC address table. ASIC port n is front socket n + 1 (checked on a TL-SG108E
    // v5: every learned MAC sat on a socket with link); ports past the last socket are the CPU.
    let hasTable = false;
    await probe("mactable", async () => {
      const entries = await readMacTable(dev);
      if (!entries) return;
      hasTable = true;
      out.noMacTable = false;
      for (const e of entries) {
        const socket = e.asicPort + 1;
        if (socket > count || e.static) continue; // the switch's own (CPU) and static entries
        out.clients.push({ mac: e.mac, via: "fdb", iface: String(socket), detail: { vlan: e.vlan, asicPort: e.asicPort } });
      }
    });
    if (!hasTable) delete out.probes.mactable; // stock firmware: nothing to report

    await probe("vlans", async () => {
      const q = readVar(await request(dev, "GET", "/Vlan8021QRpm.htm"), "qvlan_ds");
      out.vlans = q && q.state ? (q.vids || []).map((id, k) => ({ id, name: (q.names || [])[k] || "", tagged: q.tagMbrs ? q.tagMbrs[k] : 0, untagged: q.untagMbrs ? q.untagMbrs[k] : 0 })) : [];
    });
  }
  if (out.probes.system !== "ok" && out.probes.ports !== "ok") throw new Error(out.probes.system || out.probes.ports);
  return out;
}

// One line of a MacTableNN.dat block: "slot status w0 .. w5" in hex (8 x 4 digits). Decoded as the patched
// MacTableRpm.htm page does; returns null for empty, invalid, multicast and aged-out slots.
function decodeMacLine(line) {
  if (!/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/.test(line)) throw new Error("unexpected MAC table line");
  const [, status, ...w] = line.split(" ").map((x) => parseInt(x, 16));
  const mac = [w[2] >> 8, w[2] & 255, w[1] >> 8, w[1] & 255, w[0] >> 8, w[0] & 255];
  const age = (w[4] >> 11) & 7, fixed = !!(w[5] & 32);
  if (!(status & 0x1000) || mac[0] & 1 || w[3] & 0x1000 || (!age && !fixed) || mac.every((x) => x === 0)) return null;
  return {
    mac: mac.map((x) => x.toString(16).padStart(2, "0")).join(":"),
    asicPort: ((w[4] >> 8) & 7) | (w[3] & 0x8000 ? 8 : 0),
    vlan: w[3] & 0x2000 ? w[3] & 4095 : (w[4] >> 3) & 15,
    static: fixed
  };
}

// The whole table, or null when the switch doesn't have the patched page.
async function readMacTable(dev) {
  const page = await request(dev, "GET", "/MacTableRpm.htm").catch(() => null);
  if (!page || !/MacTable/.test(page)) return null;
  const entries = [];
  for (let block = 0; block < 65; block++) {
    const lines = (await request(dev, "GET", `/MacTable${block.toString(16).padStart(2, "0")}.dat`)).trim().split("\n");
    if (lines[0] !== "MACT1" || lines[lines.length - 1] !== "END" || lines.length !== 66) throw new Error(`MAC table block ${block} incomplete`);
    for (const l of lines.slice(1, -1)) { const e = decodeMacLine(l); if (e) entries.push(e); }
  }
  return entries;
}

module.exports = { poll, readVar, decodeMacLine };
