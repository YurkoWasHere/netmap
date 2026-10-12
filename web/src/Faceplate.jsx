// A device's front panel on the map: one socket per physical port, lit by link and speed, with an activity LED
// that blinks faster the more traffic the port carries. Laid out like the hardware: up to 12 ports in a row,
// more in two rows (odd on top, even below), SFP cages wider and set apart, the uplink port outlined.
import { memo } from "react";

const W = 210;              // drawable width inside the node
const SFP = /^(sfp|s\d|xg|te|tw|fiber)/i;

// Which of a device's ports are physical sockets, in panel order.
function panelPorts(d) {
  const ports = d.ports || [];
  const natural = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  if (d.driver === "snmp" || d.driver === "tplink") return ports.filter((p) => p.type === "port" || !p.type).sort((a, b) => (a.ifIndex || 0) - (b.ifIndex || 0) || natural(a, b));
  if (d.driver === "proxmox") return ports.filter((p) => p.type === "eth").sort(natural);
  if (d.driver === "openwrt") {
    // DSA ports (lan1..lan4, wan) if the router has them, else the plain ethernet devices; never VLANs or bridges
    // jacks on a switch chip (swconfig, read by the helper), else DSA ports (lan1.., wan), else plain ethernet
    const chip = ports.filter((p) => p.type === "swport");
    const dsa = ports.filter((p) => p.type !== "swport" && /^(lan\d+|wan\d*)$/.test(p.name));
    const list = chip.length ? chip : dsa.length ? dsa : ports.filter((p) => /^eth\d+$/.test(p.name));
    return list.sort((a, b) => (/^wan/.test(a.name) ? -1 : 0) - (/^wan/.test(b.name) ? -1 : 0) || natural(a, b));
  }
  return [];
}

const speedClass = (p) => {
  if (!p.carrier) return "off";
  const s = String(p.speed || "").toLowerCase();
  if (/10g|25g|40g|100g/.test(s)) return "s10g";
  if (/^1g|1000/.test(s)) return "s1g";
  if (/100m|^100/.test(s)) return "s100";
  if (/^10m|^10\b/.test(s)) return "s10";
  return "s1g";
};

// traffic on a port in bits/s (packets/s on switches that only count packets, scaled to a rough bit rate)
const traffic = (p) => {
  if (p.rxBps != null || p.txBps != null) return (p.rxBps || 0) + (p.txBps || 0);
  if (p.rxPps != null || p.txPps != null) return ((p.rxPps || 0) + (p.txPps || 0)) * 4800;
  return null;
};
const blink = (bps) => (bps == null || bps < 2000 ? null : `${Math.max(0.12, 1.4 - 0.2 * Math.log10(bps / 1000)).toFixed(2)}s`);
const fmt = (b) => (b == null ? "" : b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbit/s` : b >= 1e3 ? `${Math.round(b / 1e3)} kbit/s` : `${Math.round(b)} bit/s`);

export const Faceplate = memo(function Faceplate({ data }) {
  if (data.status === "unmanaged") {
    return <div className="nm-face plain" title="Unmanaged switch: nothing is known about its ports" />;
  }
  const ports = panelPorts(data);
  // an OpenWrt box whose LAN jacks sit behind an internal switch chip shows up as one port: no panel then
  if (!ports.length || (data.driver === "openwrt" && ports.length < 2)) return null;
  // SFP cages: named so, or the last N ports when the model says "4SFP" / "2 SFP Ports" (switches number them last)
  const sys = data.system || {};
  const m = `${sys.model || ""} ${sys.descr || ""}`.match(/(\d+)\s*(?:x\s*)?SFP/i);
  const nSfp = m ? Math.min(Number(m[1]), Math.max(0, ports.length - 1)) : 0;
  const sfp = ports.filter((p, i) => SFP.test(p.name) || i >= ports.length - nSfp);
  const copper = ports.filter((p) => !sfp.includes(p));
  const rows = copper.length > 12 ? 2 : 1;
  const cols = Math.ceil(copper.length / rows) + (sfp.length ? Math.ceil(sfp.length / rows) * 1.4 + 0.6 : 0);
  const cell = Math.min(16, Math.floor(W / Math.max(cols, 1)));
  const box = Math.max(6, cell - 3), h = rows * (box + 7) + 6;
  const uplink = data.localUplink || data.uplinkPort;

  const sockets = [];
  const put = (p, col, row, wide) => {
    const x = 4 + col * cell, y = 6 + row * (box + 7);
    const cls = speedClass(p), dur = p.carrier && !data.pausedUntil ? blink(traffic(p)) : null;
    const up = uplink && (p.name === uplink || p.name === String(uplink).replace(/^g/i, "") || `Gi${p.name}` === uplink);
    const w = wide ? box * 1.3 : box;
    sockets.push(
      <g key={p.name} className={"sock " + cls + (up ? " uplink" : "")}>
        <title>{`${/^\d+$/.test(p.name) ? "Port " : ""}${p.name}${p.alias ? " · " + p.alias : ""} · ${p.carrier ? p.speed || "link" : "no link"}${traffic(p) != null && p.carrier ? " · " + fmt(traffic(p)) : ""}${p.poe && p.poe.status === "delivering" ? (p.poe.mW != null ? ` · PoE ${(p.poe.mW / 1000).toFixed(1)} W` : ` · PoE class ${p.poe.cls}`) : ""}${up ? " · uplink" : ""}`}</title>
        <rect x={x} y={y} width={w} height={box} rx={1.5} className="body" />
        {p.carrier && <rect x={x + 1.5} y={y + 1.5} width={w - 3} height={box - 3} rx={1} className="plug" />}
        <circle cx={x + w / 2} cy={y - 2.6} r={1.5} className={"led" + (dur ? " blink" : "")} style={dur ? { animationDuration: dur } : undefined} />
        {p.poe && p.poe.status === "delivering" && <path d={`M${x + w - 3.2} ${y + box - 5.2} l-1.6 2.6 h1.4 l-0.9 2.4 l2.4 -3.1 h-1.4 l0.9 -1.9 z`} className="poe" />}
      </g>
    );
  };
  // copper: odd ports on top, even below when there are two rows (as on the hardware)
  copper.forEach((p, i) => (rows === 2 ? put(p, Math.floor(i / 2), i % 2, false) : put(p, i, 0, false)));
  const start = Math.ceil(copper.length / rows) + 0.6;
  sfp.forEach((p, i) => (rows === 2 ? put(p, start + Math.floor(i / 2) * 1.4, i % 2, true) : put(p, start + i * 1.4, 0, true)));
  const wan = data.driver === "openwrt" ? ports.findIndex((p) => /^wan/.test(p.name)) : -1;

  return (
    <div className="nm-face" title={`${ports.length} ports · ${ports.filter((p) => p.carrier).length} linked`}>
      <svg width="100%" viewBox={`0 0 ${W} ${h + (wan >= 0 ? 7 : 0)}`} preserveAspectRatio="xMinYMid meet" aria-hidden="true">
        {sockets}
        {wan >= 0 && <text x={4 + wan * cell + box / 2} y={h + 5} className="wanlbl">WAN</text>}
      </svg>
    </div>
  );
});
