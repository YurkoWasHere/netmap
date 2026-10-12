// Two fake OpenWrt devices answering ubus JSON-RPC, for trying netmap without hardware.
//   router  http://127.0.0.1:8181  (DHCP server, AP cabled to lan1, a PC on lan2, one Wi-Fi phone)
//   ap      http://127.0.0.1:8182  (dumb AP, uplink on lan, two Wi-Fi clients)
//   fresh   http://127.0.0.1:8183  (same AP, not set up yet: only root / root works, for trying automatic setup.
//                                   Like a stock OpenWrt 19.07 it has no /ubus until setup, only LuCI's relay)
// Log in as monitor / monitor (router, ap) or root / root (all three; the setup script run is simulated).
const http = require("http");

const MAC = { router: "f4:92:bf:00:00:01", ap: "f4:92:bf:00:00:02", pc: "3c:7c:3f:11:22:33", phone: "a4:83:e7:44:55:66", tv: "70:2a:d5:77:88:99", laptop: "84:fd:d1:aa:bb:cc", nas: "00:11:32:de:ad:01" };

const devices = {
  router: {
    board: { hostname: "gw", model: "GL.iNet GL-MT6000", board_name: "glinet,gl-mt6000", kernel: "6.6.73", release: { distribution: "OpenWrt", version: "24.10.0" } },
    info: { uptime: 864000, load: [12000, 9000, 8000], memory: { total: 1e9, free: 6e8, available: 7e8 } },
    ifaces: { interface: [
      { interface: "lan", up: true, proto: "static", l3_device: "br-lan", "ipv4-address": [{ address: "192.168.1.1", mask: 24 }], uptime: 864000 },
      { interface: "wan", up: true, proto: "dhcp", l3_device: "eth1", "ipv4-address": [{ address: "203.0.113.7", mask: 24 }], uptime: 863000 }
    ] },
    devs: {
      "br-lan": { type: "bridge", up: true, carrier: true, macaddr: MAC.router, "bridge-members": ["lan1", "lan2", "lan3", "phy0-ap0"] },
      lan1: { type: "Network device", up: true, carrier: true, speed: "1000F", macaddr: MAC.router },
      lan2: { type: "Network device", up: true, carrier: true, speed: "1000F", macaddr: MAC.router },
      lan3: { type: "Network device", up: true, carrier: false, speed: "-1", macaddr: MAC.router },
      eth1: { type: "Network device", up: true, carrier: true, speed: "2500F", macaddr: "f4:92:bf:00:00:09" },
      "phy0-ap0": { type: "Network device", up: true, carrier: true, macaddr: "f6:92:bf:00:00:01" }
    },
    wifi: { "phy0-ap0": { info: { ssid: "Home", mode: "Master", channel: 36, frequency: 5180 }, assoc: [{ mac: MAC.phone, signal: -52, noise: -95, inactive: 300, rx: { rate: 866700 }, tx: { rate: 780000 } }] } },
    fdb: [
      { mac: MAC.router, ifname: "lan1", master: "br-lan", flags: [], state: "permanent" },
      { mac: MAC.ap, ifname: "lan1", master: "br-lan", flags: [] },
      { mac: MAC.tv, ifname: "lan1", master: "br-lan", flags: [] },
      { mac: MAC.laptop, ifname: "lan1", master: "br-lan", flags: [] },
      { mac: MAC.pc, ifname: "lan2", master: "br-lan", flags: [] },
      { mac: MAC.nas, ifname: "lan2", master: "br-lan", flags: [] },
      { mac: MAC.phone, ifname: "phy0-ap0", master: "br-lan", flags: [] },
      { mac: "33:33:00:00:00:01", ifname: "lan1", master: "br-lan", flags: ["self"], state: "permanent" }
    ],
    lldp: { lldp: { interface: { lan1: { chassis: { "ap-living": { id: { type: "mac", value: MAC.ap }, "mgmt-ip": "192.168.1.2" } }, port: { id: { type: "ifname", value: "lan" }, descr: "lan" } } } } },
    leases: { dhcp_leases: [
      { hostname: "desktop", ipaddr: "192.168.1.10", macaddr: MAC.pc.toUpperCase(), expires: 40000 },
      { hostname: "pixel-8", ipaddr: "192.168.1.20", macaddr: MAC.phone, expires: 30000 },
      { hostname: "living-tv", ipaddr: "192.168.1.30", macaddr: MAC.tv, expires: 30000 },
      { hostname: "work-laptop", ipaddr: "192.168.1.31", macaddr: MAC.laptop, expires: 30000 },
      { hostname: "ap-living", ipaddr: "192.168.1.2", macaddr: MAC.ap, expires: 30000 },
      // a lease left behind by a phone that has gone home: must not show on the map
      { hostname: "old-phone", ipaddr: "192.168.1.99", macaddr: "00:1a:11:aa:bb:01", expires: 20000 }
    ] },
    hints: { [MAC.nas.toUpperCase()]: { name: "nas", ipaddrs: ["192.168.1.5"] } },
    arp: `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.10     0x1         0x2         ${MAC.pc}     *        br-lan
192.168.1.5      0x1         0x2         ${MAC.nas}     *        br-lan
192.168.1.99     0x1         0x0         00:00:00:00:00:00     *        br-lan
`
  },
  ap: {
    board: { hostname: "ap-living", model: "Ubiquiti UniFi 6 Lite", board_name: "ubnt,unifi-6-lite", kernel: "6.6.73", release: { distribution: "OpenWrt", version: "24.10.0" } },
    info: { uptime: 400000, load: [3000, 2000, 2000], memory: { total: 2.5e8, free: 1e8 } },
    ifaces: { interface: [{ interface: "lan", up: true, proto: "dhcp", l3_device: "br-lan", "ipv4-address": [{ address: "192.168.1.2", mask: 24 }], uptime: 400000 }] },
    devs: {
      "br-lan": { type: "bridge", up: true, carrier: true, macaddr: MAC.ap, "bridge-members": ["lan", "phy0-ap0", "phy1-ap0"] },
      lan: { type: "Network device", up: true, carrier: true, speed: "1000F", macaddr: MAC.ap },
      "phy0-ap0": { type: "Network device", up: true, carrier: true, macaddr: "f6:92:bf:00:00:02" },
      "phy1-ap0": { type: "Network device", up: true, carrier: true, macaddr: "fa:92:bf:00:00:02" }
    },
    wifi: {
      "phy0-ap0": { info: { ssid: "Home", mode: "Master", channel: 6, frequency: 2437 }, assoc: [{ mac: MAC.tv, signal: -61, noise: -92, inactive: 1200, rx: { rate: 72200 }, tx: { rate: 65000 } }] },
      "phy1-ap0": { info: { ssid: "Home", mode: "Master", channel: 44, frequency: 5220 }, assoc: [{ mac: MAC.laptop, signal: -48, noise: -95, inactive: 50, rx: { rate: 1200000 }, tx: { rate: 1080000 } }] }
    },
    fdb: [
      { mac: MAC.router, ifname: "lan", master: "br-lan", flags: [] },
      { mac: MAC.pc, ifname: "lan", master: "br-lan", flags: [] },
      { mac: MAC.nas, ifname: "lan", master: "br-lan", flags: [] },
      { mac: MAC.phone, ifname: "lan", master: "br-lan", flags: [] },
      { mac: MAC.tv, ifname: "phy0-ap0", master: "br-lan", flags: [] },
      { mac: MAC.laptop, ifname: "phy1-ap0", master: "br-lan", flags: [] }
    ],
    lldp: null, // lldpd not installed on this one: the probe reports it
    leases: { dhcp_leases: [] },
    hints: {},
    arp: "IP address       HW type     Flags       HW address            Mask     Device\n"
  }
};

