// Netgear smart switches with the Backbone web UI (S350 series, GS3xx "Smart Managed Pro" with cgi/get.cgi):
// per-port PoE (status, class, volts, mA, mW) and the PoE unit's total, which their SNMP agent doesn't have.
// Read-only: the only things ever POSTed are the login and the logout of netmap's own session. Never poe_portReset.
//
// How the UI logs in (login.html, js/utility.js):
//   1. POST cgi/set.cgi?cmd=home_loginAuth with "_ds=1&pwd=<encode(pw)>&password=<pw>&_de=1"
//   2. GET  cgi/get.cgi?cmd=home_loginStatus until data.status is "ok" (data.sess) or "fail"
//   3. sess is base64 of: 32-char xsid + 5-char exponent ("10001") + hex RSA modulus (+ a trailing NUL)
//   4. every later request carries X-CSRF-XSID: base64(RSA-PKCS#1-v1.5(xsid)); that header is the session
// Every URL with a query also gets &hash=md5(query). The session is kept between polls (logging in each poll
// would fill the switch's few session slots); it's logged in again when the switch says notAuth.
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = new Map(); // collector id -> { header() }

// The UI's password scrambling (js/utility.js encode()): the password reversed into every 7th of 320 random
// characters, with its length at positions 123 and 289.
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function encode(input) {
  let text = "", len = input.length;
  const n = input.length;
  for (let i = 1; i <= 320 - len; i++) {
    if (i % 7 === 0 && len > 0) text += input.charAt(--len);
    else if (i === 123) text += n < 10 ? "0" : Math.floor(n / 10);
    else if (i === 289) text += n % 10;
    else text += CHARS.charAt(crypto.randomInt(CHARS.length));
  }
  return text;
}

function request(col, method, path, { body, xsid } = {}) {
  const q = path.split("?")[1];
  if (q) path += "&hash=" + md5(q);
  const useHttps = col.https !== 0;
  const mod = useHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      host: col.host, port: col.port || (useHttps ? 443 : 80), path: "/" + path, method, agent: false,
      rejectUnauthorized: !!col.verify_tls, timeout: 15000,
      headers: { ...(xsid ? { "X-CSRF-XSID": xsid() } : {}),
        ...(body != null ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}) }
    }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${path.split("?")[0]}`));
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`not JSON from ${path.split("?")[0]} (is this a Netgear smart switch?)`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function login(col) {
  const pw = String(col.password || "");
  await request(col, "POST", `cgi/set.cgi?cmd=home_loginAuth&dummy=${Date.now()}`,
    { body: `_ds=1&pwd=${encodeURIComponent(encode(pw))}&password=${encodeURIComponent(pw)}&_de=1` });
  let st = null;
  for (let i = 0; i < 8; i++) {
    st = (await request(col, "GET", `cgi/get.cgi?cmd=home_loginStatus&dummy=${Date.now()}`)).data || {};
    if (st.status === "ok" || st.status === "fail") break;
    await sleep(1000);
  }
  if (!st || st.status !== "ok" || !st.sess) {
    throw new Error(st && st.status === "fail"
      ? "login refused: wrong password, or all the switch's web sessions are in use (they free up after its idle timeout)"
      : "login didn't finish");
  }
  const raw = Buffer.from(st.sess, "base64").toString("latin1");
  const xsid = raw.slice(0, 32);
  const hex = raw.slice(37).replace(/[^0-9a-f]/gi, ""); // the UI's parser skips the trailing NUL the same way
  const key = crypto.createPublicKey({ format: "jwk",
    key: { kty: "RSA", n: Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex").toString("base64url"), e: "AQAB" } });
  const s = { header: () => crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(xsid)).toString("base64") };
  sessions.set(col.id, s);
  return s;
}

// GET a cgi/get.cgi command with the session, logging in (again) when there's none or it has expired.
async function get(col, cmd) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = sessions.get(col.id) || (await login(col));
    const r = await request(col, "GET", `cgi/get.cgi?cmd=${cmd}&dummy=${Date.now()}`, { xsid: s.header });
    if (r.logout) { sessions.delete(col.id); continue; }
    return r.data || {};
  }
  throw new Error("the switch keeps ending the session");
}

// "lang('poe','txtPortStatusDelivering')" -> "Delivering"
const langWord = (v, prefix) => { const m = String(v || "").match(new RegExp(`${prefix}(\\w+)'`)); return m ? m[1] : String(v || ""); };
const STATUS = { Delivering: "delivering", Searching: "searching", Disabled: "disabled", Fault: "fault", Test: "test", OtherFault: "fault" };

// -> { probes, portPoe: { "<port number>": {...} }, poe: { budgetW, usedW, on } }
async function collect(col) {
  const out = { probes: {}, portPoe: {}, poe: null };
  const ports = await get(col, "poe_port");
  (ports.ports || []).forEach((p, i) => {
    const cls = langWord(p.class, "txtPortClass");
    out.portPoe[String(i + 1)] = {
      status: STATUS[langWord(p.status, "txtPortStatus")] || langWord(p.status, "txtPortStatus").toLowerCase(),
      cls: /^\d$/.test(cls) ? Number(cls) : null,
      volts: Number(p.voltage) || 0, mA: Number(p.amphere) || 0, mW: Number(p.power) || 0,
      fault: langWord(p.fault, "txtPortFault") === "None" ? null : langWord(p.fault, "txtPortFault")
    };
  });
  out.probes.poePorts = "ok";
  try {
    const conf = await get(col, "poe_conf");
    const u = conf.units || [];
    if (u.length) {
      out.poe = { budgetW: u.reduce((a, x) => a + (Number(x.nominalPower) || 0), 0), usedW: u.reduce((a, x) => a + (Number(x.consumedPower) || 0), 0),
        on: u.some((x) => /On'/.test(x.operStatus)) };
    }
    out.probes.poeTotal = "ok";
  } catch (e) { out.probes.poeTotal = e.message; }
  return out;
}

// Free netmap's session slot (on shutdown or when the collector is removed).
async function logout(col) {
  const s = sessions.get(col.id);
  sessions.delete(col.id);
  if (s) await request(col, "POST", `cgi/set.cgi?cmd=home_logout&dummy=${Date.now()}`, { body: "_ds=1&empty=1&_de=1", xsid: s.header }).catch(() => {});
}

module.exports = {
  label: "Netgear web UI (PoE per port)",
  defaults: { https: 1, username: "admin" },
  probes: { poePorts: ["PoE per port (watts, volts, mA, class)", "the switch's web login (cgi/get.cgi?cmd=poe_port)"],
    poeTotal: ["PoE total and budget", "the web login (cgi/get.cgi?cmd=poe_conf)"] },
  collect, logout, encode
};
