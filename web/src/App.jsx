import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeApi } from "./api.js";
import NetworkMap from "./NetworkMap.jsx";
import { Icon, deviceIcon } from "./icons.jsx";

const api = makeApi("");

// What each probe needs on the device; shown when a probe fails. OpenWrt details in docs/openwrt-setup.md.
const OPENWRT_PROBES = {
  system: ["System info", "rpcd (built in); ACL: system board/info"],
  interfaces: ["Interfaces", "ACL: network.interface dump"],
  devices: ["Ports and bridges", "ACL: network.device status"],
  wifi: ["Wi-Fi clients", "package rpcd-mod-iwinfo; ACL: iwinfo devices/info/assoclist"],
  fdb: ["Bridge table (what is on each port)", "package ip-bridge + /usr/libexec/netmap/fdb script; ACL: file exec on it"],
  lldp: ["LLDP neighbours (cabling)", "package lldpd + /usr/libexec/netmap/lldp script; ACL: file exec on it"],
  switch: ["Switch-chip jacks (link, speed and traffic per jack)", "the swconfig helper: click Update on the device in this panel"],
  dhcp: ["DHCP leases (used for names only)", "luci-base (luci-rpc); ACL: luci-rpc getDHCPLeases. Only the DHCP server has these"],
  hosts: ["Host names (used for names only)", "luci-base (luci-rpc); ACL: luci-rpc getHostHints"],
  arp: ["ARP table", "package rpcd-mod-file; ACL: file read /proc/net/arp"]
};
const SNMP_PROBES = {
  system: ["System info", "SNMP v2c turned on, with this community allowed to read"],
  ports: ["Ports", "IF-MIB (ifTable, ifXTable)"],
  addresses: ["IP addresses", "IP-MIB (ipAddrTable)"],
  fdb: ["MAC table (what is on each port)", "Q-BRIDGE-MIB or BRIDGE-MIB"],
  lldp: ["LLDP neighbours (cabling)", "LLDP turned on, LLDP-MIB readable"],
  arp: ["ARP table", "IP-MIB (ipNetToMediaTable); a plain switch may have few entries"],
  poe: ["PoE power", "POWER-ETHERNET-MIB (PoE switches only)"]
};
const PROXMOX_PROBES = {
  cluster: ["Cluster and node list", "a PVE-realm login (user@pve) that can read /cluster"],
  node: ["Node status", "Sys.Audit on the node (the PVEAuditor role on / covers it)"],
  network: ["Bridges and interfaces", "Sys.Audit on the node"],
  guests: ["VMs and containers (MACs, bridges)", "VM.Audit (the PVEAuditor role on / covers it)"]
};
const TPLINK_PROBES = {
  system: ["System info (name, model, firmware, MAC, IP)", "the web login (only one session at a time: log out of the switch's page in your browser)"],
  ports: ["Ports and link speeds", "the Port Setting page"],
  traffic: ["Traffic (packet counters)", "the Port Statistics page"],
  mactable: ["MAC address table (patched firmware)", "the custom firmware from https://github.com/YurkoWasHere/TL-SG108E-V5-custom-firmware (TL-SG108E v5)"],
  vlans: ["802.1Q VLANs", "the 802.1Q VLAN page"]
};
const PROBES = { openwrt: OPENWRT_PROBES, snmp: SNMP_PROBES, proxmox: PROXMOX_PROBES, tplink: TPLINK_PROBES };

// Collectors: extra data sources next to a device's driver (server/collectors). Their probes are "<kind>:<name>".
const COLLECTORS = {
  "netgear-web": {
    label: "Netgear web UI (PoE per port)",
    hint: "Logs in to the switch's web page (read-only) for per-port PoE watts, volts and mA, which its SNMP doesn't report. It keeps one web session open, so you may see netmap in the switch's session list.",
    defaults: { https: true, username: "admin" },
    probes: {
      poePorts: ["PoE per port (watts, volts, mA, class)", "the switch's web login"],
      poeTotal: ["PoE total and budget", "the switch's web login"]
    }
  }
};

const ago = (iso) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const fmtUptime = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : `${h}h ${m}m`; };

const EMPTY = { name: "", host: "", port: "", https: false, verify_tls: false, username: "monitor", password: "" };

// A native <dialog>: focus trap, Esc to close and the backdrop come with it.
function Modal({ open, onClose, title, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="nm-modal" onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {/* stays mounted while closed, so a running setup keeps polling */}
      <div className="nm-modal-body">
        <div className="nm-modal-head">
          <h2>{title}</h2>
          <button type="button" className="nm-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

// Automatic setup: the server logs in as root once, installs what netmap needs and adds the device
// with a read-only login. The form gives way to the device's install output while it runs.
// preset: re-run the setup for a device already on the map ({ deviceId, name, host, port, https }): only the admin
// password is asked for, and the device keeps its place with its new read-only login.
function SetupForm({ onAdded, onClose, onJobState, preset }) {
  const [f, setF] = useState({ name: preset ? preset.name : "", host: preset ? preset.host : "", ssh_port: "22", port: preset && preset.port ? String(preset.port) : "",
    https: !!(preset && preset.https), root_user: "root", root_password: "" });
  const [job, setJob] = useState(null);
  const [err, setErr] = useState(null);
  const logRef = useRef(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const running = job && job.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const j = await api.setupStatus(job.id);
        setJob(j);
        if (j.state === "done") onAdded(j.deviceId);
      } catch (e) { setErr(e.message); }
    }, 1500);
    return () => clearInterval(t);
  }, [running, job && job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onJobState && onJobState(job ? job.state : null); }, [job && job.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // keep the newest output in view
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [job && job.log.length]);
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    try { setJob(await api.startSetup({ ...f, port: f.port ? Number(f.port) : null, ssh_port: Number(f.ssh_port) || 22, device_id: preset ? preset.deviceId : undefined })); setF({ ...f, root_password: "" }); }
    catch (x) { setErr(x.message); }
  };

  if (job) {
    const head = { running: `${preset ? "Updating" : "Setting up"} ${f.name}…`, done: preset ? `${f.name} is updated` : `${f.name} is on the map`, error: `Setup of ${f.name} stopped` }[job.state];
    return (
      <div className="nm-setup">
        <div className={"nm-setup-status is-" + job.state}>
          {job.state === "running" && <span className="nm-spin" aria-hidden="true" />}
          <div>
            <strong>{head}</strong>
            <div className="hint">{job.state === "running" ? `${f.host} · installing packages can take a few minutes. You can close this; it keeps going.` : job.state === "error" ? job.error : `${f.host} · read-only login created and the device probed.`}</div>
          </div>
        </div>
        <pre ref={logRef} className={"nm-log is-" + job.state} aria-live="polite">{job.log.join("\n")}</pre>
        {err && <p className="nm-error">{err}</p>}
        <div className="row nm-modal-actions">
          {job.state === "done" && <button type="button" className="btn" onClick={onClose}>Show on map</button>}
          {job.state === "error" && <button type="button" className="btn" onClick={() => setJob(null)}>Back to form</button>}
          {job.state !== "done" && <button type="button" className="btn quiet" onClick={onClose}>{running ? "Close (keeps running)" : "Close"}</button>}
        </div>
      </div>
    );
  }

  return (
    <form className="nm-form" onSubmit={submit}>
      <div className="nm-grid2">
        {!preset && <label>Name<input value={f.name} onChange={set("name")} placeholder="Office AP" required autoFocus /></label>}
        {!preset && <label>Host / IP<input value={f.host} onChange={set("host")} placeholder="192.168.1.2" required /></label>}
        <label>Admin user<input value={f.root_user} onChange={set("root_user")} autoComplete="off" /></label>
        <label>Admin password<input type="password" value={f.root_password} onChange={set("root_password")} autoComplete="off" required /></label>
      </div>
      <details className="nm-more">
        <summary>Ports</summary>
        <div className="row">
          <label>SSH port<input value={f.ssh_port} onChange={set("ssh_port")} inputMode="numeric" /></label>
          <label>Web port<input value={f.port} onChange={set("port")} placeholder={f.https ? "443" : "80"} inputMode="numeric" /></label>
          <label className="chk"><input type="checkbox" checked={f.https} onChange={set("https")} /> HTTPS</label>
        </div>
      </details>
      <p className="hint">The admin password is used once, over SSH (or the web API if SSH is closed), to install a few packages and create a read-only <code>monitor</code> login. It isn't saved. The device needs internet access to download packages.</p>
      {err && <p className="nm-error">{err}</p>}
      <div className="row nm-modal-actions">
        <button className="btn">Set up and add</button>
        <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

// Pick what something is plugged into: a device (or Automatic) and the port on it.
function PluggedIntoEditor({ devices, device, port, autoLabel = "Automatic (from the switches)", onSave }) {
  const [d, setD] = useState(device ? String(device) : "");
  const [p, setP] = useState(port || "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setD(device ? String(device) : ""); setP(port || ""); }, [device, port]);
  const dirty = d !== (device ? String(device) : "") || p !== (port || "");
  return (
    <form className="nm-form nm-plug" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(d ? Number(d) : null, d ? p : ""); } finally { setBusy(false); } }}>
      <div className="row">
        <label>Plugged into
          <select value={d} onChange={(e) => setD(e.target.value)}>
            <option value="">{autoLabel}</option>
            {devices.map((x) => <option key={x.deviceId} value={x.deviceId}>{x.name}</option>)}
          </select>
        </label>
        <label style={{ flex: "0 0 90px" }}>Port<input value={p} onChange={(e) => setP(e.target.value)} disabled={!d} placeholder={d ? "e.g. 3" : ""} /></label>
        <button className="btn" disabled={busy || !dirty}>Save</button>
      </div>
    </form>
  );
}

