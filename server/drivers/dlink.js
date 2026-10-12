// D-Link "Easy Smart" switches (DGS-1100 series on the 1.x web firmware, e.g. DGS-1100-08P 1.10.027): no SNMP
// on these, so this reads the web interface. Each page loads its data from a small file under
// /<model>_<firmware>/DS/ (e.g. DS/Port.js: `var ds_PortSetting=[[0,1,0],...];`), which is parsed as data, never run.
//
// Login (login2.htm): POST /cgi/login.cgi with pass=md5(password); the answer sets the cookies SessID and Gambit
// with a script. Without a valid session a data file comes back as a redirect to the login page instead, so the
// session is kept between polls and renewed only then. Read-only: the login is the only thing ever POSTed.
//
//   DS/Switch.js      g_DeviceInfo [hw rev, serial, MAC], ds_IPInfo [, ip, mask, gw], ds_SysInfo [name, location, ],
//                     ds_TimeUp [days, h, m, s]
//   DS/Port.js        ds_PortSetting per port [state, speed setting, flow control]; state 0 down, 1 error-disabled,
//                     2 10M half, 3 10M full, 4 100M half, 5 100M full, 6/7 1000M full
//   DS/Statistics.js  ds_Statistics per port ['01', TxOK, RxOK, TxError, RxError] (packets)
//   DS/DFT.js         ds_DFT the dynamic MAC table [port, 'AA-BB-..', vid, type]; paged (ds_TotalPage)
//   DS/PoE.js         ds_PoeSysPow budget and ds_PoeUsedPower used, in 0.1 W
//   DS/PoEPort.js     ds_PoEPort per port [state, priority, limit, power 0.1 W, voltage x 64.45 mV, current mA,
//                     class (0 = class 0 / n/a, 1..3 = class 1..3, larger = 0.1 W), status, detected]
const http = require("http");
const crypto = require("crypto");

const sessions = new Map(); // "host:port" -> { cookie, root }
const SPEED = { 2: "10M half", 3: "10M", 4: "100M half", 5: "100M", 6: "1G", 7: "1G" };
// ds_PoEPort[7], as the page labels it: POWER ON, POWER OFF, Time based OFF, Short, Overload, Power denied,
// Thermal shutdown, POWER OFF, POWER OFF. "Off" on an enabled port means nothing powered is plugged in.
const POE_STATUS = ["delivering", "searching", "disabled", "fault", "fault", "denied", "fault", "searching", "searching"];

function request(dev, method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: dev.host, port: dev.port || 80, path, method, timeout: 8000, agent: false,
      headers: { ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}) }
    }, (res) => {
      let buf = "";
      res.setEncoding("latin1");
      res.on("data", (c) => (buf += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(buf) : reject(new Error(`${path.split("?")[0]} returned HTTP ${res.statusCode}`))));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => reject(e.code === "ECONNREFUSED" ? new Error(`nothing answering on ${dev.host}`) : e));
    req.end(body || null);
  });
}

// `var ds_X=[[0,'a'],[1,'b']];` -> array (single-quoted strings become JSON strings); `var ds_N=640;` -> number
function readVar(js, name) {
  const m = js.match(new RegExp(`var\\s+${name}\\s*=\\s*([\\s\\S]*?);\\s*(?:\\n|$)`));
  if (!m) return undefined;
  const src = m[1].trim()
    .replace(/'([^'\\]*)'/g, (_, s) => JSON.stringify(s))
    .replace(/,\s*([\]}])/g, "$1");
  try { return JSON.parse(src); } catch { throw new Error(`couldn't read ${name}`); }
}

async function login(dev) {
  const key = `${dev.host}:${dev.port || 80}`;
  // the start page names the data folder: <script>RT='/DGS-1100-08P_1.10.027/';</script>
  const start = await request(dev, "GET", "/");
  const root = (start.match(/RT='([^']+)'/) || [])[1];
  if (!root) throw new Error("not a D-Link Easy Smart web interface (no RT folder on the start page)");
  const pass = crypto.createHash("md5").update(String(dev.password || "")).digest("hex");
  const r = await request(dev, "POST", "/cgi/login.cgi", { body: `pass=${pass}`, cookie: "Gambit=login" });
  const sess = (r.match(/SessID=([^;']*)/) || [])[1], gambit = (r.match(/Gambit=([^;']*)/) || [])[1];
  if (!sess || !gambit) throw new Error("login failed: wrong password");
  const s = { cookie: `SessID=${sess}; Gambit=${gambit}`, root };
  sessions.set(key, s);
  return s;
}

