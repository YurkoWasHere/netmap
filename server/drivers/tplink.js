// TP-Link "Easy Smart" switches (TL-SG105E, TL-SG108E, TL-SG116E, ... on the 1.0.0 web firmware): no SNMP or
// API, so this reads the web interface's pages. Each page carries its data as a JavaScript object
// (`var all_info = { state:[...], ... }`), which is parsed as data, never run.
// Logins are per client IP, but Logout.htm ends EVERY session on the switch (yours in a browser too), and nothing
// shows whether someone else is logged in. So netmap never logs out: each poll first reads with the session it
// already has and only logs in when that has expired (or someone's logout ended it).
//
// Returns the normalised shape (see drivers/openwrt.js). What these switches can't give:
//   no MAC address table and no LLDP: clients behind the switch are placed by the "behind it" rule
//   (noMacTable: true), like an unmanaged switch
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

    await probe("vlans", async () => {
      const q = readVar(await request(dev, "GET", "/Vlan8021QRpm.htm"), "qvlan_ds");
      out.vlans = q && q.state ? (q.vids || []).map((id, k) => ({ id, name: (q.names || [])[k] || "", tagged: q.tagMbrs ? q.tagMbrs[k] : 0, untagged: q.untagMbrs ? q.untagMbrs[k] : 0 })) : [];
    });
  }
  if (out.probes.system !== "ok" && out.probes.ports !== "ok") throw new Error(out.probes.system || out.probes.ports);
  return out;
}

module.exports = { poll, readVar };
