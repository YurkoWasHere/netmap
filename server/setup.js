// Automatic OpenWrt setup: log in once as root, run docs/openwrt-setup.sh on the device, then add the
// device with the read-only login it created. The root password lives only in this job's memory and is
// never written to the database or the log.
//
// Two ways in, tried in order:
//   SSH       root over SSH (Dropbear allows password login by default). Works on any OpenWrt.
//   web API   root over ubus, for devices with SSH closed. Needs root's ACL to allow writing /tmp and
//             running /bin/sh, which recent LuCI grants but 19.07 doesn't.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");
const { call, login, resetEndpoint } = require("./drivers/openwrt.js");

const SCRIPT = path.join(__dirname, "..", "docs", "openwrt-setup.sh");
const REMOTE_SCRIPT = "/tmp/netmap-setup.sh";
const REMOTE_LOG = "/tmp/netmap-setup.log";
const TIMEOUT_MS = 15 * 60 * 1000;

const jobs = new Map(); // id -> { id, state: running|done|error, log: [], deviceId, error }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A job record for the API: no credentials in it.
const view = (j) => j && { id: j.id, state: j.state, log: j.log, deviceId: j.deviceId, error: j.error };

// body.device_id: re-run the setup for a device that's already on the map (e.g. to install newer helpers); its
// stored login is replaced with the new read-only one instead of adding a second device.
function start(body, addDevice, updateDevice) {
  const name = String(body.name || "").trim(), host = String(body.host || "").trim();
  if ((!name && !body.device_id) || !host || !body.root_password) throw new Error("name, host and the root password are required");
  const conn = { host, port: body.port ? Number(body.port) : null, https: body.https ? 1 : 0, verify_tls: body.verify_tls ? 1 : 0 };
  const root = { ...conn, username: String(body.root_user || "root"), password: String(body.root_password), sshPort: Number(body.ssh_port) || 22 };
  // base64url: letters, digits, - and _ only, so it's safe inside single quotes in the shell.
  const monitor = { username: "monitor", password: crypto.randomBytes(18).toString("base64url") };
  const job = { id: crypto.randomUUID(), state: "running", log: [], deviceId: null, error: null };
  jobs.set(job.id, job);
  const deviceId = body.device_id ? Number(body.device_id) : null;
  const save = deviceId ? (d) => updateDevice(deviceId, d) : addDevice;
  run(job, { name, conn, root, monitor }, save)
    .catch((e) => { job.state = "error"; job.error = e.message || String(e); job.log.push("✕ " + job.error); })
    .finally(() => { root.password = null; setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000); });
  return view(job);
}

async function run(job, { name, conn, root, monitor }, addDevice) {
  const say = (line) => job.log.push(line);
  const scrub = (l) => l.split(monitor.password).join("••••").split(root.password).join("••••");

  say(`Connecting to ${conn.host} over SSH (port ${root.sshPort}) as ${root.username}…`);
  try {
    await viaSsh(root, monitor, say, scrub);
  } catch (e) {
    if (!e.unreachable) throw e;
    say(`SSH isn't reachable (${e.message}); trying the web API instead…`);
    await viaUbus(root, monitor, say, scrub);
  }

  say("Waiting for the web server and rpcd to restart…");
  await sleep(5000);
  resetEndpoint(conn);
  const dev = { ...conn, ...monitor };
  let ok = false, lastErr = null;
  for (let i = 0; i < 10 && !ok; i++) {
    try { await login(dev); ok = true; } catch (e) { lastErr = e; await sleep(2000); }
  }
  if (!ok) throw new Error(`setup finished but the new monitor login doesn't work yet (${lastErr.message}); try /etc/init.d/rpcd restart on the device`);
  say("Read-only login works. Saving it and probing the device…");
  const added = await addDevice({ name, ...conn, ...monitor });
  job.deviceId = added.id;
  say(added.poll.ok ? "✓ Done." : `Added, but the first poll failed: ${added.poll.error}`);
  job.state = "done";
}

