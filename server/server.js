// netmap server: polls the devices in the database and serves the map.
//
//   GET    /api/graph                    nodes and edges for the map
//   GET    /api/devices                  managed devices (never includes passwords)
//   POST   /api/devices                  add { name, host, port?, https?, verify_tls?, username, password, driver?,
//                                        plugged_into?, plugged_port?, mac?, node? }; driver "none" = unmanaged, never
//                                        polled; driver "proxmox" needs node (which cluster node) and a user@pve login
//   PATCH  /api/devices/:id              change any of the above, or { enabled }, { notes }
//   DELETE /api/devices/:id
//   POST   /api/devices/:id/poll         poll now, returns the result or the error (works while paused too)
//   POST   /api/devices/:id/pause        { minutes } pause polling for that long; -1 until resumed; 0 resumes
//   PUT    /api/devices/:id/uplink       { device, port } what it's plugged into (a drawn cable); { device: null } = automatic
//   POST   /api/proxmox/nodes            { host, port?, username, password } -> { cluster, nodes: [{ name, ip, online }] }
//   POST   /api/setup                    { name, host, port?, https?, root_user?, root_password, device_id? } sets up an OpenWrt
//                                        device (device_id: re-run it for a device already on the map), then
//                                        device with the root login, then adds it; returns a job to watch
//   GET    /api/setup/:job               { state: running|done|error, log, deviceId }
//   GET    /api/devices/:id/collectors   the device's extra data sources (no passwords)
//   POST   /api/devices/:id/collectors   { kind, host?, port?, https?, verify_tls?, username, password } adds one
//   PATCH  /api/collectors/:id           change any of those, or { enabled }; blank password keeps the current one
//   GET    /api/collectors/:id/setup     { text }: commands to run on the device (kinds that make their own SSH key)
//   DELETE /api/collectors/:id
//   GET    /api/devices/:id/raw          latest normalised poll result (for debugging a device)
//   POST   /api/oui/update               re-download the MAC manufacturer list now (it also refreshes monthly)
//   PUT    /api/positions                { nodes: [{ id: "d1" | "c<mac>", x, y }] } saves the layout
//   DELETE /api/positions                forget every dragged position (back to the automatic layout)
//   PATCH  /api/clients/:mac             { label } and/or { placed_device, placed_port } (null device = automatic)
//   POST   /api/links                    { a_device, a_port?, b_device, b_port?, note? }: a cable from the upstream
//                                        device a down to device b
//   DELETE /api/links/:id
// Everything else is the built web app in ../web/dist.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { open, all, plain } = require("./db.js");
const { build } = require("./graph.js");
const drivers = { openwrt: require("./drivers/openwrt.js"), snmp: require("./drivers/snmp.js"), proxmox: require("./drivers/proxmox.js"),
  tplink: require("./drivers/tplink.js"), dlink: require("./drivers/dlink.js") };
// Devices nobody can ask anything (a dumb switch): on the map, never polled.
const UNMANAGED = "none";
const setup = require("./setup.js");
const oui = require("./oui.js");
const rates = require("./rates.js");
const energy = require("./energy.js");
const collectors = require("./collectors/index.js");
const COLLECTOR_COLS = "id, device_id, kind, host, port, https, verify_tls, username, enabled, created_at, (password != '') as has_password";

const CONFIG_PATH = process.env.NETMAP_CONFIG || path.join(__dirname, "config.json");
const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
const HOST = process.env.HOST || config.host || "127.0.0.1";
const PORT = Number(process.env.PORT || config.port || 8090);
const POLL_MS = (Number(process.env.POLL_SECONDS) || config.pollSeconds || 60) * 1000;
const CLIENT_MAX_AGE = config.clientMaxAgeMinutes || 60;
const DB_PATH = path.resolve(__dirname, process.env.NETMAP_DB || config.db || "netmap.db");
const WEB = path.resolve(__dirname, "..", "web", "dist");

