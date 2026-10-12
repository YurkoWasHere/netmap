// Ubiquiti EdgeOS (EdgeRouter) MAC table over SSH: which MAC is on which jack of switch0, which EdgeOS doesn't
// expose over SNMP or its web UI. EdgeOS only gives a shell to admin-level users, so the login is locked down:
// an admin user with no usable password and one SSH key, which sshd forces to run one read-only script
// (docs/edgeos-netmap-read.sh as /config/scripts/netmap-read; the lock is docs/edgeos-netmap-lock.sh, because
// EdgeOS can't store command="..." on a key). Whatever netmap asks to run, the router runs that script.
// Every poll checks the lock: netmap asks for "echo NETMAP-NOT-LOCKED"; a locked login prints the script's
// output instead. If the marker comes back the login has a full shell, and netmap refuses to use it.
//
// The key pair is made by netmap when the data source is added: the private key is stored as the collector's
// password (never sent back by the API), the public key goes on the router (setupText() prints the commands).
const fs = require("fs");
const path = require("path");
const { Client, utils } = require("ssh2");

const SCRIPT = path.join(__dirname, "..", "..", "docs", "edgeos-netmap-read.sh");
const LOCK = path.join(__dirname, "..", "..", "docs", "edgeos-netmap-lock.sh");
const MARKER = "NETMAP-NOT-LOCKED";
const normMac = (m) => String(m || "").toLowerCase();
const isMac = (m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m);

function generateKey() {
  return utils.generateKeyPairSync("ed25519", { comment: "netmap" }).private;
}
function publicKey(priv) {
  const k = utils.parseKey(priv);
  if (k instanceof Error) throw k;
  const key = k.getPublicSSH().toString("base64"); // the "AAAA..." part of an authorized_keys line
  return { type: k.type, key, line: `${k.type} ${key} netmap` };
}

function run(col) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let settled = false;
    const done = (e, v) => { if (settled) return; settled = true; clearTimeout(t); c.end(); e ? reject(e) : resolve(v); };
    const t = setTimeout(() => done(new Error("timed out")), 20000);
    c.on("ready", () => c.exec(`echo ${MARKER}`, (err, st) => {
      if (err) return done(err);
      let out = "";
      st.on("data", (d) => (out += d));
      st.stderr.on("data", () => {});
      st.on("close", () => done(null, out));
    }));
    c.on("error", (e) => done(e.level === "client-authentication"
      ? new Error("SSH key refused: the public key isn't on the router yet (see the setup commands)") : e));
    c.connect({ host: col.host, port: col.port || 22, username: col.username || "netmap-ssh", privateKey: col.password,
      readyTimeout: 10000, hostVerifier: () => true });
  });
}

// "aa:bb:.. dev eth2 vlan 1 master switch0" -> on eth2; local/self/permanent entries are the router's own
function parse(text) {
  const sec = {};
  let cur = null;
  for (const line of String(text).split("\n")) {
    const m = line.match(/^== (\w+)/);
    if (m) { cur = sec[m[1]] = []; continue; }
    if (cur && line.trim()) cur.push(line.trim());
  }
  const seen = new Map();
  for (const l of sec.fdb || []) {
    const m = l.match(/^([0-9a-f:]{17}) dev (\S+)(.*)$/i);
    if (!m || /\b(permanent|self|local)\b/.test(m[3]) || !/\bmaster switch0\b/.test(m[3])) continue;
    const mac = normMac(m[1]);
    const vlan = (m[3].match(/\bvlan (\d+)/) || [])[1];
    if (isMac(mac)) seen.set(mac, { iface: m[2], vlan: vlan ? Number(vlan) : null });
  }
  if (!seen.size && sec.brctl) {
    // brctl: "port no  mac addr  is local?  ageing timer", port numbers from /sys (brports: "eth2 3")
    const byNo = Object.fromEntries((sec.brports || []).map((l) => l.split(/\s+/)).map(([n, no]) => [String(Number(no)), n]));
    for (const l of sec.brctl.slice(1)) {
      const [no, mac, local] = l.split(/\s+/);
      if (local === "no" && isMac(normMac(mac)) && byNo[String(Number(no))]) seen.set(normMac(mac), { iface: byNo[String(Number(no))], vlan: null });
    }
  }
  return seen;
}

async function collect(col) {
  const text = await run(col);
  if (text.includes(MARKER)) throw new Error("NOT LOCKED: this key gets a full shell on the router, so netmap won't use it. Run step 3 of the setup commands (the sshd lock)");
  if (!/== fdb/.test(text)) throw new Error("the key works but the router didn't run netmap-read: check /config/scripts/netmap-read and the lock (step 3)");
  const seen = parse(text);
  if (!seen.size) throw new Error("netmap-read ran but found no MACs on switch0");
  return { probes: { mactable: "ok" }, clients: [...seen].map(([mac, s]) => ({ mac, via: "fdb", iface: s.iface, detail: { vlan: s.vlan, source: "edgeos" } })) };
}

// The commands to paste on the router: the script, the user with netmap's public key, then the sshd lock.
function setupText(col) {
  const pub = publicKey(col.password);
  const user = col.username || "netmap-ssh";
  const script = fs.readFileSync(SCRIPT, "utf8").trimEnd();
  const lock = fs.readFileSync(LOCK, "utf8").trimEnd().replace(/^USER_NAME=.*$/m, `USER_NAME=${user}`);
  return `# 1. On the router, logged in as an admin (e.g. ubnt), NOT in configure mode: install the read-only script
sudo mkdir -p /config/scripts/post-config.d
sudo tee /config/scripts/netmap-read > /dev/null <<'NETMAP_EOF'
${script}
NETMAP_EOF
sudo chmod 755 /config/scripts/netmap-read

# 2. A login for netmap: admin level (EdgeOS gives other levels no shell), no usable password, netmap's key
configure
set system login user ${user} level admin
set system login user ${user} authentication encrypted-password '!'
set system login user ${user} authentication public-keys netmap type ${pub.type}
set system login user ${user} authentication public-keys netmap key ${pub.key}
commit ; save ; exit

# 3. Lock that login to the script (sshd ForceCommand). EdgeOS rewrites sshd_config at boot, so this is
#    installed in post-config.d to re-apply itself, and run once now. netmap refuses the key until it's locked.
sudo tee /config/scripts/post-config.d/netmap-ssh-lock > /dev/null <<'NETMAP_EOF'
${lock}
NETMAP_EOF
sudo chmod 755 /config/scripts/post-config.d/netmap-ssh-lock
sudo /config/scripts/post-config.d/netmap-ssh-lock
`;
}

module.exports = {
  label: "EdgeOS MAC table (SSH key)",
  generatesKey: true,
  defaults: { username: "netmap-ssh", port: 22 },
  probes: { mactable: ["MAC table (what is on each port)", "the netmap-read script and netmap's SSH key on the router (Polling → setup commands)"] },
  collect, generateKey, publicKey, setupText, parse
};