function handler(d, creds, state) {
  const files = {};
  return (o, m, a) => {
    if (o === "session" && m === "login") return creds[a.username] && creds[a.username] === a.password ? [0, { ubus_rpc_session: "s".repeat(32) }] : [6];
    if (o === "file" && m === "write") { files[a.path] = a.data; return [0, {}]; }
    if (o === "file" && m === "read" && files[a.path] != null) return [0, { data: files[a.path] }];
    if (o === "file" && m === "exec" && a.command === "/bin/sh") {
      // Pretend to run openwrt-setup.sh: print its steps over a few seconds, then accept the new login.
      const [, pw, user] = a.params[1].match(/netmap-setup\.sh '([^']*)' '([^']*)'/) || [];
      const log = a.params[1].match(/> (\S+)/)[1];
      const steps = ["== Installing packages", "Installing rpcd-mod-iwinfo (2024-11-24)", "Installing lldpd (1.0.18)", "== Adding helper scripts and the netmap ACL",
        `== Creating rpcd login '${user}'`, "== Enabling LLDP on lan", `Done. Add this device in netmap with user '${user}' and the password you gave.`, "NETMAP-EXIT 0"];
      files[log] = "";
      steps.forEach((l, i) => setTimeout(() => { files[log] += l + "\n"; if (l.startsWith("NETMAP-EXIT")) { creds[user] = pw; state.ubus = true; } }, 700 * (i + 1)));
      return [0, { code: 0, stdout: "" }];
    }
    if (o === "system" && m === "board") return [0, d.board];
    if (o === "system" && m === "info") return [0, d.info];
    if (o === "network.interface" && m === "dump") return [0, d.ifaces];
    if (o === "network.device" && m === "status") return [0, d.devs];
    if (o === "iwinfo" && m === "devices") return [0, { devices: Object.keys(d.wifi) }];
    if (o === "iwinfo" && m === "info") return [0, d.wifi[a.device].info];
    if (o === "iwinfo" && m === "assoclist") return [0, { results: d.wifi[a.device].assoc }];
    if (o === "file" && m === "exec" && a.command.endsWith("/fdb")) return [0, { code: 0, stdout: JSON.stringify(d.fdb) }];
    if (o === "file" && m === "exec" && a.command.endsWith("/lldp")) return d.lldp ? [0, { code: 0, stdout: JSON.stringify(d.lldp) }] : [4];
    if (o === "file" && m === "read" && a.path === "/proc/net/arp") return [0, { data: d.arp }];
    if (o === "luci-rpc" && m === "getDHCPLeases") return [0, d.leases];
    if (o === "luci-rpc" && m === "getHostHints") return [0, d.hints];
    return [3];
  };
}

for (const [name, port, dev, creds, state] of [
  ["router", 8181, devices.router, { root: "root", monitor: "monitor" }, { ubus: true }],
  ["ap", 8182, devices.ap, { root: "root", monitor: "monitor" }, { ubus: true }],
  ["fresh", 8183, { ...devices.ap, board: { ...devices.ap.board, hostname: "ap-office", model: "TP-Link EAP615-Wall" } }, { root: "root" }, { ubus: false }]
]) {
  const h = handler(dev, creds, state);
  http.createServer((req, res) => {
    const ok = req.url === "/cgi-bin/luci/admin/ubus" || (req.url === "/ubus" && state.ubus);
    if (req.method !== "POST" || !ok) { res.writeHead(404); return res.end(); }
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      const j = JSON.parse(buf);
      const [, o, m, a] = j.params;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: h(o, m, a || {}) }));
    });
  }).listen(port, "127.0.0.1", () => console.log(`mock OpenWrt ${name} on http://127.0.0.1:${port}/ubus (${Object.keys(creds).join(", ")})`));
}