const db = open(DB_PATH);
oui.load(db);
energy.init(db);
const PUBLIC_COLS = "id, name, driver, host, port, https, verify_tls, username, enabled, notes, is_root, is_core, mac, node, wan_port, paused_until, created_at, (password != '') as has_password";
const EDITABLE = ["name", "driver", "host", "port", "https", "verify_tls", "username", "password", "enabled", "notes", "is_root", "is_core", "mac", "node", "wan_port"];

// ---------- polling ----------
const busy = new Set();
async function pollDevice(id) {
  const dev = plain(db.prepare("select * from devices where id = ?").get(id));
  if (!dev) throw new Error("no such device");
  if (dev.driver === UNMANAGED) return { ok: true, polledAt: null, result: null };
  const driver = drivers[dev.driver];
  if (!driver) throw new Error(`unknown driver ${dev.driver}`);
  if (busy.has(id)) throw new Error("already polling");
  busy.add(id);
  const now = new Date().toISOString();
  try {
    const cols = all(db.prepare("select * from collectors where device_id = ? and enabled = 1 order by id"), id);
    const r = rates.apply(id, await collectors.runAll(dev, cols, await driver.poll(dev)));
    if (r.poe) energy.record(db, id, r.poe.usedW);
    db.exec("begin");
    try {
      db.prepare(`insert into polls (device_id, polled_at, ok, error, last_ok_at, result) values (?, ?, 1, null, ?, ?)
        on conflict(device_id) do update set polled_at = excluded.polled_at, ok = 1, error = null, last_ok_at = excluded.last_ok_at, result = excluded.result`)
        .run(id, now, now, JSON.stringify(r));
      const upClient = db.prepare(`insert into clients (mac, ip, hostname, first_seen, last_seen) values (?, ?, ?, ?, ?)
        on conflict(mac) do update set ip = coalesce(nullif(excluded.ip, ''), ip), hostname = coalesce(nullif(excluded.hostname, ''), hostname), last_seen = excluded.last_seen`);
      const upSight = db.prepare(`insert into sightings (device_id, mac, via, iface, detail, seen_at) values (?, ?, ?, ?, ?, ?)
        on conflict(device_id, mac, via) do update set iface = excluded.iface, detail = excluded.detail, seen_at = excluded.seen_at`);
      for (const c of r.clients) {
        upClient.run(c.mac, c.ip || "", c.hostname || "", now, now);
        upSight.run(id, c.mac, c.via, c.iface || "", c.detail ? JSON.stringify(c.detail) : null, now);
      }
      const upName = db.prepare(`insert into names (mac, hostname, ip, device_id, seen_at) values (?, ?, ?, ?, ?)
        on conflict(mac) do update set hostname = coalesce(nullif(excluded.hostname, ''), hostname), ip = coalesce(nullif(excluded.ip, ''), ip),
          device_id = excluded.device_id, seen_at = excluded.seen_at`);
      for (const [mac, n] of Object.entries(r.names || {})) upName.run(mac, n.hostname || "", n.ip || "", id, now);
      // Sightings this device no longer reports are gone (client left, MAC aged out).
      db.prepare("delete from sightings where device_id = ? and seen_at < ?").run(id, now);
      db.exec("commit");
    } catch (e) { db.exec("rollback"); throw e; }
    return { ok: true, polledAt: now, result: r };
  } catch (err) {
    const msg = err.message || String(err);
    db.prepare(`insert into polls (device_id, polled_at, ok, error) values (?, ?, 0, ?)
      on conflict(device_id) do update set polled_at = excluded.polled_at, ok = 0, error = excluded.error`).run(id, now, msg);
    console.error(`[${now}] device ${id} (${dev.host}): ${msg}`);
    return { ok: false, polledAt: now, error: msg };
  } finally {
    busy.delete(id);
  }
}

