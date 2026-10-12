// The map itself: a React Flow canvas fed by GET /api/graph. Self-contained so it can be embedded
// in another app: <NetworkMap graph={...} api={makeApi(base)} selectedId onSelect onChanged showClients />
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position, BaseEdge, EdgeLabelRenderer,
  useNodesState, useEdgesState
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon, deviceIcon, clientIcon } from "./icons.jsx";
import { Faceplate } from "./Faceplate.jsx";

const DEV_W = 230, CLIENT_W = 185;

const DeviceNode = memo(function DeviceNode({ data, selected }) {
  const s = data.system || {};
  return (
    <div className={"nm-node nm-device is-" + data.status + (selected ? " is-selected" : "")}>
      <Handle type="target" position={Position.Top} />
      <div className="nm-dev-row">
        <div className={"nm-dev-ico " + deviceIcon(data)}>
          <Icon name={deviceIcon(data)} size={24} />
          <span className={"nm-dot " + data.status} />
        </div>
        <div className="nm-dev-text">
          <div className="nm-node-head">
            <strong>{data.name}</strong>
            {data.isRoot && <span className="nm-role gw">Gateway</span>}
            {data.isCore && <span className="nm-role core">Core</span>}
            {data.poe && data.poe.usedW != null && <span className="nm-poe" title={`PoE: ${data.poe.usedW} W of ${data.poe.budgetW} W`}>⚡{data.poe.usedW} W</span>}
          </div>
          <div className="nm-node-sub">{data.status === "unmanaged" ? "Unmanaged switch" : s.model || data.host}</div>
          <div className="nm-node-meta">
            <span>{data.status === "unmanaged" ? (data.host || "not probed") : data.host}</span>
            {(data.status === "ok" || data.status === "unmanaged") && <span>{data.clientCount} client{data.clientCount === 1 ? "" : "s"}</span>}
            {data.status === "error" && <span className="nm-err">not answering</span>}
            {data.status === "pending" && <span>waiting for poll</span>}
          </div>
        </div>
      </div>
      <Faceplate data={data} />
      <Handle type="source" position={Position.Bottom} />
      {/* side handles for cables between devices; picked automatically, not for drawing */}
      <Handle id="l-in" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="l-out" type="source" position={Position.Left} isConnectable={false} />
      <Handle id="r-in" type="target" position={Position.Right} isConnectable={false} />
      <Handle id="r-out" type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const ClientNode = memo(function ClientNode({ data, selected }) {
  return (
    <div className={"nm-node nm-client via-" + data.via + (data.randomized ? " is-random" : "") + (selected ? " is-selected" : "")}>
      <Handle type="target" position={Position.Top} />
      <div className="nm-node-head"><Icon name={clientIcon(data)} size={15} className={"via-" + data.via} /><strong>{data.name}</strong></div>
      <div className="nm-node-meta mono"><span>{data.ip || data.mac}</span></div>
      <div className="nm-node-maker" title={data.vendor || undefined}>{data.vendor || (data.randomized ? "Private (randomized) MAC" : "Unknown maker")}</div>
    </div>
  );
});


// Saved positions win; anything new gets a spot: devices in a row, each as wide as the grid of clients under it.
// Square "elbow" lines. A line from a bottom handle drops a fixed short way, runs sideways, then drops into its
// target, so every line leaving one node shares the same horizontal rail and a branch reads as a clean tree.
// A line between side handles runs sideways, steps at the middle, and runs sideways again.
const RAIL = 20;

// Traffic: "12.3M" style rates, and how fast/thick the moving dots are for a rate (none below 2 kbit/s).
export const fmtRate = (bps) => (bps == null ? "" : bps >= 1e9 ? `${(bps / 1e9).toFixed(1)}G` : bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)}M`
  : bps >= 1e3 ? `${Math.round(bps / 1e3)}k` : `${Math.round(bps)}`);
// Switches that only count packets: show packets/s, and size the dots from ~600 bytes a packet.
const PKT_BITS = 600 * 8;
const fmtPkts = (pps) => (pps == null ? "" : pps >= 1e6 ? `${(pps / 1e6).toFixed(1)}M` : pps >= 1e3 ? `${(pps / 1e3).toFixed(1)}k` : `${Math.round(pps)}`);
const flowStyle = (bps) => {
  if (bps == null || bps < 2000) return null;
  const lg = Math.log10(bps / 1000); // 0 at 1 kbit/s, 3 at 1 Mbit/s, 6 at 1 Gbit/s
  return { animationDuration: `${Math.max(0.35, 3.2 - 0.48 * lg).toFixed(2)}s`, "--dot": `${(4 + 0.5 * lg).toFixed(2)}px` };
};
// Moving dots along d: one stream flowing with the path (down / away from the source), one against it (up).
// Each dot is drawn twice, a halo in the background colour and then the dot, so it stands out on any line.
function Flow({ d, rate }) {
  const k = rate && rate.pps ? PKT_BITS : 1;
  const down = rate && flowStyle(rate.down == null ? null : rate.down * k), up = rate && flowStyle(rate.up == null ? null : rate.up * k);
  if (!down && !up) return null;
  return (
    <>
      {down && <><path d={d} className="nm-flow halo down" style={down} /><path d={d} className="nm-flow down" style={down} /></>}
      {up && <><path d={d} className="nm-flow halo up" style={up} /><path d={d} className="nm-flow up" style={up} /></>}
    </>
  );
}

const ElbowEdge = memo(function ElbowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, label, style, markerEnd, data,
  labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius, interactionWidth }) {
  // Traffic dots run on segments nobody else draws on: a branching line's own drop from the shared rail, its stretch
  // of the rail (data.rail: carrying everything that branches off beyond it) and, on one line per source, the drop
  // out of the source into the rail (data.trunk: the source's total).
  let path, flowPath, lx, ly, rail = null;
  if (sourcePosition === Position.Left || sourcePosition === Position.Right) {
    const mx = Math.round((sourceX + targetX) / 2);
    path = flowPath = `M${sourceX},${sourceY} H${mx} V${targetY} H${targetX}`;
    lx = mx; ly = (sourceY + targetY) / 2;
  } else {
    // a target straight below (within a pixel or two) is a straight line, never a tiny step
    const tx = Math.abs(targetX - sourceX) < 2 ? sourceX : targetX;
    rail = sourceY + Math.min(RAIL, Math.max(0, (targetY - sourceY) / 2));
    path = tx === sourceX ? `M${sourceX},${sourceY} V${targetY}` : `M${sourceX},${sourceY} V${rail} H${tx} V${targetY}`;
    flowPath = `M${tx},${tx === sourceX && !(data && data.shared) ? sourceY : rail} V${targetY}`;
    // the label sits just above the node the line goes into: in the gap between stacked nodes, not behind one
    lx = tx; ly = targetY - Math.min(13, Math.max(0, (targetY - rail) / 2));
  }
  const seg = data && data.rail && rail != null ? `M${sourceX + data.rail.from},${rail} H${sourceX + data.rail.to}` : null;
  const trunk = data && data.trunk && rail != null ? `M${sourceX},${sourceY} V${rail}` : null;
  // The same edge is drawn twice: once as the line (in the edges' own order) and once as an overlay that only has
  // the traffic dots, added after every line so dots are never hidden under another line (see dotLayer).
  if (data && data.dotsOnly) {
    return (
      <>
        {trunk && <Flow d={trunk} rate={data.trunk} />}
        {seg && <Flow d={seg} rate={data.rail.rate} />}
        <Flow d={flowPath} rate={data.rate} />
      </>
    );
  }
  // Layers, bottom to top: the lines (here), the traffic dots (the dotsOnly copies, drawn after every line), and
  // the labels, which go to React Flow's label layer above all edges so no line or dot covers them.
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      {label && (
        <EdgeLabelRenderer>
          <div className="nm-edge-label" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>{label}</div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
const edgeTypes = { elbow: ElbowEdge };

// The internet, above the gateway, linked to its WAN port.
const CLOUD = "M50 98 A27 27 0 0 1 42 46 A34 34 0 0 1 102 22 A31 31 0 0 1 160 42 A28 28 0 0 1 154 98 Z";
const InternetNode = memo(function InternetNode({ data }) {
  return (
    <div className="nm-internet" title={data.upstream.map((u) => [u.ip, u.hostname, u.vendor, u.mac].filter(Boolean).join(" · ")).join("\n") || undefined}>
      <svg className="nm-cloud" viewBox="0 0 200 110" aria-hidden="true"><path d={CLOUD} /></svg>
      <div className="nm-cloud-text">
        <strong>Internet</strong>
        <span className="mono">{data.ips.join(", ") || "WAN"}</span>
        {data.upstream.length > 0 && <span className="via">via {data.upstream.map((u) => u.ip || u.mac).join(", ")}{data.upstream[0].hostname ? ` (${data.upstream[0].hostname.split(".").slice(-2, -1)[0] || data.upstream[0].hostname})` : ""}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

// A port (or SSID) on a device, sitting between the device and the clients behind it.
// Click to fold or unfold its clients.
const PortNode = memo(function PortNode({ data }) {
  return (
    <div className={"nm-port" + (data.wifi ? " wifi" : "") + (data.collapsed ? " collapsed" : "")} title={data.collapsed ? "Show these clients" : "Hide these clients"}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {data.wifi && <Icon name="ap" size={12} className="wifi-ico" />}
      <span className="lbl">{data.label}</span>
      <span className="cnt">{data.collapsed ? `+${data.count}` : data.count}</span>
      {data.rate && (data.rate.down != null || data.rate.up != null) && (
        data.rate.pps
          ? <span className="rate" title="packets per second on this port (this switch only counts packets), averaged over the last poll">↓{fmtPkts(data.rate.down) || "0"} ↑{fmtPkts(data.rate.up) || "0"} p/s</span>
          : <span className="rate" title="traffic on this port, averaged over the last poll">↓{fmtRate(data.rate.down) || "0"} ↑{fmtRate(data.rate.up) || "0"}</span>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { device: DeviceNode, client: ClientNode, port: PortNode, internet: InternetNode };

// The map is a tree from the top of the network down. Under each device: one group per port (or SSID), in
// port order, each with a port node on top; below it the clients on that port (stacked in columns) and any
// devices plugged into it, each with its own subtree. Ports with more than FOLD_OVER clients (uplinks,
// hypervisors) start folded; folding hides clients, never devices.
// Roles: the Internet gateway is at the top with an Internet node above its WAN. When it has Core switches,
// they take the row right under it, and the gateway's other ports, clients and non-core devices drop one row
// further (CORE_DROP), level with what hangs under the core switches.
const CW = CLIENT_W + 15, CH = 94, GAP = 70, MAX_ROWS = 8, FOLD_OVER = 6, PORT_W = 185;
const PORT_DY = 175, KIDS_DY = 255; // port row and first client/device row, below a device's top (faceplate included)
const CORE_DROP = KIDS_DY, INET_W = 200, INET_DY = 175;
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
// Long interface names the way switch CLIs write them: GigabitEthernet5 -> Gi5, TenGigabitEthernet1/0/1 -> Te1/0/1
const shortPort = (p) => String(p)
  .replace(/^TwentyFiveGig(abit)?E(thernet)?/i, "Twe").replace(/^TenGigabitEthernet/i, "Te").replace(/^GigabitEthernet/i, "Gi")
  .replace(/^FastEthernet/i, "Fa").replace(/^Ethernet(?=\d)/i, "Eth").replace(/^Port-?channel/i, "Po");
const portLabel = (p) => (/^\d+$/.test(p) ? `port ${p}` : shortPort(p));

function buildView(graph, showClients, flipped) {
  const devs = graph.nodes.filter((n) => n.kind === "device");
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const edgeTo = {};
  for (const e of graph.edges) if (e.target.startsWith("c")) edgeTo[e.target] = e;

  // device id -> group key -> { key, label, wifi, kind, clients, children }
  const groups = {};
  const group = (parent, key, label, wifi, kind) => {
    const byKey = groups[parent] || (groups[parent] = {});
    return byKey[key] || (byKey[key] = { key, label, wifi, kind, iface: "", clients: [], children: [] });
  };
  // the same link seen from its other end: what that end sends is what this end receives
  const flipRate = (r) => (r ? { down: r.up, up: r.down } : null);
  // Port rate seen from the device above: tx is what flows down to the port, rx what comes up from it.
  const portRate = (devId, iface) => {
    const p = iface && byId[devId] && (byId[devId].ports || []).find((x) => x.name === iface);
    if (p && (p.txBps != null || p.rxBps != null)) return { down: p.txBps, up: p.rxBps };
    return p && (p.txPps != null || p.rxPps != null) ? { down: p.txPps, up: p.rxPps, pps: true } : null;
  };
  for (const n of graph.nodes) {
    if (n.kind !== "client") continue;
    const e = edgeTo[n.id];
    if (!e) { group("none", "unattached", "not placed", false, "").clients.push(n); continue; }
    const wifi = e.kind === "wifi";
    const key = wifi ? `wifi:${e.ssid || e.sourcePort}` : e.sourcePort || e.kind;
    const label = wifi ? e.ssid || e.sourcePort : e.sourcePort ? portLabel(e.sourcePort)
      : e.kind === "manual" ? "plugged in" : e.kind === "fdb" ? "unmanaged ports" : e.kind;
    const gr = group(e.source, key, label, wifi, e.kind);
    gr.iface = gr.iface || e.sourcePort || "";
    gr.clients.push(n);
  }
  const treeEdge = {};
  for (const e of graph.edges) if (e.tree) treeEdge[e.target] = e;
  for (const d of devs) {
    const e = treeEdge[d.id];
    if (!e) continue;
    // placed by its role (a core switch not cabled to the gateway): a slot under the gateway, no port, no line
    if (e.layoutOnly) { const g = group(e.source, "~role", "", false, "role"); g.hidden = true; g.children.push(d); continue; }
    const key = e.sourcePort || "cable";
    const gr = group(e.source, key, e.sourcePort ? portLabel(e.sourcePort) : "cable", false, e.kind);
    gr.iface = gr.iface || e.sourcePort || "";
    gr.children.push(d);
  }

  // Ordered groups per device with their client columns; widths measured bottom-up.
  const ordered = {};
  const groupsOf = (id) => {
    if (ordered[id]) return ordered[id];
    return (ordered[id] = Object.values(groups[id] || {}).sort((a, b) => (a.wifi - b.wifi) || natural(a.key, b.key)).map((g) => {
      const gid = `p|${id}|${g.key}`;
      // busy switch ports start folded; a Proxmox bridge doesn't (you want to see which VM is where)
      const collapsed = g.clients.length > 0 && (g.kind !== "vm" && g.clients.length > FOLD_OVER) !== flipped.has(gid);
      const list = g.clients.slice().sort((a, b) => natural(a.name, b.name));
      const columns = [];
      if (showClients && !collapsed) for (let i = 0; i < list.length; i += MAX_ROWS) columns.push(list.slice(i, i + MAX_ROWS));
      return { ...g, id: gid, collapsed, columns, children: g.children.slice().sort((a, b) => (b.isCore - a.isCore) || natural(a.name, b.name)) };
    }).filter((g) => g.children.length || showClients));
  };
  const widthMemo = {};
  // A group is its client columns, then its devices side by side, each followed by a gap.
  const groupWidth = (g) => Math.max(CW, g.columns.length * CW + g.children.reduce((w, c) => w + width(c.id) + GAP, 0));
  const width = (id) => (widthMemo[id] != null ? widthMemo[id] : (widthMemo[id] = Math.max(DEV_W, groupsOf(id).reduce((w, g) => w + groupWidth(g), 0))));

  // Middle of what hangs below a group's port, for a group laid out from x = gl: client columns, then devices.
  const portCenterOf = (g, gl) => {
    const centers = g.columns.map((_, ci) => gl + ci * CW + CLIENT_W / 2);
    let cx = gl + g.columns.length * CW;
    for (const child of g.children) { centers.push(cx + width(child.id) / 2); cx += width(child.id) + GAP; }
    return centers.length ? (Math.min(...centers) + Math.max(...centers)) / 2 : gl + CLIENT_W / 2;
  };

  const nodes = [], edges = [];
  const place = (d, left, top) => {
    const w = width(d.id);
    const clientCount = graph.edges.filter((e) => e.source === d.id && e.target.startsWith("c")).length;
    nodes.push({ id: d.id, type: "device", deletable: false, position: { x: left + (w - DEV_W) / 2, y: top }, data: { ...d, clientCount }, style: { width: DEV_W } });
    const gs = groupsOf(d.id);
    // Under a gateway with core switches, everything that isn't a core switch drops below the core row.
    const coreRow = d.isRoot && gs.some((g) => g.children.some((c) => c.isCore));
    const drop = coreRow ? CORE_DROP : 0;
    // Centre the row of ports under the device (not just the groups' boxes), so a device with one port gets a
    // straight line down; then lay the groups out from there.
    let gl = left + (w - gs.reduce((s, g) => s + groupWidth(g), 0)) / 2;
    {
      let g0 = gl;
      const pcs = [];
      for (const g of gs) { if (!g.hidden) pcs.push(portCenterOf(g, g0)); g0 += groupWidth(g); }
      if (pcs.length) gl += left + w / 2 - (Math.min(...pcs) + Math.max(...pcs)) / 2;
    }
    for (const g of gs) {
      const gw = groupWidth(g);
      const hasCore = g.children.some((c) => c.isCore);
      // The port sits centred between the first and last thing hanging below it (client columns, then devices),
      // so one thing below means a straight line, and several share a rail centred under the port.
      const portCenter = portCenterOf(g, gl);
      const grate = portRate(d.id, g.iface);
      // one thing on the port: the port's traffic is its traffic
      const single = g.clients.length + g.children.length === 1 ? grate : null;
      if (!g.hidden) {
        nodes.push({ id: g.id, type: "port", deletable: false, position: { x: portCenter - PORT_W / 2, y: top + PORT_DY + (hasCore ? 0 : drop) },
          data: { label: g.label, count: g.clients.length, collapsed: g.collapsed, wifi: g.wifi, devices: g.children.length, rate: grate }, style: { width: PORT_W } });
        edges.push({ id: "dp" + g.id, source: d.id, target: g.id, className: "nm-edge port-link kind-" + g.kind + (g.children.length ? " trunk" : ""), deletable: false, data: { rate: grate } });
      }
      g.columns.forEach((col, ci) => col.forEach((c, ri) => {
        nodes.push({ id: c.id, type: "client", deletable: false, position: { x: gl + ci * CW, y: top + KIDS_DY + drop + ri * CH }, data: c, style: { width: CLIENT_W } });
        const e = edgeTo[c.id];
        // a VM has its own counters; anything else alone on its port gets the port's
        const vm = (c.sightings || []).find((x) => x.via === "vm" && x.detail && (x.detail.inBps != null || x.detail.outBps != null));
        const crate = vm ? { down: vm.detail.inBps, up: vm.detail.outBps } : single;
        edges.push({ id: e ? e.id : "u" + c.id, source: g.id, target: c.id, label: e && e.kind === "wifi" && e.signal != null ? `${e.signal} dBm` : undefined,
          className: "nm-edge kind-" + (e ? e.kind : ""), deletable: false, data: { ...(e || {}), rate: crate }, labelBgPadding: [3, 1], labelBgBorderRadius: 3 });
      }));
      let cl = gl + g.columns.length * CW;
      for (const child of g.children) {
        const e = treeEdge[child.id];
        place(child, cl, top + KIDS_DY + (child.isCore ? 0 : drop));
        if (!e.layoutOnly) edges.push({ id: e.id, source: g.id, target: child.id, label: e.targetPort ? shortPort(e.targetPort) : undefined,
          className: "nm-edge infra tree kind-" + e.kind, deletable: !!e.linkId, data: { ...e, rate: grate }, labelBgPadding: [4, 2], labelBgBorderRadius: 3 });
        cl += width(child.id) + GAP;
      }
      gl += gw;
    }
  };
  const wanRate = (d) => {
    const dev = (d.wan || []).map((i) => i.device).find(Boolean);
    const p = dev && (d.ports || []).find((x) => x.name === dev);
    return p && (p.rxBps != null || p.txBps != null) ? { down: p.rxBps, up: p.txBps } : null;
  };
  // Trees side by side: the top of the network first, then any devices with no known parent.
  let left = 0;
  for (const d of devs.filter((n) => !n.parent).sort((a, b) => b.isRoot - a.isRoot || natural(a.name, b.name))) {
    place(d, left, 0);
    if (d.isRoot) {
      const at = nodes.find((n) => n.id === d.id).position;
      const wan = d.wan || [];
      const ips = wan.flatMap((i) => i.ipv4.map((a) => a.split("/")[0]));
      nodes.push({ id: "inet|" + d.id, type: "internet", deletable: false, position: { x: at.x + DEV_W / 2 - INET_W / 2, y: at.y - INET_DY }, data: { ips, upstream: d.upstream || [] }, style: { width: INET_W } });
      edges.push({ id: "wan|" + d.id, source: "inet|" + d.id, target: d.id, label: wan.map((i) => (i.device && i.device !== i.name ? `${i.name} (${i.device})` : i.name)).join(" · ") || "WAN",
        className: "nm-edge wan", deletable: false, data: { rate: wanRate(d) }, labelBgPadding: [4, 2], labelBgBorderRadius: 3 });
    }
    left += width(d.id) + GAP * 2;
  }
  // Clients nobody could place.
  if (showClients && groups.none) {
    for (const [i, c] of groups.none.unattached.clients.entries()) {
      nodes.push({ id: c.id, type: "client", deletable: false, position: { x: left + (i % 3) * CW, y: Math.floor(i / 3) * CH }, data: c, style: { width: CLIENT_W } });
    }
  }
  // Cables that don't fit the tree (drawn by hand or LLDP between devices that already have a parent).
  for (const e of graph.edges) {
    if (!e.cross) continue;
    edges.push({ id: e.id, source: e.source, target: e.target, label: [e.sourcePort, e.targetPort].filter(Boolean).map(shortPort).join(" ↔ "),
      className: "nm-edge infra cross kind-" + e.kind + (e.core ? " core-link" : ""), deletable: !!e.linkId,
      // traffic from the source's port: what it sends flows along the cable to the target, what it receives comes back
      data: { ...e, rate: portRate(e.source, e.sourcePort) || flipRate(portRate(e.target, e.targetPort)) }, labelBgPadding: [4, 2], labelBgBorderRadius: 3 });
  }
  railTraffic(nodes, edges);
  return { nodes, edges: edges.concat(dotLayer(edges)) };
}

// A copy of every edge that carries traffic, holding only its dots, drawn above all the lines.
function dotLayer(edges) {
  const hasTraffic = (d) => d && ((d.rate && (d.rate.down != null || d.rate.up != null)) || d.trunk || d.rail);
  return edges.filter((e) => hasTraffic(e.data)).map((e) => ({
    // no zIndex: being last in the list already paints it over every line, and nodes stay on top of it
    ...e, id: e.id + "~dots", label: undefined, deletable: false, selectable: false, focusable: false,
    className: (e.className || "") + " dot-layer", data: { ...e.data, dotsOnly: true }
  }));
}

// A node's branching lines share one horizontal rail. Split it at each branch: the stretch from one branch point
// to the next carries the traffic of every branch beyond it; the drop from the source into the rail carries the
// source's total (a port's own rate, else the sum of its branches). Stored on the edges for ElbowEdge to draw.
function railTraffic(nodes, edges) {
  const center = Object.fromEntries(nodes.map((n) => [n.id, n.position.x + ((n.style && n.style.width) || 0) / 2]));
  const byNode = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const allPps = (list) => list.some((e) => e.data && e.data.rate) && list.every((e) => !(e.data && e.data.rate) || e.data.rate.pps);
  const sum = (list, k) => {
    const v = list.map((e) => e.data && e.data.rate && e.data.rate[k]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const bySource = {};
  for (const e of edges) if (!e.className.includes("cross") && center[e.target] != null) (bySource[e.source] = bySource[e.source] || []).push(e);
  for (const [src, list] of Object.entries(bySource)) {
    if (list.length < 2) continue;
    const sx = center[src];
    for (const side of [1, -1]) {
      const branch = list.filter((e) => (center[e.target] - sx) * side > 1).sort((a, b) => (center[a.target] - center[b.target]) * side);
      let from = 0;
      branch.forEach((e, i) => {
        const to = center[e.target] - sx;
        const beyond = branch.slice(i);
        e.data = { ...e.data, rail: { from, to, rate: { down: sum(beyond, "down"), up: sum(beyond, "up"), pps: allPps(beyond) } } };
        from = to;
      });
    }
    const srcNode = byNode[src];
    const total = srcNode && srcNode.type === "port" && srcNode.data.rate ? srcNode.data.rate : { down: sum(list, "down"), up: sum(list, "up"), pps: allPps(list) };
    list.forEach((e, i) => { e.data = { ...e.data, shared: true, ...(i === 0 ? { trunk: total } : {}) }; });
  }
}

// Cables outside the tree leave from the side facing the other device.
function withSides(edges, nodes) {
  const at = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
  return edges.map((e) => {
    if (!e.className.includes("cross") || !at[e.source] || !at[e.target]) return e;
    const right = at[e.source].x <= at[e.target].x;
    return { ...e, sourceHandle: right ? "r-out" : "l-out", targetHandle: right ? "l-in" : "r-in" };
  });
}

// Nothing on the map can be dragged: the layout is always the automatic tree. Where something is plugged in is
// set from its panel (Plugged into), not by dragging lines.
export default function NetworkMap({ graph, api, selectedId, onSelect, onChanged, showClients = true }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const sig = useMemo(() => JSON.stringify(graph), [graph]);
  // Port groups whose fold state you flipped from the default.
  const [flipped, setFlipped] = useState(() => new Set());

  useEffect(() => {
    if (!graph) return;
    const view = buildView(graph, showClients, flipped);
    setEdges(view.edges);
    setNodes(view.nodes.map((n) => ({ ...n, selected: n.id === selectedId })));
  }, [sig, showClients, flipped]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setNodes((cur) => cur.map((n) => (n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId }))); }, [selectedId, setNodes]);

  // Zoom to fit whenever a device is added or removed.
  const flow = useRef(null);
  const deviceCount = graph ? graph.nodes.filter((n) => n.kind === "device").length : 0;
  useEffect(() => {
    const t = setTimeout(() => flow.current && flow.current.fitView({ padding: 0.2, duration: 300 }), 80);
    return () => clearTimeout(t);
  }, [deviceCount, showClients]);

  const shown = useMemo(() => withSides(edges, nodes), [edges, nodes]);

  const onEdgesDelete = useCallback(async (deleted) => {
    for (const e of deleted) if (e.data && e.data.linkId) await api.deleteLink(e.data.linkId);
    onChanged && onChanged();
  }, [api, onChanged]);

  return (
    <ReactFlow
      nodes={nodes} edges={shown} nodeTypes={nodeTypes}
      edgeTypes={edgeTypes} defaultEdgeOptions={{ type: "elbow" }}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onEdgesDelete={onEdgesDelete} nodesDraggable={false} nodesConnectable={false}
      onNodeClick={(_, n) => {
        if (n.type === "port") setFlipped((f) => { const next = new Set(f); next.has(n.id) ? next.delete(n.id) : next.add(n.id); return next; });
        else if (onSelect) onSelect(n.id);
      }} onPaneClick={() => onSelect && onSelect(null)}
      deleteKeyCode={["Delete", "Backspace"]}
      onInit={(i) => { flow.current = i; }}
      fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.1}
      proOptions={{ hideAttribution: false }}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeClassName={(n) => "mm-" + n.type + " mm-" + (n.data.status || n.data.via) + (n.data.randomized ? " mm-random" : "")} />
    </ReactFlow>
  );
}
