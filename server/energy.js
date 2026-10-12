// PoE energy: a PoE switch reports the power it's delivering right now (watts, POWER-ETHERNET-MIB). Sampling
// that every poll and adding power x time gives energy, kept per device per day in the database.
// Between two samples the power is taken as their average. Gaps longer than MAX_GAP (server down, device not
// answering) aren't counted rather than guessed. The last sample is kept in memory, so after a restart counting
// resumes from the second poll.
const MAX_GAP_MS = 10 * 60 * 1000;
const last = new Map(); // deviceId -> { t, w }

function init(db) {
  db.exec(`create table if not exists energy (
    device_id integer not null references devices(id) on delete cascade,
    day       text not null,              -- local date, YYYY-MM-DD
    wh        real not null default 0,
    primary key (device_id, day)
  )`);
}

// local calendar day, so "today" means the server's today
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function record(db, deviceId, watts, t = Date.now()) {
  if (watts == null || !isFinite(watts) || watts < 0) return;
  const prev = last.get(deviceId);
  last.set(deviceId, { t, w: watts });
  if (!prev || t <= prev.t || t - prev.t > MAX_GAP_MS) return;
  const wh = ((prev.w + watts) / 2) * ((t - prev.t) / 3600000);
  db.prepare(`insert into energy (device_id, day, wh) values (?, ?, ?)
    on conflict(device_id, day) do update set wh = wh + excluded.wh`).run(deviceId, dayOf(t), wh);
}

// { todayWh, weekWh, totalWh, since } per device id
function summary(db, t = Date.now()) {
  const today = dayOf(t), weekStart = dayOf(t - 6 * 86400000);
  const out = {};
  for (const r of db.prepare(`select device_id, sum(wh) total, min(day) since,
      sum(case when day = ? then wh else 0 end) today, sum(case when day >= ? then wh else 0 end) week
    from energy group by device_id`).all(today, weekStart)) {
    out[r.device_id] = { todayWh: r.today, weekWh: r.week, totalWh: r.total, since: r.since };
  }
  return out;
}

module.exports = { init, record, summary };