// One device's trouble (including being removed mid-round) must never stop the round or the server.
async function pollAll() {
  // paused devices are skipped until their pause runs out
  const now = new Date().toISOString();
  for (const { id } of all(db.prepare("select id from devices where enabled = 1 and driver != 'none' and (paused_until is null or paused_until <= ?)"), now)) {
    if (busy.has(id)) continue;
    try { await pollDevice(id); }
    catch (e) { if (!/no such device/.test(e.message)) console.error(`poll of device ${id} failed: ${e.message}`); }
  }
  rememberUplinks();
}

// Store each device's connection as confirmed by real evidence (MAC tables, LLDP, a cable you set), so the map
// can keep a link for a while when its MAC-table entry ages out (graph.js falls back to it).
function rememberUplinks() {
  try {
    const g = build(db, { clientMaxAgeMinutes: CLIENT_MAX_AGE });
    const up = db.prepare(`insert into uplinks (device_id, parent_id, parent_port, own_port, via, seen_at) values (?, ?, ?, ?, ?, ?)
      on conflict(device_id) do update set parent_id = excluded.parent_id, parent_port = excluded.parent_port,
        own_port = excluded.own_port, via = excluded.via, seen_at = excluded.seen_at`);
    const now = new Date().toISOString();
    for (const n of g.nodes) {
      if (n.kind !== "device" || !n.parent) continue;
      // a core switch's real connection, else its own; never a role placement or an older memory
      const real = n.realParent ? { p: n.realParent, pp: n.realPort, op: n.realUplinkPort, via: n.realVia } : { p: n.parent, pp: n.parentPort, op: n.uplinkPort, via: n.parentVia };
      if (!["fdb", "lldp", "manual"].includes(real.via)) continue;
      up.run(n.deviceId, Number(real.p.slice(1)), real.pp || "", real.op || "", real.via, now);
    }
  } catch (e) { console.error("remembering uplinks failed:", e.message); }
}

async function addDevice(body) {
  const d = cleanDevice(body, false);
  const cols = Object.keys(d);
  const info = db.prepare(`insert into devices (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`).run(...cols.map((k) => d[k]));
  const id = Number(info.lastInsertRowid);
  // "plugged into": record the cable from the upstream device down to this one
  if (body.plugged_into) {
    db.prepare("insert into links (a_device, a_port, b_device, b_port) values (?, ?, ?, ?)")
      .run(Number(body.plugged_into), String(body.plugged_port || "").trim(), id, String(body.uplink_port || "").trim());
  }
  const poll = await pollDevice(id);
  return { id, device: plain(db.prepare(`select ${PUBLIC_COLS} from devices where id = ?`).get(id)), poll: { ok: poll.ok, error: poll.error || null, probes: poll.result && poll.result.probes } };
}

// After a re-run setup: store the device's new read-only login, then poll it (same shape addDevice returns).
async function updateLogin(id, d) {
  db.prepare("update devices set username = ?, password = ? where id = ?").run(d.username, d.password, id);
  const poll = await pollDevice(id);
  return { id, device: plain(db.prepare(`select ${PUBLIC_COLS} from devices where id = ?`).get(id)), poll: { ok: poll.ok, error: poll.error || null, probes: poll.result && poll.result.probes } };
}

// ---------- http ----------
function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error("bad JSON body")); } });
    req.on("error", reject);
  });
}
function cleanCollector(b, partial) {
  const out = {};
  if (!partial || b.kind !== undefined) {
    if (!collectors.kinds[b.kind]) throw new Error(`unknown collector ${b.kind}`);
    out.kind = b.kind;
  }
  for (const k of ["host", "username", "password"]) if (b[k] !== undefined) out[k] = String(b[k] ?? "").trim();
  if (b.port !== undefined) out.port = b.port ? Number(b.port) : null;
  for (const k of ["https", "verify_tls", "enabled"]) if (b[k] !== undefined) out[k] = b[k] ? 1 : 0;
  if (!partial && !out.password && !(collectors.kinds[out.kind] && collectors.kinds[out.kind].generatesKey)) throw new Error("the collector needs a password");
  return out;
}