// Runs the script as `sh -s` with the script on stdin. Its arguments travel inside stdin too (`set -- …`),
// so the passwords never appear on the router's command line or in `ps`.
function viaSsh(root, monitor, say, scrub) {
  const script = `set -- '${monitor.password}' '${monitor.username}'\n` + fs.readFileSync(SCRIPT, "utf8");
  return new Promise((resolve, reject) => {
    const c = new Client();
    let connected = false, settled = false;
    const done = (err) => { if (settled) return; settled = true; c.end(); err ? reject(err) : resolve(); };
    const timer = setTimeout(() => done(new Error(`setup didn't finish in ${TIMEOUT_MS / 60000} minutes`)), TIMEOUT_MS);
    c.on("ready", () => {
      connected = true;
      say("Logged in. Running the setup script (installing packages can take a few minutes)…");
      c.exec("sh -s", (err, stream) => {
        if (err) return done(err);
        let buf = "";
        const onData = (d) => {
          buf += d.toString();
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const l of lines) if (l.trim()) say("  " + scrub(l));
        };
        stream.on("data", onData);
        stream.stderr.on("data", onData);
        stream.on("close", (code) => {
          clearTimeout(timer);
          if (buf.trim()) say("  " + scrub(buf));
          done(code === 0 ? null : new Error(`the setup script failed (exit ${code}); the lines above show where`));
        });
        stream.end(script);
      });
    });
    c.on("error", (e) => {
      clearTimeout(timer);
      if (e.level === "client-authentication") return done(new Error("SSH login failed: wrong root password"));
      // Couldn't connect at all: let the caller try the web API.
      if (!connected && /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|Timed out while waiting for handshake/.test(e.code || e.message)) {
        const u = new Error(e.code === "ECONNREFUSED" ? "connection refused" : e.message);
        u.unreachable = true;
        return done(u);
      }
      done(new Error(`SSH: ${e.message}`));
    });
    c.connect({
      host: root.host, port: root.sshPort, username: root.username, password: root.password,
      tryKeyboard: true, readyTimeout: 10000,
      // Trust on first use: show the host key so it can be compared with the one on the device.
      hostVerifier: (key) => { say(`Host key SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`); return true; }
    });
    c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => root.password)));
  });
}

async function viaUbus(root, monitor, say, scrub) {
  say(`Logging in to ${root.host} as ${root.username}…`);
  let session;
  try { session = await login(root); }
  catch (e) {
    if (/no ubus endpoint/.test(e.message)) throw new Error("This device has neither SSH nor a ubus web API reachable. Enable SSH (System → Administration in LuCI) and try again.");
    throw new Error(e.message.replace("no rpcd login entry for this user", "root login over the web API is disabled"));
  }
  const board = await call(root, session, "system", "board");
  say(`Found ${board.model || "an OpenWrt device"}${board.release ? `, ${board.release.distribution} ${board.release.version}` : ""} (${board.hostname || "no hostname"}).`);

  say("Copying the setup script…");
  try { await call(root, session, "file", "write", { path: REMOTE_SCRIPT, data: fs.readFileSync(SCRIPT, "utf8") }); }
  catch (e) {
    if (/permission denied/.test(e.message)) throw new Error("root's web API permissions don't allow running the setup (normal on OpenWrt 19.07). Enable SSH on the device (System → Administration in LuCI) and try again.");
    throw new Error(`couldn't write ${REMOTE_SCRIPT}: ${e.message}`);
  }

  // Run detached so rpcd's exec timeout doesn't cut off a slow package install. The script skips its own
  // rpcd restart; we restart uhttpd (new /ubus endpoint) and rpcd (new plugins such as iwinfo) after the exit marker.
  say("Running it (installing packages can take a few minutes)…");
  const cmd = `(NETMAP_DEFER_RESTART=1 sh ${REMOTE_SCRIPT} '${monitor.password}' '${monitor.username}'; echo "NETMAP-EXIT $?"; rm -f ${REMOTE_SCRIPT}; sleep 1; /etc/init.d/uhttpd restart; /etc/init.d/rpcd restart) > ${REMOTE_LOG} 2>&1 < /dev/null &`;
  await call(root, session, "file", "exec", { command: "/bin/sh", params: ["-c", cmd] });

  const t0 = Date.now();
  let shown = 0, exit = null;
  while (exit == null) {
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`setup didn't finish in ${TIMEOUT_MS / 60000} minutes; see ${REMOTE_LOG} on the device`);
    await sleep(2500);
    let text;
    try { text = (await call(root, session, "file", "read", { path: REMOTE_LOG })).data || ""; }
    catch (e) { session = await login(root).catch(() => session); continue; } // rpcd restarted: log in again
    const lines = text.split("\n").filter((l) => l.trim());
    for (const l of lines.slice(shown)) {
      const m = l.match(/^NETMAP-EXIT (\d+)/);
      if (m) exit = Number(m[1]);
      else say("  " + scrub(l));
    }
    shown = lines.length;
  }
  if (exit !== 0) throw new Error(`the setup script failed (exit ${exit}); the lines above show where`);
}

module.exports = { start, get: (id) => view(jobs.get(id)) };
