// Realtek-based web-managed 2.5G switches (SL-SWTGW218AS and the same firmware sold as Sodola, Keeplink, Horaco,
// ...: 8 x 2.5G + 1 x 10G SFP+, web pages ending in .cgi). No SNMP, so this reads the web pages' HTML tables.
//
// Login (login.cgi): cookie admin=md5(username + password), then POST login.cgi with username, password,
// language, Response=<same md5>. The switch then accepts that cookie; a page asked for without a valid login
// answers with a script that sends the browser to /login.cgi, which is when this logs in again.
// Read-only: the login is the only thing ever POSTed (never save/reset/reboot/logout).
//
//   port.cgi                Port | State | Speed/Duplex (set) | Speed/Duplex (actual, "2500Full" / "Link Down") | Flow (set) | Flow (actual)
//   port.cgi?page=stats     Port | State | Link Status | TxGoodPkt | TxBadPkt | RxGoodPkt | RxBadPkt
//   mac.cgi?page=fwd_tbl    No. | MAC Address | VLAN ID | Type | Port
//   info.cgi                Device Model, MAC Address, IP Address, Netmask, Gateway, Firmware Version, ...
const http = require("http");
const crypto = require("crypto");

const loggedIn = new Set(); // "host:port" that have logged in since this server started

function request(dev, method, path, body) {
  const hash = crypto.createHash("md5").update(String(dev.username || "admin") + String(dev.password || "")).digest("hex");
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: dev.host, port: dev.port || 80, path, method, timeout: 10000, agent: false,
      headers: { Cookie: `admin=${hash}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}) }
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(buf) : reject(new Error(`${path.split("?")[0]} returned HTTP ${res.statusCode}`))));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => reject(e.code === "ECONNREFUSED" ? new Error(`nothing answering on ${dev.host}`) : e));
    req.end(body || null);
  });
}

const toLogin = (html) => /location\.replace\(\s*["']\/login\.cgi/.test(html) || /name\s*=\s*"?login"?[^>]*action="login\.cgi"/.test(html);

async function login(dev) {
  const user = String(dev.username || "admin"), pass = String(dev.password || "");
  const hash = crypto.createHash("md5").update(user + pass).digest("hex");
  const body = new URLSearchParams({ username: user, password: pass, language: "EN", Response: hash }).toString();
  await request(dev, "POST", "/login.cgi", body);
}

// A page, logging in first when the switch sends us to its login page.
async function page(dev, path) {
  const key = `${dev.host}:${dev.port || 80}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!loggedIn.has(key)) { await login(dev); loggedIn.add(key); }
    const html = await request(dev, "GET", path);
    if (!toLogin(html)) return html;
    loggedIn.delete(key);
  }
  throw new Error("login failed: wrong user or password");
}

// Every <tr> of the page as a list of its cells' text (older firmware closes cells as </td align="center">).
function rows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd][^>]*>/gi)].map((c) => c[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()));
}

// "2500Full" -> "2.5G", "1000Full" -> "1G", "100Half" -> "100M half", "10GFull" -> "10G"
function speedText(s) {
  const m = String(s).match(/^(\d+)(G?)\s*(Full|Half)/i);
  if (!m) return "";
  const mbps = m[2] ? Number(m[1]) * 1000 : Number(m[1]);
  const t = mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`;
  return /half/i.test(m[3]) ? `${t} half` : t;
}

async function poll(dev) {
  const out = { system: null, interfaces: [], ports: [], wifi: [], clients: [], neighbors: [], ownMacs: [], ownIps: [], names: {}, probes: {} };
  const probe = async (name, fn) => {
    try { await fn(); out.probes[name] = "ok"; } catch (e) { out.probes[name] = e.message || String(e); }
  };

  await probe("system", async () => {
    const info = {};
    for (const r of rows(await page(dev, "/info.cgi"))) if (r.length === 2) info[r[0]] = r[1];
    if (!info["Device Model"]) throw new Error("no System Information on info.cgi (is this one of these switches?)");
    out.system = { hostname: "", model: info["Device Model"], release: info["Firmware Version"] || "", uptime: 0, load: [], memory: null,
      hardware: info["Hardware Version"] || "" };
    const mac = String(info["MAC Address"] || "").toLowerCase();
    if (mac) out.ownMacs.push(mac);
    if (info["IP Address"]) {
      out.ownIps.push(info["IP Address"]);
      const bits = String(info["Netmask"] || "255.255.255.0").split(".").reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length, 0);
      out.interfaces.push({ name: "management", up: true, proto: "static", device: "", ipv4: [`${info["IP Address"]}/${bits}`], ipv6: [], uptime: 0, gateway: info["Gateway"] || "" });
    }
  });

  const byPort = {};
  await probe("ports", async () => {
    // the status rows: "Port 9" | Enable | Auto | 2500Full | Off | Off (the form's option lists come first and have newlines)
    for (const r of rows(await page(dev, "/port.cgi"))) {
      const m = r[0] && r[0].match(/^Port (\d+)$/);
      if (!m || r.length < 4) continue;
      const linked = !/down/i.test(r[3]);
      byPort[m[1]] = { name: m[1], ifIndex: Number(m[1]), type: "port", up: /enable/i.test(r[1]), carrier: linked, speed: linked ? speedText(r[3]) : "",
        mac: "", bridge: null, members: [], alias: "", txPkts: null, rxPkts: null, errors: null };
    }
    if (!Object.keys(byPort).length) throw new Error("no ports on port.cgi");
  });
  await probe("traffic", async () => {
    for (const r of rows(await page(dev, "/port.cgi?page=stats"))) {
      const m = r[0] && r[0].match(/^Port (\d+)$/);
      if (!m || r.length < 7) continue;
      const p = byPort[m[1]] || (byPort[m[1]] = { name: m[1], ifIndex: Number(m[1]), type: "port", up: /enable/i.test(r[1]), carrier: /up/i.test(r[2]), speed: "", mac: "", bridge: null, members: [], alias: "" });
      p.txPkts = Number(r[3]); p.rxPkts = Number(r[5]); p.errors = Number(r[4]) + Number(r[6]);
    }
  });
  out.ports = Object.values(byPort).sort((a, b) => a.ifIndex - b.ifIndex);

  await probe("fdb", async () => {
    const own = new Set(out.ownMacs);
    for (const r of rows(await page(dev, "/mac.cgi?page=fwd_tbl"))) {
      if (r.length < 5 || !/^\d+$/.test(r[0])) continue;
      const mac = r[1].toLowerCase(), port = r[4];
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || parseInt(mac.slice(0, 2), 16) & 1 || own.has(mac) || !byPort[port]) continue;
      out.clients.push({ mac, via: "fdb", iface: port, detail: { vlan: Number(r[2]) || null, type: r[3] } });
    }
  });

  if (out.probes.system !== "ok" && out.probes.ports !== "ok") throw new Error(out.probes.system || out.probes.ports);
  return out;
}

module.exports = { poll, rows, speedText };
