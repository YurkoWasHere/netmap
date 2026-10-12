// MAC manufacturer lookup (OUI). The list is Wireshark's `manuf` file, built from the IEEE registries
// (MA-L /24, MA-M /28, MA-S /36). It's downloaded into the database on first run and refreshed monthly,
// so lookups work offline. Longest prefix wins.
const SOURCE = "https://www.wireshark.org/download/automated/data/manuf";
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const SCHEMA = `
create table if not exists oui (
  prefix  text primary key,   -- hex digits, no separators: 6 for /24, 7 for /28, 9 for /36
  vendor  text not null
);
create table if not exists meta (key text primary key, value text);
`;

let table = new Map(); // prefix -> vendor
let state = { count: 0, updatedAt: null, error: null, updating: false };

function load(db) {
  db.exec(SCHEMA);
  table = new Map(db.prepare("select prefix, vendor from oui").all().map((r) => [r.prefix, r.vendor]));
  const row = db.prepare("select value from meta where key = 'oui_updated_at'").get();
  state = { ...state, count: table.size, updatedAt: row ? row.value : null };
}

// "00:1B:C5:00:00/36  Convergi  Converging Systems Inc." -> ["001bc5000", "Converging Systems Inc."]
function parse(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [rawPrefix, short, long] = line.split("\t").map((s) => (s || "").trim());
    const [hex, bitsStr] = rawPrefix.split("/");
    const bits = Number(bitsStr) || 24;
    const digits = hex.replace(/[^0-9a-fA-F]/g, "").toLowerCase().slice(0, bits / 4);
    if (digits.length !== bits / 4 || ![24, 28, 36].includes(bits)) continue;
    const vendor = long || short;
    if (vendor && !/^00:00:00$/.test(short)) rows.push([digits, vendor]);
  }
  return rows;
}

async function update(db) {
  if (state.updating) return state;
  state.updating = true;
  try {
    const r = await fetch(SOURCE, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${SOURCE}`);
    const rows = parse(await r.text());
    if (rows.length < 10000) throw new Error(`only ${rows.length} entries in the download; keeping the old list`);
    db.exec("begin");
    try {
      db.exec("delete from oui");
      const ins = db.prepare("insert or replace into oui (prefix, vendor) values (?, ?)");
      for (const [p, v] of rows) ins.run(p, v);
      const now = new Date().toISOString();
      db.prepare("insert into meta (key, value) values ('oui_updated_at', ?) on conflict(key) do update set value = excluded.value").run(now);
      db.exec("commit");
      table = new Map(rows);
      state = { count: table.size, updatedAt: now, error: null, updating: false };
      console.log(`[${now}] manufacturer list updated: ${table.size} prefixes`);
    } catch (e) { db.exec("rollback"); throw e; }
  } catch (e) {
    state = { ...state, error: e.message || String(e), updating: false };
    console.error(`manufacturer list update failed: ${state.error}`);
  }
  return state;
}

// Download on first run, then whenever the list is more than a month old.
function refreshIfStale(db) {
  if (!state.updatedAt || Date.now() - Date.parse(state.updatedAt) > MAX_AGE_MS) return update(db);
  return Promise.resolve(state);
}

// The second-lowest bit of the first byte marks a locally administered address: phones and laptops use
// these as private Wi-Fi addresses, so no manufacturer owns them.
function lookup(mac) {
  const hex = (mac || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return null;
  if (parseInt(hex.slice(0, 2), 16) & 2) return { vendor: null, randomized: true };
  const vendor = table.get(hex.slice(0, 9)) || table.get(hex.slice(0, 7)) || table.get(hex.slice(0, 6)) || null;
  return { vendor, randomized: false };
}

module.exports = { load, update, refreshIfStale, lookup, status: () => ({ ...state }), parse };
