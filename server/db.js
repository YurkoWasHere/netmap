// SQLite storage (node:sqlite, built into Node 22.13+). One file, created on first run.
//
//   devices    what to poll: one row per managed router/AP/switch, its position on the map, and its role:
//              is_root (the internet gateway, top of the map; overrides the automatic choice) and is_core
//              (a core switch: always on the row right under the gateway)
//   polls      latest poll per device: ok/error and the full normalised result as JSON
//   clients    every MAC address seen on any device, merged (IP, hostname, your label, position, and where you
//              said it's plugged in, if you did)
//   sightings  where each client is seen right now: which device, how (wifi/fdb/arp), on which interface
//   names      host names and IPs from DHCP leases and host hints, used only to label clients that are online
//   links      cables you drew between devices, from the upstream device (a_device) down to b_device
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
create table if not exists devices (
  id          integer primary key,
  name        text not null,
  driver      text not null default 'openwrt',
  host        text not null,
  port        integer,
  https       integer not null default 0,
  verify_tls  integer not null default 0,
  username    text not null default '',
  password    text not null default '',
  enabled     integer not null default 1,
  notes       text not null default '',
  x real, y real,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create table if not exists polls (
  device_id   integer primary key references devices(id) on delete cascade,
  polled_at   text not null,
  ok          integer not null,
  error       text,
  last_ok_at  text,
  result      text
);
create table if not exists clients (
  mac         text primary key,
  ip          text,
  hostname    text,
  label       text not null default '',
  first_seen  text not null,
  last_seen   text not null,
  x real, y real
);
create table if not exists sightings (
  device_id   integer not null references devices(id) on delete cascade,
  mac         text not null,
  via         text not null,          -- wifi | fdb | arp
  iface       text not null default '',
  detail      text,                   -- JSON: ssid, signal, rates, vlan, ...
  seen_at     text not null,
  primary key (device_id, mac, via)
);
create table if not exists links (
  id          integer primary key,
  a_device    integer not null references devices(id) on delete cascade,
  a_port      text not null default '',
  b_device    integer not null references devices(id) on delete cascade,
  b_port      text not null default '',
  source      text not null default 'manual',   -- manual | lldp
  note        text not null default '',
  seen_at     text
);
-- the last confirmed connection of each device (parent, ports, how it was found), so a link survives a
-- MAC-table entry ageing out for a while; see graph.js
create table if not exists uplinks (
  device_id   integer primary key references devices(id) on delete cascade,
  parent_id   integer not null references devices(id) on delete cascade,
  parent_port text not null default '',
  own_port    text not null default '',
  via         text not null,
  seen_at     text not null
);
-- extra ways to read a device next to its driver (see collectors/index.js), each with its own login;
-- host blank = the device's host
create table if not exists collectors (
  id          integer primary key,
  device_id   integer not null references devices(id) on delete cascade,
  kind        text not null,
  host        text not null default '',
  port        integer,
  https       integer not null default 1,
  verify_tls  integer not null default 0,
  username    text not null default '',
  password    text not null default '',
  enabled     integer not null default 1,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create table if not exists names (
  mac         text primary key,
  hostname    text not null default '',
  ip          text not null default '',
  device_id   integer references devices(id) on delete cascade,
  seen_at     text not null
);
create index if not exists sightings_mac on sightings(mac);
-- DHCP leases used to count as sightings; they outlive the device, so they no longer do.
delete from sightings where via = 'dhcp';
-- Host hints from OpenWrt 19.07 were once misread, storing the first character of the IP ("1").
update names set ip = '' where ip <> '' and ip not like '%.%' and ip not like '%:%';
update clients set ip = '' where ip <> '' and ip not like '%.%' and ip not like '%:%';
`;

// Columns added after the first release; added in place on older databases.
const ADDED_COLUMNS = [
  ["devices", "is_root", "integer not null default 0"],
  // the gateway's WAN jack when netmap can't tell (e.g. SNMP sees pppoe0 but not that it runs on eth5); '' = automatic
  ["devices", "wan_port", "text not null default ''"],
  // ports left off the map and faceplate (e.g. itf0), comma-separated; their clients still show
  ["devices", "hidden_ports", "text not null default ''"],
  ["devices", "is_core", "integer not null default 0"],
  // optional MAC of an unmanaged switch: lets the MAC tables place it automatically
  ["devices", "mac", "text not null default ''"],
  // Proxmox: which cluster node this device is
  ["devices", "node", "text not null default ''"],
  // polling paused until this time (ISO); null = polled normally. Far future = until resumed.
  ["devices", "paused_until", "text"],
  // where you've said a client is plugged in (overrides what the switches report); null = automatic
  ["clients", "placed_device", "integer"],
  ["clients", "placed_port", "text not null default ''"]
];

function open(file) {
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);
  for (const [table, col, type] of ADDED_COLUMNS) {
    if (!db.prepare(`pragma table_info(${table})`).all().some((c) => c.name === col)) db.exec(`alter table ${table} add column ${col} ${type}`);
  }
  // The map became a device tree; positions dragged in the old flat layout no longer fit it. Clear them once.
  db.exec("create table if not exists meta (key text primary key, value text)");
  if (!db.prepare("select 1 from meta where key = 'layout_tree'").get()) {
    db.exec("update devices set x = null, y = null; update clients set x = null, y = null;");
    db.prepare("insert into meta (key, value) values ('layout_tree', ?)").run(new Date().toISOString());
  }
  return db;
}

// Rows come back with a null prototype; make them plain objects for JSON.
const plain = (r) => (r ? { ...r } : r);
const all = (stmt, ...a) => stmt.all(...a).map(plain);

module.exports = { open, plain, all };