// existingDriver: the stored driver when editing (the edit may not send it).
function cleanDevice(b, partial, existingDriver) {
  const out = {};
  for (const k of EDITABLE) if (b[k] !== undefined) out[k] = b[k];
  for (const k of ["https", "verify_tls", "enabled", "is_root", "is_core"]) if (k in out) out[k] = out[k] ? 1 : 0;
  if ("port" in out) out.port = out.port ? Number(out.port) : null;
  for (const k of ["name", "host", "username", "notes", "driver", "node", "wan_port"]) if (k in out) out[k] = String(out[k] ?? "").trim();
  if ((out.driver || existingDriver) === "proxmox") {
    if (out.username) out.username = drivers.proxmox.realmUser(out.username);
    if (out.username && /@pam$/i.test(out.username)) throw new Error("use a PVE-realm account (user@pve), not a PAM one");
    if (!partial && !out.node) throw new Error("pick which Proxmox node this device is");
  }
  if ("mac" in out) {
    const hex = String(out.mac || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (hex && hex.length !== 12) throw new Error("that MAC address doesn't look right (12 hex digits, e.g. 00:11:22:33:44:55)");
    out.mac = hex ? hex.match(/../g).join(":") : "";
  }
  if (!partial && !out.name) throw new Error("a name is required");
  if (!partial && !out.host && out.driver !== UNMANAGED) throw new Error("a host or IP is required");
  if (out.driver && out.driver !== UNMANAGED && !drivers[out.driver]) throw new Error(`unknown driver ${out.driver}`);
  if (out.host == null && !partial) out.host = "";
  return out;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(req, res, pathname) {
  if (!fs.existsSync(path.join(WEB, "index.html"))) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("The web app isn't built yet: run `npm install && npm run build` in netmap/web. The API is up at /api/graph.");
  }
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(WEB, "." + rel);
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

async function api(req, res, url) {
  const m = (re) => url.pathname.match(re);
  const method = req.method;
  let r;
  if (url.pathname === "/api/graph" && method === "GET") return send(res, 200, { ...build(db, { clientMaxAgeMinutes: CLIENT_MAX_AGE, lookup: oui.lookup, energy: energy.summary(db) }), oui: oui.status() });
  if (url.pathname === "/api/oui/update" && method === "POST") return send(res, 200, await oui.update(db));
  if (url.pathname === "/api/devices" && method === "GET") return send(res, 200, all(db.prepare(`select ${PUBLIC_COLS} from devices order by id`)));
  if (url.pathname === "/api/devices" && method === "POST") {
    const r = await addDevice(await readBody(req));
    return send(res, 201, { device: r.device, poll: r.poll });
  }
  if (url.pathname === "/api/proxmox/nodes" && method === "POST") {
    // Log in with the given account and list the cluster's nodes, for the add form.
    const b = await readBody(req);
    if (!b.host || !b.username || !b.password) throw new Error("host, user and password are needed to look up the nodes");
    return send(res, 200, await drivers.proxmox.listNodes({ host: String(b.host).trim(), port: b.port ? Number(b.port) : 8006, username: b.username, password: b.password, verify_tls: !!b.verify_tls }));
  }
  if (url.pathname === "/api/setup" && method === "POST") return send(res, 202, setup.start(await readBody(req), addDevice, updateLogin));
  if ((r = m(/^\/api\/setup\/([0-9a-f-]+)$/)) && method === "GET") {
    const j = setup.get(r[1]);
    return send(res, j ? 200 : 404, j || { error: "no such setup job" });
  }
  if ((r = m(/^\/api\/devices\/(\d+)$/))) {
    const id = Number(r[1]);
    if (method === "PATCH") {
      const cur = db.prepare("select driver from devices where id = ?").get(id);
      const d = cleanDevice(await readBody(req), true, cur && cur.driver);
      if (d.password === "") delete d.password; // blank means "keep the current password"
      if (d.is_root) { db.prepare("update devices set is_root = 0 where id != ?").run(id); d.is_core = 0; } // one gateway, and it isn't a core switch
      if (d.is_core) d.is_root = 0;
      const cols = Object.keys(d);
      if (cols.length) db.prepare(`update devices set ${cols.map((k) => k + " = ?").join(", ")} where id = ?`).run(...cols.map((k) => d[k]), id);
      return send(res, 200, plain(db.prepare(`select ${PUBLIC_COLS} from devices where id = ?`).get(id)));
    }
    if (method === "DELETE") { db.prepare("delete from devices where id = ?").run(id); return send(res, 200, { ok: true }); }
  }
  if ((r = m(/^\/api\/devices\/(\d+)\/poll$/)) && method === "POST") {
    const p = await pollDevice(Number(r[1]));
    return send(res, 200, { ok: p.ok, error: p.error || null, polledAt: p.polledAt, probes: p.result && p.result.probes });
  }
  if ((r = m(/^\/api\/devices\/(\d+)\/pause$/)) && method === "POST") {
    // { minutes: 60 } pauses polling for that long, { minutes: -1 } until resumed, { minutes: 0 } resumes
    const minutes = Number((await readBody(req)).minutes) || 0;
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : minutes < 0 ? "9999-12-31T00:00:00.000Z" : null;
    db.prepare("update devices set paused_until = ? where id = ?").run(until, Number(r[1]));
    return send(res, 200, { ok: true, paused_until: until });
  }
  if ((r = m(/^\/api\/devices\/(\d+)\/uplink$/)) && method === "PUT") {
    // Say what this device is plugged into (replaces any cable drawn into it); { device: null } = automatic.
    const id = Number(r[1]), b = await readBody(req);
    if (b.device && Number(b.device) === id) throw new Error("a device can't be plugged into itself");
    db.prepare("delete from links where b_device = ?").run(id);
    if (b.device) db.prepare("insert into links (a_device, a_port, b_device, b_port) values (?, ?, ?, ?)")
      .run(Number(b.device), String(b.port || "").trim(), id, String(b.uplink_port || "").trim());
    return send(res, 200, { ok: true });
  }
  if ((r = m(/^\/api\/devices\/(\d+)\/collectors$/))) {
    const id = Number(r[1]);
    if (method === "GET") return send(res, 200, all(db.prepare(`select ${COLLECTOR_COLS} from collectors where device_id = ? order by id`), id));
    if (method === "POST") {
      if (!db.prepare("select 1 from devices where id = ?").get(id)) throw new Error("no such device");
      const c = cleanCollector(await readBody(req), false);
      // kinds that log in with a key netmap makes: the private key is the stored secret
      if (collectors.kinds[c.kind].generatesKey && !c.password) c.password = collectors.kinds[c.kind].generateKey();
      const keys = Object.keys(c);
      const info = db.prepare(`insert into collectors (device_id, ${keys.join(", ")}) values (?, ${keys.map(() => "?").join(", ")})`).run(id, ...keys.map((k) => c[k]));
      const poll = await pollDevice(id).catch((e) => ({ ok: false, error: e.message }));
      return send(res, 201, { collector: plain(db.prepare(`select ${COLLECTOR_COLS} from collectors where id = ?`).get(Number(info.lastInsertRowid))),
        poll: { ok: poll.ok, error: poll.error || null, probes: poll.result && poll.result.probes } });
    }
  }
  if ((r = m(/^\/api\/collectors\/(\d+)\/setup$/)) && method === "GET") {
    const c = plain(db.prepare("select * from collectors where id = ?").get(Number(r[1])));
    const k = c && collectors.kinds[c.kind];
    if (!k || !k.setupText) return send(res, 404, { error: "no setup commands for this data source" });
    const host = c.host || (db.prepare("select host from devices where id = ?").get(c.device_id) || {}).host;
    return send(res, 200, { text: k.setupText({ ...c, host }) });
  }
  if ((r = m(/^\/api\/collectors\/(\d+)$/))) {
    const id = Number(r[1]);
    const cur = plain(db.prepare("select * from collectors where id = ?").get(id));
    if (!cur) return send(res, 404, { error: "no such collector" });
    if (method === "PATCH") {
      const c = cleanCollector(await readBody(req), true);
      if (c.password === "") delete c.password;
      const keys = Object.keys(c);
      if (keys.length) db.prepare(`update collectors set ${keys.map((k) => k + " = ?").join(", ")} where id = ?`).run(...keys.map((k) => c[k]), id);
      collectors.forget(cur); // log in again with the new settings
      return send(res, 200, plain(db.prepare(`select ${COLLECTOR_COLS} from collectors where id = ?`).get(id)));
    }
    if (method === "DELETE") {
      await collectors.forget({ ...cur, host: cur.host || (db.prepare("select host from devices where id = ?").get(cur.device_id) || {}).host });
      db.prepare("delete from collectors where id = ?").run(id);
      return send(res, 200, { ok: true });
    }
  }
  if ((r = m(/^\/api\/devices\/(\d+)\/raw$/)) && method === "GET") {
    const p = plain(db.prepare("select * from polls where device_id = ?").get(Number(r[1])));
    return send(res, p ? 200 : 404, p ? { ...p, result: p.result ? JSON.parse(p.result) : null } : { error: "not polled yet" });
  }
  if (url.pathname === "/api/positions" && method === "PUT") {
    const { nodes = [] } = await readBody(req);
    const dev = db.prepare("update devices set x = ?, y = ? where id = ?");
    const cli = db.prepare("update clients set x = ?, y = ? where mac = ?");
    for (const n of nodes) {
      if (n.id.startsWith("d")) dev.run(n.x, n.y, Number(n.id.slice(1)));
      else if (n.id.startsWith("c")) cli.run(n.x, n.y, n.id.slice(1));
    }
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/api/positions" && method === "DELETE") {
    db.exec("update devices set x = null, y = null; update clients set x = null, y = null;");
    return send(res, 200, { ok: true });
  }
  if ((r = m(/^\/api\/clients\/([0-9a-f:]+)$/)) && method === "PATCH") {
    const b = await readBody(req);
    if (b.label !== undefined) db.prepare("update clients set label = ? where mac = ?").run(String(b.label || "").trim(), r[1]);
    if (b.placed_device !== undefined) {
      db.prepare("update clients set placed_device = ?, placed_port = ? where mac = ?")
        .run(b.placed_device ? Number(b.placed_device) : null, String(b.placed_port || "").trim(), r[1]);
    }
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/api/links" && method === "POST") {
    const b = await readBody(req);
    if (!b.a_device || !b.b_device || b.a_device === b.b_device) throw new Error("a_device and b_device must be two different devices");
    const info = db.prepare("insert into links (a_device, a_port, b_device, b_port, note) values (?, ?, ?, ?, ?)")
      .run(Number(b.a_device), b.a_port || "", Number(b.b_device), b.b_port || "", b.note || "");
    return send(res, 201, { id: Number(info.lastInsertRowid) });
  }
  if ((r = m(/^\/api\/links\/(\d+)$/)) && method === "DELETE") { db.prepare("delete from links where id = ?").run(Number(r[1])); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: "not found" });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
  try { await api(req, res, url); } catch (e) { send(res, 400, { error: e.message || String(e) }); }
}).listen(PORT, HOST, () => {
  console.log(`netmap on http://${HOST}:${PORT}  (db ${DB_PATH}, polling every ${POLL_MS / 1000}s)`);
});

// A long-running poller should log a stray async error, not die from it.
process.on("unhandledRejection", (e) => console.error("unhandled:", e && e.stack ? e.stack : e));

pollAll();
setInterval(pollAll, POLL_MS);
oui.refreshIfStale(db);
setInterval(() => oui.refreshIfStale(db), 24 * 3600 * 1000);