// One DS file with the session, logging in again when the switch answers with its login redirect.
async function ds(dev, file) {
  const key = `${dev.host}:${dev.port || 80}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = sessions.get(key) || (await login(dev));
    const js = await request(dev, "GET", `${s.root}DS/${file}`, { cookie: s.cookie });
    if (/var\s+\w+\s*=/.test(js)) return js;
    sessions.delete(key);
  }
  throw new Error(`login failed: the switch keeps refusing the session for ${file}`);
}

const dashMac = (m) => String(m || "").toLowerCase().replace(/-/g, ":");

async function poll(dev) {
  const out = { system: null, interfaces: [], ports: [], wifi: [], clients: [], neighbors: [], ownMacs: [], ownIps: [], names: {}, probes: {} };
  const probe = async (name, fn) => {
    try { await fn(); out.probes[name] = "ok"; } catch (e) { out.probes[name] = e.message || String(e); }
  };

  await probe("system", async () => {
    const js = await ds(dev, "Switch.js");
    const info = readVar(js, "g_DeviceInfo") || [], ip = readVar(js, "ds_IPInfo") || [], sys = readVar(js, "ds_SysInfo") || [], up = readVar(js, "ds_TimeUp") || [];
    const s = sessions.get(`${dev.host}:${dev.port || 80}`);
    const [, model, fw] = (s.root.match(/^\/([^_]+)_([^/]+)\//) || []);
    out.system = { hostname: sys[0] || "", model: `D-Link ${model || ""}`.trim(), release: fw || "", uptime: up.length ? ((up[0] * 24 + up[1]) * 60 + up[2]) * 60 + up[3] : 0, load: [], memory: null, location: sys[1] || "" };
    const mac = dashMac(info[2]);
    if (mac) out.ownMacs.push(mac);
    if (ip[1]) {
      out.ownIps.push(ip[1]);
      const bits = String(ip[2] || "255.255.255.0").split(".").reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length, 0);
      out.interfaces.push({ name: "management", up: true, proto: ip[0] ? "dhcp" : "static", device: "", ipv4: [`${ip[1]}/${bits}`], ipv6: [], uptime: 0, gateway: ip[3] || "" });
    }
  });

  let states = [];
  await probe("ports", async () => {
    states = readVar(await ds(dev, "Port.js"), "ds_PortSetting") || [];
    if (!states.length) throw new Error("no ports on the Port Settings page");
  });
  let stats = [];
  await probe("traffic", async () => { stats = readVar(await ds(dev, "Statistics.js"), "ds_Statistics") || []; });
  const n = states.length || stats.length;
  for (let i = 0; i < n; i++) {
    const st = Number((states[i] || [])[0]) || 0, row = stats.find((r) => Number(r[0]) === i + 1);
    out.ports.push({
      name: String(i + 1), ifIndex: i + 1, type: "port", up: Number((states[i] || [])[1]) !== 0, carrier: st >= 2, speed: SPEED[st] || "",
      mac: "", bridge: null, members: [], alias: st === 1 ? "error-disabled" : "",
      txPkts: row ? Number(row[1]) : null, rxPkts: row ? Number(row[2]) : null, errors: row ? Number(row[3]) + Number(row[4]) : null
    });
  }

  // the first page of the table (ds_TotalPage says if there are more; an 8-port switch here had 23 MACs on one)
  await probe("fdb", async () => {
    const js = await ds(dev, "DFT.js");
    for (const [port, mac, vid] of readVar(js, "ds_DFT") || []) {
      const m = dashMac(mac);
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m) || parseInt(m.slice(0, 2), 16) & 1) continue;
      if (Number(port) >= 1 && Number(port) <= n) out.clients.push({ mac: m, via: "fdb", iface: String(port), detail: { vlan: Number(vid) || null } });
    }
  });

  // PoE models only (the -P ones): a switch without PoE has no PoE.js
  let hasPoe = false;
  await probe("poe", async () => {
    const sysJs = await ds(dev, "PoE.js").catch(() => "");
    const budget = readVar(sysJs, "ds_PoeSysPow"), used = readVar(sysJs, "ds_PoeUsedPower");
    if (budget == null && used == null) return;
    hasPoe = true;
    out.poe = { budgetW: budget != null ? budget / 10 : null, usedW: used != null ? used / 10 : null, on: true };
    const rows = readVar(await ds(dev, "PoEPort.js"), "ds_PoEPort") || [];
    rows.forEach((r, i) => {
      const p = out.ports[i];
      if (!p || !r) return;
      const [state, , , power, volt, mA, cls, status, detected] = r.map(Number);
      const st = state !== 1 ? "disabled" : POE_STATUS[status] || "searching";
      // class: 0..3; while powering with nothing detected the page says "Legacy PD" (no class)
      p.poe = { status: st, cls: st === "delivering" && !detected && !cls ? null : cls <= 3 ? cls : null,
        volts: Math.round((volt * 64.45) / 100) / 10, mA, mW: power * 100 };
    });
  });
  if (!hasPoe) delete out.probes.poe;

  if (out.probes.system !== "ok" && out.probes.ports !== "ok") throw new Error(out.probes.system || out.probes.ports);
  const own = new Set(out.ownMacs);
  out.clients = out.clients.filter((c) => !own.has(c.mac));
  return out;
}

module.exports = { poll, readVar };