// An unmanaged (dumb) switch: never polled; you say what it's plugged into.
function UnmanagedForm({ devices, onDone, onCancel }) {
  const [f, setF] = useState({ name: "", mac: "", plugged_into: "", plugged_port: "", notes: "" });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    try { onDone(await api.addDevice({ driver: "none", name: f.name, host: "", notes: f.notes, mac: f.mac, plugged_into: f.plugged_into ? Number(f.plugged_into) : null, plugged_port: f.plugged_port })); }
    catch (x) { setErr(x.message); }
  };
  return (
    <form className="nm-form" onSubmit={submit}>
      <label>Name<input value={f.name} onChange={set("name")} placeholder="Desk switch" required /></label>
      <div className="row">
        <label>Plugged into
          <select value={f.plugged_into} onChange={set("plugged_into")}>
            <option value="">Nothing yet</option>
            {devices.map((x) => <option key={x.deviceId} value={x.deviceId}>{x.name}</option>)}
          </select>
        </label>
        <label style={{ flex: "0 0 90px" }}>Port<input value={f.plugged_port} onChange={set("plugged_port")} disabled={!f.plugged_into} placeholder="e.g. 14" /></label>
      </div>
      <label>MAC address (optional)<input value={f.mac} onChange={set("mac")} placeholder="00:11:22:33:44:55" className="mono" /></label>
      <label>Notes<input value={f.notes} onChange={set("notes")} placeholder="optional, e.g. under the desk upstairs" /></label>
      <p className="hint">It isn't probed. With a MAC that your managed switches see, it's placed on the right port automatically
        (leave <b>Plugged into</b> empty); anything else only seen on that port is then drawn behind it. Without one, say what it's plugged into
        here, and move clients onto it from their panels.</p>
      {err && <p className="nm-error">{err}</p>}
      <div className="row nm-modal-actions">
        <button className="btn">Add</button>
        <button type="button" className="btn quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// A Proxmox VE node: log in with a PVE-realm account, look up the cluster's nodes, pick the one this device is.
function ProxmoxForm({ onDone, onCancel }) {
  const [f, setF] = useState({ name: "", host: "", port: "", username: "", password: "", node: "" });
  const [nodes, setNodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const conn = () => ({ host: f.host, port: f.port ? Number(f.port) : 8006, username: f.username, password: f.password });
  const lookup = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.proxmoxNodes(conn());
      setNodes(r);
      const first = r.nodes.find((n) => n.ip === f.host) || r.nodes[0];
      if (first && !f.node) setF((x) => ({ ...x, node: first.name, name: x.name || first.name }));
    } catch (x) { setErr(x.message); setNodes(null); } finally { setBusy(false); }
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!f.node) { lookup(); return; }
    setBusy(true); setErr(null);
    try { onDone(await api.addDevice({ driver: "proxmox", ...conn(), node: f.node, name: f.name || f.node })); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <form className="nm-form" onSubmit={submit}>
      <div className="row">
        <label>Host / IP of any node<input value={f.host} onChange={set("host")} placeholder="192.168.1.10" required /></label>
        <label style={{ flex: "0 0 90px" }}>Port<input value={f.port} onChange={set("port")} placeholder="8006" inputMode="numeric" /></label>
      </div>
      <div className="nm-grid2">
        <label>User (PVE realm)<input value={f.username} onChange={set("username")} placeholder="monitor@pve" autoComplete="off" required /></label>
        <label>Password<input type="password" value={f.password} onChange={set("password")} autoComplete="off" required /></label>
      </div>
      <div className="row">
        <label>Node
          <select value={f.node} onChange={(e) => setF({ ...f, node: e.target.value, name: !f.name || (nodes && nodes.nodes.some((n) => n.name === f.name)) ? e.target.value : f.name })} disabled={!nodes}>
            {!nodes && <option value="">Look up the nodes first</option>}
            {nodes && nodes.nodes.map((n) => <option key={n.name} value={n.name}>{n.name}{n.ip ? ` (${n.ip})` : ""}{n.online ? "" : " · offline"}</option>)}
          </select>
        </label>
        <button type="button" className="btn quiet" onClick={lookup} disabled={busy || !f.host || !f.username || !f.password}>{busy && !nodes ? "Logging in…" : "Look up nodes"}</button>
      </div>
      {nodes && <p className="hint">Cluster {nodes.cluster || "(no name)"}: {nodes.nodes.length} node{nodes.nodes.length === 1 ? "" : "s"}. Add each node you want on the map as its own device; they share one login and one read of the cluster.</p>}
      <label>Name on the map<input value={f.name} onChange={set("name")} placeholder={f.node || "KVM1"} /></label>
      <p className="hint">Use a PVE-realm account (<code>user@pve</code>), not PAM; the <b>PVEAuditor</b> role on <code>/</code> is enough, read-only. The password is stored so netmap can poll.</p>
      {err && <p className="nm-error">{err}</p>}
      <div className="row nm-modal-actions">
        <button className="btn" disabled={busy}>{busy && nodes ? "Adding…" : f.node ? "Add and probe" : "Look up nodes"}</button>
        <button type="button" className="btn quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// Kinds of device you can add; picked from the dropdown at the top of the dialog.
const ADD_MODES = [
  { id: "setup", group: "OpenWrt", label: "OpenWrt router or AP: set it up for me", hint: "Give it the admin password; netmap installs what it needs and creates a read-only login." },
  { id: "manual", group: "OpenWrt", label: "OpenWrt router or AP: already set up", hint: "The device already has a read-only rpcd login (see docs/openwrt-setup.md)." },
  { id: "snmp", group: "SNMP", label: "SNMP switch or other device (v2c)", hint: "Managed switches and anything with standard MIBs. Needs a read-only community." },
  { id: "tplink", group: "TP-Link", label: "TP-Link Easy Smart switch (TL-SG105E / 108E / 116E …)", hint: "Read from its web page with the admin login: ports, link speeds and packet counts. These switches have no MAC table, so clients behind one are placed by its port." },
  { id: "proxmox", group: "Proxmox VE", label: "Proxmox VE node", hint: "Log in with a PVE-realm account (user@pve) and pick which node of the cluster this is. Its VMs and containers hang off it." },
  { id: "unmanaged", group: "Not probed", label: "Unmanaged switch (just a box on the map)", hint: "A dumb switch or anything else netmap can't ask. You say what it's plugged into." }
];

function AddDeviceModal({ open, onClose, onAdded, onJobState, devices }) {
  const [mode, setMode] = useState("setup");
  const [jobState, setJobState] = useState(null);
  const current = ADD_MODES.find((m) => m.id === mode);
  return (
    <Modal open={open} onClose={onClose} title="Add a device">
      {/* hidden while a setup shows its progress: switching type would drop it */}
      {!jobState && (
        <label className="nm-type">Device type
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {[...new Set(ADD_MODES.map((m) => m.group))].map((g) => (
              <optgroup key={g} label={g}>
                {ADD_MODES.filter((m) => m.group === g).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </optgroup>
            ))}
          </select>
          <span className="hint">{current.hint}</span>
        </label>
      )}
      {mode === "setup"
        ? <SetupForm onAdded={onAdded} onClose={onClose} onJobState={(st) => { setJobState(st); onJobState && onJobState(st); }} />
        : mode === "proxmox"
          ? <ProxmoxForm onDone={(r) => { if (r && r.device) onAdded(r.device.id); onClose(); }} onCancel={onClose} />
        : mode === "unmanaged"
          ? <UnmanagedForm devices={devices} onDone={(r) => { if (r && r.device) onAdded(r.device.id); onClose(); }} onCancel={onClose} />
          : <DeviceForm key={mode} driver={mode === "snmp" ? "snmp" : mode === "tplink" ? "tplink" : "openwrt"} onDone={(r) => { if (r && r.device) onAdded(r.device.id); onClose(); }} onCancel={onClose} />}
    </Modal>
  );
}

// Add or edit a device whose login already exists. `driver` picks the fields: OpenWrt (rpcd user) or SNMP (community).
function DeviceForm({ initial, driver: newDriver = "openwrt", onDone, onCancel }) {
  const editing = !!initial;
  const driver = editing ? initial.driver : newDriver;
  const snmp = driver === "snmp";
  const [f, setF] = useState(initial ? { ...EMPTY, ...initial, port: initial.port || "", password: "" } : { ...EMPTY, driver, username: snmp ? "" : driver === "tplink" ? "admin" : EMPTY.username });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = { ...f, port: f.port ? Number(f.port) : null };
      const r = editing ? await api.updateDevice(initial.id, body) : await api.addDevice(body);
      if (editing) await api.pollDevice(initial.id);
      onDone(r);
      if (!editing) setF({ ...EMPTY, driver, username: snmp ? "" : EMPTY.username });
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <form className="nm-form" onSubmit={submit}>
      <label>Name<input value={f.name} onChange={set("name")} placeholder={snmp ? "Core switch" : "Main router"} required /></label>
      {driver === "tplink" ? (<>
        <div className="row">
          <label>Host / IP<input value={f.host} onChange={set("host")} placeholder="192.168.0.1" required /></label>
          <label style={{ flex: "0 0 90px" }}>Port<input value={f.port} onChange={set("port")} placeholder="80" inputMode="numeric" /></label>
        </div>
        <div className="nm-grid2">
          <label>User<input value={f.username} onChange={set("username")} placeholder="admin" autoComplete="off" /></label>
          <label>Password<input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" placeholder={editing ? "unchanged" : ""} required={!editing} /></label>
        </div>
        <p className="hint">The switch allows one web login at a time. netmap stays logged in (logging out would end every session on the switch), so if you log in to its page in a browser, pause polling while you do.</p>
      </>) : driver === "proxmox" ? (<>
        <div className="row">
          <label>Host / IP<input value={f.host} onChange={set("host")} required /></label>
          <label style={{ flex: "0 0 90px" }}>Port<input value={f.port} onChange={set("port")} placeholder="8006" inputMode="numeric" /></label>
        </div>
        <label>User (PVE realm)<input value={f.username} onChange={set("username")} placeholder="monitor@pve" autoComplete="off" /></label>
        <label>Password<input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" placeholder="unchanged" /></label>
        <label>Node<input value={f.node || ""} onChange={set("node")} required /></label>
      </>) : driver === "none" ? (<>
        <label>MAC address (optional)<input value={f.mac || ""} onChange={set("mac")} placeholder="00:11:22:33:44:55" className="mono" /></label>
        <label>Notes<input value={f.notes || ""} onChange={set("notes")} /></label>
      </>) : (<>
      <label>Host / IP<input value={f.host} onChange={set("host")} placeholder="192.168.1.1" required /></label>
      {snmp ? (<>
        <div className="row">
          <label>Community<input type="password" value={f.password} onChange={set("password")} autoComplete="off" placeholder={editing ? "unchanged" : "read-only community"} required={!editing} /></label>
          <label style={{ flex: "0 0 90px" }}>Port<input value={f.port} onChange={set("port")} placeholder="161" inputMode="numeric" /></label>
        </div>
        <p className="hint">SNMP v2c, read-only. Use a read-only community; it's stored so netmap can poll, and never shown again.</p>
      </>) : (<>
      <div className="row">
        <label>Port<input value={f.port} onChange={set("port")} placeholder={f.https ? "443" : "80"} inputMode="numeric" /></label>
        <label className="chk"><input type="checkbox" checked={f.https} onChange={set("https")} /> HTTPS</label>
      </div>
      {f.https && <label className="chk"><input type="checkbox" checked={f.verify_tls} onChange={set("verify_tls")} /> Verify certificate</label>}
      <label>rpcd user<input value={f.username} onChange={set("username")} autoComplete="off" /></label>
      <label>Password<input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" placeholder={editing ? "unchanged" : ""} /></label>
      </>)}
      </>)}
      {err && <p className="nm-error">{err}</p>}
      <div className="row">
        <button className="btn" disabled={busy}>{busy ? "Probing…" : editing ? "Save and poll" : "Add and probe"}</button>
        {onCancel && <button type="button" className="btn quiet" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function Probes({ probes, driver }) {
  const labels = { ...(PROBES[driver] || OPENWRT_PROBES) };
  for (const [kind, c] of Object.entries(COLLECTORS)) for (const [k, v] of Object.entries(c.probes)) labels[`${kind}:${k}`] = v;
  const keys = Object.keys(labels);
  if (!probes || !Object.keys(probes).length) return null;
  return (
    <ul className="nm-probes">
      {keys.map((k) => {
        const v = probes[k];
        if (v == null) return null;
        return (
          <li key={k} className={v === "ok" ? "ok" : "bad"}>
            <span className="mark" aria-hidden="true">{v === "ok" ? "✓" : "✕"}</span>
            <div>
              <div>{labels[k][0]}</div>
              {v !== "ok" && <div className="hint">{v}<br />Needs: {labels[k][1]}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Power the switch delivers to PoE devices, and the energy recorded from it (Wh / kWh).
const fmtWh = (wh) => (wh == null ? "—" : wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh.toFixed(wh >= 100 ? 0 : 1)} Wh`);
// GigabitEthernet5 -> Gi5, as switches abbreviate them on their own CLIs
const shortPort = (n) => String(n).replace(/^TenGigabitEthernet/i, "Te").replace(/^GigabitEthernet/i, "Gi").replace(/^FastEthernet/i, "Fa");
function PoeSection({ poe, ports: all = [] }) {
  // ports with measured power (from a collector such as the Netgear web UI)
  const ports = all.filter((p) => p.poe && p.poe.mW != null && p.poe.status === "delivering");
  const pct = poe.budgetW ? Math.round((poe.usedW / poe.budgetW) * 100) : null;
  return (
    <>
      <h3 className="first">PoE power</h3>
      <dl className="facts">
        <dt>Now</dt><dd>{poe.usedW != null ? `${poe.usedW} W` : "—"}{poe.budgetW ? ` of ${poe.budgetW} W budget (${pct}%)` : ""}</dd>
        <dt>Today</dt><dd>{fmtWh(poe.todayWh)}</dd>
        <dt>Last 7 days</dt><dd>{fmtWh(poe.weekWh)}</dd>
        <dt>Total</dt><dd>{fmtWh(poe.totalWh)}{poe.since ? <span className="hint"> since {poe.since}</span> : ""}</dd>
      </dl>
      <p className="hint" style={{ marginTop: 4 }}>Power delivered to PoE devices (not the switch's own use), sampled every poll{ports.length ? "" : "; the switch reports a total, not per port"}.</p>
      {ports.length > 0 && <table><tbody>{ports.map((p) => (
        <tr key={p.name} className="nowrap"><td className="mono" title={p.name}>{shortPort(p.name)}</td><td><b>{(p.poe.mW / 1000).toFixed(1)} W</b></td><td className="mono">{p.poe.volts} V · {p.poe.mA} mA</td><td>{p.poe.cls != null ? `cl. ${p.poe.cls}` : ""}</td></tr>
      ))}</tbody></table>}
    </>
  );
}

// A port's traffic for the Ports table: bits/s, or packets/s on switches that only count packets.
const short = (n, unit) => (n == null ? "" : n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`) + (n == null ? "" : unit);
const portRateText = (p) => (p.rxBps != null || p.txBps != null ? `↓${short(p.txBps, "")} ↑${short(p.rxBps, "")}`
  : p.rxPps != null || p.txPps != null ? `↓${short(p.txPps, "")} ↑${short(p.rxPps, "")} p/s` : "");

// The device's own web interface, for the "Open web page" link.
function webUrl(node, device) {
  const dev = device || {};
  const withPort = (scheme, host, port, def) => `${scheme}://${host}${port && Number(port) !== def ? ":" + port : ""}/`;
  if (!node.host) return null;
  // Proxmox: any node's web UI manages the whole cluster, so open the one netmap already reaches (a node's own
  // port can be firewalled), straight to this node's page
  if (node.driver === "proxmox") return `${withPort("https", dev.host || node.apiHost || node.host, dev.port || 8006, 0)}#v1:0:=node%2F${encodeURIComponent(dev.node || node.proxmoxNode || node.name)}`;
  if (node.driver === "openwrt") return dev.https ? withPort("https", dev.host || node.host, dev.port, 443) : withPort("http", dev.host || node.host, dev.port, 80);
  if (node.driver === "tplink") return withPort("http", node.host, dev.port, 80);
  // SNMP's port is the SNMP port, not the web one; switches that want HTTPS redirect there themselves
  if (node.driver === "snmp" || node.driver === "none") return `http://${node.host}/`;
  return null;
}

// PoE class -> the most a powered device may draw at its end of the cable (IEEE 802.3af/at)
const POE_CLASS_W = { 0: 12.95, 1: 3.84, 2: 6.49, 3: 12.95, 4: 25.5 };

// "until 14:30", "until Tue 09:00", or "until you resume" for a pause
const pausedText = (iso) => {
  if (!iso) return "";
  if (iso.startsWith("9999")) return "until you resume";
  const d = new Date(iso), soon = d - Date.now() < 20 * 3600000;
  return "until " + d.toLocaleString(undefined, soon ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
};

// Pause polling for a while (or until resumed); while paused the device keeps its last data, without traffic.
function PauseControl({ node, onChanged }) {
  const [busy, setBusy] = useState(false);
  const set = async (minutes) => { setBusy(true); try { await api.pauseDevice(node.deviceId, minutes); } finally { setBusy(false); onChanged(); } };
  if (node.pausedUntil) {
    return (
      <div className="nm-paused">
        <span>⏸ Polling paused {pausedText(node.pausedUntil)}</span>
        <button className="btn sm" disabled={busy} onClick={() => set(0)}>Resume</button>
      </div>
    );
  }
  return (
    <label className="nm-pause-pick">Pause polling
      <select value="" disabled={busy} onChange={(e) => e.target.value && set(Number(e.target.value))}>
        <option value="">Not paused</option>
        <option value="15">for 15 minutes</option>
        <option value="60">for 1 hour</option>
        <option value="1440">for 1 day</option>
        <option value="-1">until I resume</option>
      </select>
    </label>
  );
}

const VIA = { fdb: "from the MAC tables", lldp: "from LLDP", manual: "set by you", role: "core switch, placed under the gateway",
  behind: "behind the unmanaged switch on that port", remembered: "remembered" };

// The device's role shapes the map's hierarchy; it saves as soon as it's picked.
const ROLES = {
  auto: { label: "Automatic", patch: { is_root: false, is_core: false } },
  gateway: { label: "Internet gateway", patch: { is_root: true, is_core: false } },
  core: { label: "Core switch", patch: { is_root: false, is_core: true } }
};
function Roles({ node, onChanged }) {
  const [busy, setBusy] = useState(false);
  const value = node.rootMarked ? "gateway" : node.isCore ? "core" : "auto";
  const save = async (v) => { setBusy(true); try { await api.updateDevice(node.deviceId, ROLES[v].patch); } finally { setBusy(false); onChanged(); } };
  const hint = value === "gateway" ? "Top of the map, with the Internet above its WAN port. Only one device can be the gateway."
    : value === "core" ? "On the row right under the gateway; other switches and clients go below."
    : node.isRoot ? "Placed at the top automatically, because it has the WAN."
    : "Placed wherever the MAC tables and LLDP say it's plugged in.";
  return (
    <label className="nm-role-pick">Role on the map
      <select value={value} disabled={busy} onChange={(e) => save(e.target.value)}>
        {Object.entries(ROLES).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
      </select>
      <span className="hint">{hint}</span>
    </label>
  );
}

// Extra data sources for a device, read after its driver on every poll (e.g. a switch's web UI for PoE watts).
function Collectors({ node, device, onChanged }) {
  const [list, setList] = useState([]);
  const [adding, setAdding] = useState(null); // form values, or null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => api.collectors(node.deviceId).then(setList).catch(() => setList([]));
  useEffect(() => { load(); setAdding(null); setErr(""); }, [node.deviceId]);
  const start = (kind) => setAdding({ kind, host: "", username: COLLECTORS[kind].defaults.username || "", password: "", https: !!COLLECTORS[kind].defaults.https });
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const r = await api.addCollector(node.deviceId, adding);
      setAdding(null);
      if (r.poll && !r.poll.ok) setErr(`Added, but the poll failed: ${r.poll.error}`);
    } catch (x) { setErr(x.message); } finally { setBusy(false); load(); onChanged(); }
  };
  const act = async (fn) => { setBusy(true); try { await fn(); } catch (x) { setErr(x.message); } finally { setBusy(false); load(); onChanged(); } };
  return (
    <div className="nm-collectors">
      <h3>Extra data sources</h3>
      {list.length === 0 && !adding && <p className="hint" style={{ margin: "0 0 6px" }}>Only the {node.driver} driver reads this device.</p>}
      {list.map((c) => (
        <div key={c.id} className="nm-collector">
          <div>
            <div>{(COLLECTORS[c.kind] || {}).label || c.kind}{!c.enabled && <span className="hint"> (off)</span>}</div>
            <div className="hint mono">{c.username}@{c.host || (device && device.host) || node.host}{c.https ? " (https)" : ""}</div>
          </div>
          <div className="row">
            <button className="btn sm quiet" disabled={busy} onClick={() => act(() => api.updateCollector(c.id, { enabled: !c.enabled }))}>{c.enabled ? "Turn off" : "Turn on"}</button>
            <button className="btn sm quiet" disabled={busy} onClick={() => act(() => api.deleteCollector(c.id))}>Remove</button>
          </div>
        </div>
      ))}
      {adding ? (
        <form className="nm-form" onSubmit={save}>
          <p className="hint" style={{ margin: 0 }}>{COLLECTORS[adding.kind].hint}</p>
          <label>Address<input value={adding.host} placeholder={(device && device.host) || node.host} onChange={(e) => setAdding({ ...adding, host: e.target.value })} /></label>
          <label>User<input value={adding.username} onChange={(e) => setAdding({ ...adding, username: e.target.value })} /></label>
          <label>Password<input type="password" autoComplete="new-password" value={adding.password} onChange={(e) => setAdding({ ...adding, password: e.target.value })} /></label>
          <label className="chk"><input type="checkbox" checked={adding.https} onChange={(e) => setAdding({ ...adding, https: e.target.checked })} /> HTTPS</label>
          <div className="row">
            <button className="btn" disabled={busy || !adding.password}>{busy ? "Testing…" : "Add and poll"}</button>
            <button type="button" className="btn quiet" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <label className="nm-pause-pick">Add a data source
          <select value="" onChange={(e) => e.target.value && start(e.target.value)}>
            <option value="">Choose…</option>
            {Object.entries(COLLECTORS).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
          </select>
        </label>
      )}
      {err && <p className="nm-error">{err}</p>}
    </div>
  );
}

// Vertical tabs down the left of the details panel; the name header stays above them.
const TAB_ICON = {
  status: <><path d="M3 12h4l3-7 4 14 3-7h4" /></>,
  ports: <><rect x="3" y="7" width="18" height="10" rx="1.5" /><path d="M6.5 10.5h3v3h-3zM14.5 10.5h3v3h-3z" /></>,
  vms: <><path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z" /><path d="M4 7.2l8 4.4 8-4.4M12 11.6v9.6" /></>,
  power: <><path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" /></>,
  checks: <><path d="M4 6.5l1.8 1.8L9 5M4 12.5l1.8 1.8L9 11M4 18.5l1.8 1.8L9 17" /><path d="M12 7h8M12 13h8M12 19h8" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>
};
function DetailTabs({ tabs, tab, onTab, children }) {
  return (
    <div className="nm-vtabs">
      <nav role="tablist" aria-orientation="vertical">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} onClick={() => onTab(t.id)} title={t.title || t.label}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{TAB_ICON[t.id]}</svg>
            <span>{t.label}</span>
            {t.alert ? <i className="alert" aria-label="needs attention" /> : null}
          </button>
        ))}
      </nav>
      <div className="nm-vtab-body" role="tabpanel">{children}</div>
    </div>
  );
}

// "Plugged into" as a sentence, for the Status tab (it's changed in Settings).
function pluggedText(node, nameOf, unmanaged, device) {
  if (node.isRoot) return `The internet (top of the map${node.rootMarked ? "" : ", picked because it has the WAN"})`;
  if (node.realParent) return <>{nameOf(Number(node.realParent.slice(1)))} {node.realPort ? `port ${node.realPort}` : ""}{node.realUplinkPort ? ` ↔ ${node.realUplinkPort}` : ""} <span className="hint">({VIA[node.realVia] || node.realVia}; drawn on the core row because of its role)</span></>;
  if (node.parentVia === "role") return <span className="hint">Not worked out yet; drawn on the core row because of its role</span>;
  if (node.parent) return <>{nameOf(Number(node.parent.slice(1)))} {node.parentPort ? `port ${node.parentPort}` : ""}{node.uplinkPort ? ` ↔ ${node.uplinkPort}` : ""} <span className="hint">({node.parentVia === "remembered" ? `not seen right now; last confirmed ${ago(node.parentSeenAt)} from ${VIA[node.parentSeenVia] || node.parentSeenVia}` : VIA[node.parentVia] || node.parentVia})</span></>;
  return <span className="hint">{unmanaged ? ((device && device.mac) ? "Not seen yet: no switch has its MAC in its table" : "Nothing yet: set it in Settings, or give it a MAC") : "Not worked out yet: no other device sees it in its MAC table"}</span>;
}

const physicalPorts = (node) => node.ports.filter((p) => p.type !== "bridge" && !/^(lo|ifb|gre|teql|sit|ip6tnl|erspan)/.test(p.name));

function DeviceDetail({ node, device, onChanged, onSelect, nameOf, devices, clients, tab, onTab }) {
  const [updating, setUpdating] = useState(false);
  const [polling, setPolling] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setConfirmDel(false); setSaved(false); }, [node.id]);
  const s = node.system || {};
  const poll = async () => { setPolling(true); try { await api.pollDevice(node.deviceId); } finally { setPolling(false); onChanged(); } };
  const ports = physicalPorts(node);
  const unmanaged = node.status === "unmanaged";
  const drawn = node.parentVia === "manual";
  const failing = Object.values(node.probes || {}).filter((v) => v !== "ok").length;
  const guests = node.guests || [];
  const tabs = [
    { id: "status", label: "Status" },
    !unmanaged && { id: "ports", label: "Ports", title: "Ports, Wi-Fi, networks and neighbours" },
    guests.length > 0 && { id: "vms", label: "VMs", title: "VMs and containers" },
    node.poe && { id: "power", label: "Power", title: "PoE power and energy" },
    !unmanaged && { id: "checks", label: "Checks", title: "What this device reports, probe by probe", alert: failing > 0 },
    { id: "settings", label: "Settings" }
  ].filter(Boolean);
  const cur = tabs.some((t) => t.id === tab) ? tab : "status";
  const linked = ports.filter((p) => p.carrier).length;
  const wifiClients = node.wifi.reduce((a, w) => a + (w.clients || 0), 0);
  const web = webUrl(node, device);

  return (
    <>
      <div className="nm-detail-head">
        <div>
          <div className="eyebrow">{unmanaged ? "Unmanaged switch" : s.model || node.driver}</div>
          <h2>{node.name}</h2>
          {web && <a className="nm-weblink" href={web} target="_blank" rel="noopener noreferrer" title={`Open ${web} in a new tab`}>Open web page ↗</a>}
        </div>
        <span className={"pill " + node.status}>{node.status === "ok" ? "Answering" : node.status === "error" ? "Not answering" : unmanaged ? "Not probed" : "Waiting"}</span>
      </div>
      <DetailTabs tabs={tabs} tab={cur} onTab={onTab}>
        {cur === "status" && <>
          {node.pausedUntil && <div className="nm-paused"><span>⏸ Polling paused {pausedText(node.pausedUntil)}</span>
            <button className="btn sm" onClick={async () => { await api.pauseDevice(node.deviceId, 0); onChanged(); }}>Resume</button></div>}
          {node.error && <p className="nm-error">{node.error}</p>}
          {!unmanaged && <div className="nm-stats">
            {ports.length > 0 && <button type="button" onClick={() => onTab("ports")}><b>{linked}/{ports.length}</b><span>ports linked</span></button>}
            <div><b>{clients}</b><span>clients here</span></div>
            {node.wifi.length > 0 && <button type="button" onClick={() => onTab("ports")}><b>{wifiClients}</b><span>on Wi-Fi</span></button>}
            {guests.length > 0 && <button type="button" onClick={() => onTab("vms")}><b>{guests.filter((g) => g.status === "running").length}/{guests.length}</b><span>VMs running</span></button>}
            {node.poe && node.poe.usedW != null && <button type="button" onClick={() => onTab("power")}><b>{node.poe.usedW} W</b><span>PoE now</span></button>}
          </div>}
          <dl className="facts">
            {!unmanaged && <><dt>Host</dt><dd className="mono">{node.host}</dd></>}
            {node.isRoot && node.wan && node.wan.length > 0 && <><dt>WAN</dt><dd className="mono">{node.wan.map((i) => `${i.name}${i.device ? " (" + i.device + ")" : ""} ${i.ipv4.join(", ")}`).join(" · ")}
              {node.upstream && node.upstream.length > 0 && <div className="hint">next hop {node.upstream.map((u) => [u.ip, u.hostname].filter(Boolean).join(" · ")).join(", ")}</div>}</dd></>}
            <dt>Role</dt><dd>{node.rootMarked ? "Internet gateway" : node.isCore ? "Core switch" : node.isRoot ? "Gateway (has the WAN)" : "Automatic"}</dd>
            <dt>Plugged into</dt><dd>{pluggedText(node, nameOf, unmanaged, device)}</dd>
            {unmanaged && <><dt>MAC</dt><dd className="mono">{(device && device.mac) || <span className="hint">none: placed only where you put it</span>}</dd></>}
            {unmanaged && device && device.mac && <><dt>IP</dt><dd>{node.macIp && node.macIp.ip
              ? <><span className="mono">{node.macIp.ip}</span> <span className="hint">(from {node.macIp.src}{node.macIp.hostname ? `, name ${node.macIp.hostname}` : ""})</span></>
              : <span className="hint">none recorded for this MAC</span>}</dd></>}
            {unmanaged && node.notes && <><dt>Notes</dt><dd>{node.notes}</dd></>}
            {s.hostname && <><dt>Hostname</dt><dd>{s.hostname}</dd></>}
            {s.release && <><dt>Firmware</dt><dd>{s.release}</dd></>}
            {s.uptime ? <><dt>Uptime</dt><dd>{fmtUptime(s.uptime)}</dd></> : null}
            {s.load && s.load.length ? <><dt>Load</dt><dd>{s.load.map((l) => l.toFixed(2)).join(" ")}</dd></> : null}
            {!unmanaged && <><dt>Last poll</dt><dd>{ago(node.polledAt)}{node.status === "error" && node.lastOkAt ? ` (last good ${ago(node.lastOkAt)})` : ""}</dd></>}
          </dl>
          {failing > 0 && <p className="hint nm-warnline"><button type="button" className="linkish" onClick={() => onTab("checks")}>{failing} check{failing === 1 ? "" : "s"} not working</button>: some details are missing.</p>}
          {!unmanaged && <div className="row" style={{ marginTop: 12 }}><button className="btn" onClick={poll} disabled={polling}>{polling ? "Polling…" : "Poll now"}</button></div>}
        </>}

        {cur === "ports" && <>
          {ports.length > 0 && (<>
            <h3 className="first">Ports</h3>
            <table><tbody>{ports.map((p) => (
              <tr key={p.name}><td className="mono">{p.name}</td><td><span className={"pill " + (p.carrier ? "ok" : "off")}>{p.carrier ? "link" : "no link"}</span></td><td>{p.speed && p.speed !== "-1" ? p.speed : ""}</td><td className={p.alias ? "" : "mono"}>{p.alias || p.bridge || ""}</td>
              <td className="mono nm-port-rate">{portRateText(p)}{p.poe && p.poe.status === "delivering" ? <span className="nm-poe-port" title={p.poe.mW != null ? `${p.poe.volts} V · ${p.poe.mA} mA; class ${p.poe.cls ?? "?"} (the most it may draw: ${POE_CLASS_W[p.poe.cls] ?? "?"} W)` : "PoE class: the most power the device may draw"}>
                ⚡ {p.poe.mW != null ? `${(p.poe.mW / 1000).toFixed(1)} W` : `class ${p.poe.cls} (≤${POE_CLASS_W[p.poe.cls] ?? "?"} W)`}</span> : null}</td></tr>
            ))}</tbody></table>
          </>)}
          {node.wifi.length > 0 && (<>
            <h3>Wi-Fi</h3>
            <table><tbody>{node.wifi.map((w) => (
              <tr key={w.iface}><td className="mono">{w.iface}</td><td>{w.ssid}</td><td>{w.channel ? `ch ${w.channel}` : ""}</td><td>{w.clients} client{w.clients === 1 ? "" : "s"}</td></tr>
            ))}</tbody></table>
          </>)}
          {node.interfaces.length > 0 && (<>
            <h3>Networks</h3>
            <table><tbody>{node.interfaces.map((i) => (
              <tr key={i.name}><td>{i.name}</td><td><span className={"pill " + (i.up ? "ok" : "off")}>{i.up ? "up" : "down"}</span></td><td className="mono">{i.ipv4.join(", ") || i.proto}</td><td className="mono">{i.device}</td></tr>
            ))}</tbody></table>
          </>)}
          {node.neighbors.length > 0 && (<>
            <h3>LLDP neighbours</h3>
            <table><tbody>{node.neighbors.map((n, i) => (
              <tr key={i}><td className="mono">{n.localPort}</td><td>{n.sysName || n.chassisId}</td><td className="mono">{n.portDescr || n.portId}</td></tr>
            ))}</tbody></table>
          </>)}
          {!ports.length && !node.wifi.length && !node.interfaces.length && <p className="hint">Nothing reported yet.</p>}
        </>}

        {cur === "vms" && <>
          {node.cluster && <p className="hint" style={{ margin: "0 0 6px" }}>Cluster {node.cluster.name}: {node.cluster.nodes.map((n) => n.name + (n.online ? "" : " (offline)")).join(", ")}</p>}
          <h3 className="first">VMs and containers ({guests.filter((g) => g.status === "running").length} running of {guests.length})</h3>
          <table><tbody>{guests.map((g) => (
            <tr key={g.vmid}>
              <td className="mono">{g.vmid}</td><td>{g.name}</td><td>{g.type === "lxc" ? "CT" : "VM"}</td>
              <td><span className={"pill " + (g.status === "running" ? "ok" : "off")}>{g.status}</span></td>
              <td className="mono">{g.nics.map((n) => n.bridge + (n.tag ? "." + n.tag : "")).join(", ")}</td>
            </tr>
          ))}</tbody></table>
        </>}

        {cur === "power" && <PoeSection poe={node.poe} ports={node.ports} />}

        {cur === "checks" && <>
          <h3 className="first">What this device reports</h3>
          <Probes probes={node.probes} driver={node.driver} />
          <dl className="facts" style={{ marginTop: 12 }}>
            <dt>Last poll</dt><dd>{ago(node.polledAt)}</dd>
            {node.lastOkAt && <><dt>Last good</dt><dd>{ago(node.lastOkAt)}</dd></>}
            <dt>Driver</dt><dd>{node.driver}</dd>
          </dl>
          <p className="hint" style={{ marginTop: 10 }}>Raw data from the last poll: <a href={`/api/devices/${node.deviceId}/raw`} target="_blank" rel="noopener noreferrer">JSON ↗</a></p>
          <div className="row" style={{ marginTop: 10 }}><button className="btn quiet" onClick={poll} disabled={polling}>{polling ? "Polling…" : "Poll now"}</button></div>
        </>}

        {cur === "settings" && <>
          <h3 className="first">Connection</h3>
          {device ? <DeviceForm key={device.id} initial={device} onDone={() => { setSaved(true); onChanged(); }} /> : <p className="hint">Loading…</p>}
          {saved && <p className="hint">Saved and polled.</p>}
          {node.driver === "openwrt" && <>
            <button className="btn quiet sm" style={{ marginTop: 8 }} onClick={() => setUpdating(true)}
              title="Re-run the setup on the device with its admin password: installs netmap's newest read-only helpers">Update helpers on the device…</button>
          </>}

          <h3>On the map</h3>
          <Roles node={node} onChanged={onChanged} />
          {!node.isRoot && <PluggedIntoEditor devices={devices.filter((d) => d.id !== node.id)} device={drawn ? Number(node.parent.slice(1)) : null} port={drawn ? node.parentPort : ""}
            autoLabel={unmanaged ? "Nothing" : "Automatic (from the switches)"}
            onSave={async (dev, port) => { await api.setUplink(node.deviceId, dev, port); onChanged(); }} />}

          {!unmanaged && <><h3>Polling</h3><PauseControl node={node} onChanged={onChanged} /></>}

          {!unmanaged && <Collectors node={node} device={device} onChanged={onChanged} />}

          <h3>Remove</h3>
          <p className="hint" style={{ marginBottom: 6 }}>Takes {node.name} off the map, with its login and history.</p>
          <button className={"btn quiet" + (confirmDel ? " danger" : "")} onClick={async () => {
            if (!confirmDel) { setConfirmDel(true); return; }
            await api.deleteDevice(node.deviceId); onSelect(null); onChanged();
          }}>{confirmDel ? "Click again to remove" : "Remove device"}</button>
        </>}
      </DetailTabs>

      {updating && (
        <Modal open onClose={() => setUpdating(false)} title={`Update ${node.name} on the device`}>
          <p className="hint" style={{ marginTop: 0 }}>Installs netmap's newest read-only helpers on {device ? device.host : node.host} and gives it a new read-only login. The device keeps its place on the map.</p>
          <SetupForm preset={{ deviceId: node.deviceId, name: node.name, host: device ? device.host : node.host, port: device && device.port, https: device && device.https }}
            onAdded={() => onChanged()} onClose={() => setUpdating(false)} />
        </Modal>
      )}
    </>
  );
}

function ClientDetail({ node, nameOf, onChanged, ouiCount, devices, tab, onTab }) {
  const [label, setLabel] = useState(node.label || "");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setLabel(node.label || ""); setSaved(false); }, [node.id, node.label]);
  const cur = tab === "settings" ? "settings" : "status";
  return (
    <>
      <div className="nm-detail-head"><div><div className="eyebrow">Client · {node.via || "seen"}</div><h2>{node.name}</h2></div></div>
      <DetailTabs tabs={[{ id: "status", label: "Status" }, { id: "settings", label: "Settings" }]} tab={cur} onTab={onTab}>
        {cur === "status" ? <>
          <dl className="facts">
            <dt>MAC</dt><dd className="mono">{node.mac}</dd>
            <dt>Maker</dt><dd>{node.vendor || (node.randomized ? "Private (randomized) MAC: the device makes it up, so there's no maker to look up" : ouiCount ? "Not in the manufacturer list" : "Manufacturer list not downloaded yet")}</dd>
            <dt>IP</dt><dd className="mono">{node.ip || "—"}</dd>
            <dt>Hostname</dt><dd>{node.hostname || "—"}</dd>
            <dt>First seen</dt><dd>{ago(node.firstSeen)}</dd>
            <dt>Last seen</dt><dd>{ago(node.lastSeen)}</dd>
          </dl>
          <h3>Seen on</h3>
          <table><tbody>{node.sightings.map((s, i) => (
            <tr key={i}>
              <td>{nameOf(s.deviceId)}</td><td>{s.via}</td><td className="mono">{s.iface}</td>
              <td>{s.detail && s.detail.signal != null ? `${s.detail.signal} dBm` : ""}{s.detail && s.detail.ssid ? ` · ${s.detail.ssid}` : ""}
                {s.via === "vm" && s.detail ? `${s.detail.type === "lxc" ? "CT" : "VM"} ${s.detail.vmid} · ${s.detail.nic}` : ""}</td>
            </tr>
          ))}</tbody></table>
        </> : <>
          <h3 className="first">Name</h3>
          <form className="nm-form" onSubmit={async (e) => { e.preventDefault(); await api.labelClient(node.mac, label); setSaved(true); onChanged(); }}>
            <label>Your name for it<input value={label} onChange={(e) => { setLabel(e.target.value); setSaved(false); }} placeholder={node.hostname || "e.g. Living room TV"} /></label>
            <div className="row"><button className="btn">Save name</button>{saved && <span className="hint">Saved.</span>}</div>
          </form>
          <h3>Plugged into</h3>
          <PluggedIntoEditor devices={devices} device={node.placedDevice} port={node.placedPort}
            onSave={async (dev, port) => { await api.placeClient(node.mac, dev, port); onChanged(); }} />
        </>}
      </DetailTabs>
    </>
  );
}

// The Overview tab: every device at a glance; clicking one opens its Details.
const DEVICE_KIND = { router: "Router", ap: "Access point", switch: "Switch", "switch-plain": "Unmanaged switch", server: "Proxmox node" };
function Overview({ devNodes, clientCount, edges, selected, onSelect, onAdd }) {
  const perDevice = {};
  for (const e of edges || []) if (e.target.startsWith("c")) perDevice[e.source] = (perDevice[e.source] || 0) + 1;
  const ok = devNodes.filter((d) => d.status === "ok").length;
  const bad = devNodes.filter((d) => d.status === "error").length;
  return (
    <section>
      <div className="nm-side-head"><h2>Devices</h2><button className="btn sm" onClick={onAdd}>Add device</button></div>
      {devNodes.length === 0
        ? <p className="hint">No devices yet. Click Add device and give it an OpenWrt router or AP's IP and admin password; netmap sets up a read-only login on it.</p>
        : <p className="hint nm-summary">{devNodes.length} devices · {ok} answering{bad ? <> · <span className="nm-err">{bad} not answering</span></> : ""} · {clientCount} clients online</p>}
      <ul className="nm-devlist">
        {devNodes.map((d) => (
          <li key={d.id}>
            <button className={(selected === d.id ? "on" : "") + (d.pausedUntil ? " paused" : "")} onClick={() => onSelect(d.id)} title={DEVICE_KIND[deviceIcon(d)] + (d.pausedUntil ? ` · polling paused ${pausedText(d.pausedUntil)}` : "")}>
              <span className={"nm-dev-ico sm " + deviceIcon(d)}><Icon name={deviceIcon(d)} size={16} /><span className={"nm-dot " + d.status} /></span>
              <span className="txt">
                <span className="name">{d.name}{d.isRoot && <span className="nm-role gw">Gateway</span>}{d.isCore && <span className="nm-role core">Core</span>}</span>
                <span className="meta">{d.status === "unmanaged" ? (d.host || "not probed") : d.host}{d.pausedUntil ? " · paused" : d.status === "error" ? " · not answering" : ""}</span>
              </span>
              <span className="cnt" title="clients connected directly">{perDevice[d.id] || ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SIDE_MIN = 260, SIDE_MAX = 720;
const stored = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

export default function App() {
  const [graph, setGraph] = useState(null);
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [showClients, setShowClients] = useState(() => { try { return localStorage.getItem("nm-clients") !== "0"; } catch (e) { return true; } });
  const [adding, setAddingState] = useState(false);
  const [addKey, setAddKey] = useState(0);
  // Opening starts a fresh form unless a setup is still showing its progress.
  const setAdding = (v) => { if (v && !adding) setAddKey((k) => (setupRunning.current ? k : k + 1)); setAddingState(v); };
  const setupRunning = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [g, d] = await Promise.all([api.graph(), api.devices()]);
      setGraph(g); setDevices(d); setError(null);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { try { localStorage.setItem("nm-clients", showClients ? "1" : "0"); } catch (e) {} }, [showClients]);
  const [sideTab, setSideTab] = useState("overview");
  // the vertical tab in the details panel; kept while clicking from device to device
  const [detailTab, setDetailTab] = useState(() => stored("nm-detail-tab", "status"));
  useEffect(() => store("nm-detail-tab", detailTab), [detailTab]);
  const [collapsed, setCollapsed] = useState(() => stored("nm-side-collapsed", false));
  const [sideW, setSideW] = useState(() => stored("nm-side-width", 340));
  useEffect(() => store("nm-side-collapsed", collapsed), [collapsed]);
  // Picking something (on the map or in the list) shows its details; clearing the selection goes back to the list.
  useEffect(() => { setSideTab(selected ? "details" : "overview"); if (selected) setCollapsed(false); }, [selected]);
  // Drag the sidebar's edge to resize it.
  const startResize = (e) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => setSideW(Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(ev.clientX))));
    const up = (ev) => { el.releasePointerCapture(ev.pointerId); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); setSideW((w) => { store("nm-side-width", w); return w; }); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const [showFlow, setShowFlow] = useState(() => { try { return localStorage.getItem("nm-flow") !== "0"; } catch (e) { return true; } });
  useEffect(() => { try { localStorage.setItem("nm-flow", showFlow ? "1" : "0"); } catch (e) {} }, [showFlow]);

  const node = graph && selected ? graph.nodes.find((n) => n.id === selected) : null;
  const nameOf = useMemo(() => (id) => (devices.find((d) => d.id === id) || {}).name || `device ${id}`, [devices]);
  const devNodes = graph ? graph.nodes.filter((n) => n.kind === "device") : [];
  const clientCount = graph ? graph.nodes.filter((n) => n.kind === "client").length : 0;
  const clientsOf = (id) => (graph ? graph.edges.filter((e) => e.source === id && e.target.startsWith("c")).length : 0);

  return (
    <div className="nm-app" style={{ gridTemplateColumns: collapsed ? "32px minmax(0, 1fr)" : `${sideW}px minmax(0, 1fr)` }}>
      <header className="nm-top">
        <h1>Network map</h1>
        <span className="sub">{devNodes.length} device{devNodes.length === 1 ? "" : "s"} · {clientCount} client{clientCount === 1 ? "" : "s"}{graph ? ` · updated ${ago(graph.generatedAt)}` : ""}</span>
        <label className="chk"><input type="checkbox" checked={showClients} onChange={(e) => setShowClients(e.target.checked)} /> Show clients</label>
        <label className="chk"><input type="checkbox" checked={showFlow} onChange={(e) => setShowFlow(e.target.checked)} /> Traffic animation</label>
        {error && <span className="pill error">API: {error}</span>}
      </header>
      {/* key: a fresh form each time the dialog opens */}
      <AddDeviceModal key={addKey} open={adding} onClose={() => setAdding(false)} devices={devNodes}
        onAdded={(id) => { refresh(); if (id) setSelected("d" + id); }}
        onJobState={(st) => { setupRunning.current = st === "running"; }} />
      {collapsed ? (
        <aside className="nm-side-strip">
          <button type="button" onClick={() => setCollapsed(false)} title="Show the sidebar" aria-label="Show the sidebar">»</button>
          <span className="lbl">{node ? node.name : "Devices"}</span>
        </aside>
      ) : (
        <div className="nm-side-wrap">
          <aside className="nm-side">
            <div className="nm-side-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={sideTab === "overview"} onClick={() => setSideTab("overview")}>Overview</button>
              <button type="button" role="tab" aria-selected={sideTab === "details"} disabled={!node} onClick={() => setSideTab("details")}
                title={node ? node.name : "Select a device or client on the map"}>{node ? node.name : "Details"}</button>
              {node && <button type="button" className="x" onClick={() => setSelected(null)} title="Close the details" aria-label="Close the details">×</button>}
              <button type="button" className="fold" onClick={() => setCollapsed(true)} title="Hide the sidebar" aria-label="Hide the sidebar">«</button>
            </div>
            {sideTab === "overview" || !node
              ? <Overview devNodes={devNodes} clientCount={clientCount} edges={graph ? graph.edges : []} selected={selected} onSelect={setSelected} onAdd={() => setAdding(true)} />
              : (
                <section className="nm-detail">
                  {node.kind === "device"
                    ? <DeviceDetail node={node} device={devices.find((d) => d.id === node.deviceId)} onChanged={refresh} onSelect={setSelected} nameOf={nameOf} devices={devNodes}
                        clients={clientsOf(node.id)} tab={detailTab} onTab={setDetailTab} />
                    : <ClientDetail node={node} nameOf={nameOf} onChanged={refresh} ouiCount={graph.oui ? graph.oui.count : 0} devices={devNodes} tab={detailTab} onTab={setDetailTab} />}
                </section>
              )}
          </aside>
          <div className="nm-resizer" onPointerDown={startResize} onDoubleClick={() => { setSideW(340); store("nm-side-width", 340); }}
            title="Drag to resize · double-click to reset" role="separator" aria-orientation="vertical" />
        </div>
      )}
      <main className={"nm-canvas" + (showFlow ? "" : " no-flow")}>
        {graph && <NetworkMap graph={graph} api={api} selectedId={selected} onSelect={setSelected} onChanged={refresh} showClients={showClients} />}
        <div className="nm-legend">
          <span><i className="ln wan" />WAN (internet)</span>
          <span><i className="ln infra" />cable between devices</span>
          <span><i className="ln cross" />extra cable (outside the tree)</span>
          <span><i className="ln wifi" />Wi-Fi</span>
          <span><i className="ln wired" />wired client</span>
          <span><i className="sw random" />randomized (private) MAC</span>
          {showFlow && <span><span className="flow"><i /><i /><i className="u" /></span>traffic: blue dots flow down, orange up; faster and bigger = more</span>}
          <span>Set where something is plugged in from its panel; select a cable you set and press Delete to remove it.</span>
        </div>
      </main>
    </div>
  );
}
