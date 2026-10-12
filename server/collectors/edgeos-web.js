// Ubiquiti EdgeOS (EdgeRouter) web UI, with a read-only "operator" login: DHCP leases, to name the clients the
// router's ARP table (SNMP) shows only by IP. Read-only: a login, then GETs of /api/edge/data.json views.
//
//   POST /                          username=..&password=..  -> 303, cookies PHPSESSID, beaker.session.id, X-CSRF-TOKEN
//   GET  /api/edge/data.json?data=dhcp_leases  (header X-CSRF-TOKEN)
//        -> { success: "1", output: { "dhcp-server-leases": { <pool>: { <ip>: { mac, "client-hostname", ... } } } } }
// The session is kept between polls and renewed when a request stops returning JSON (expired or logged out).
const https = require("https");

const sessions = new Map(); // collector id -> { cookie }

function request(col, method, path, { body, cookie } = {}) {
  const csrf = cookie && (cookie.match(/X-CSRF-TOKEN=([^;]+)/) || [])[1];
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: col.host, port: col.port || 443, path, method, agent: false, rejectUnauthorized: !!col.verify_tls, timeout: 15000,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-TOKEN": csrf } : {}),
        ...(body != null ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}) }
    }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"] || [], body: d }));
    });
    r.on("timeout", () => r.destroy(new Error("timed out")));
    r.on("error", reject);
    if (body != null) r.write(body);
    r.end();
  });
}

async function login(col) {
  const r = await request(col, "POST", "/", { body: `username=${encodeURIComponent(col.username || "")}&password=${encodeURIComponent(col.password || "")}` });
  const jar = r.setCookie.map((c) => c.split(";")[0]);
  // a good login redirects (303) and sets the session cookies; a bad one shows the login page again
  if (r.status !== 303 || !jar.some((c) => c.startsWith("beaker.session.id="))) throw new Error("login refused: wrong user or password");
  const s = { cookie: jar.join("; ") };
  sessions.set(col.id, s);
  return s;
}

async function data(col, view) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = sessions.get(col.id) || (await login(col));
    const r = await request(col, "GET", `/api/edge/data.json?data=${view}`, { cookie: s.cookie });
    let j = null;
    try { j = JSON.parse(r.body); } catch { /* login page: the session is gone */ }
    if (!j) { sessions.delete(col.id); continue; }
    if (j.success !== "1") throw new Error(j.error || `${view}: refused`);
    return j.output;
  }
  throw new Error("the router keeps ending the session");
}

const normMac = (m) => String(m || "").toLowerCase();

// -> { probes, names: { mac: { hostname, ip } } }. Leases only name clients; they never put one on the map
// (a lease outlives the device), the same rule as OpenWrt's leases.
async function collect(col) {
  const out = { probes: {}, names: {} };
  const leases = (await data(col, "dhcp_leases"))["dhcp-server-leases"] || {};
  for (const pool of Object.values(leases)) {
    for (const [ip, l] of Object.entries(pool || {})) {
      const mac = normMac(l.mac);
      if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) out.names[mac] = { hostname: l["client-hostname"] || "", ip };
    }
  }
  out.probes.leases = "ok";
  return out;
}

module.exports = {
  label: "EdgeOS web UI (DHCP names)",
  probes: { leases: ["DHCP leases (client names)", "a web login on the router; read-only (operator level) is enough"] },
  collect
};
