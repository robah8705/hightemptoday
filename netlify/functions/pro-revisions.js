// pro-revisions.js — Forecast Revision Feed data for the Pro command center
// (Phase 2). For the selected city: each model's latest run vs its run of
// ~24 hours ago (Open-Meteo Previous Runs API), as a change in today's
// projected high and peak hour; joined to the Kalshi bracket that contains
// the revised high (its current mid and its day move, last vs previous
// price). Entries are factual deltas only — no calls, per the neutral-
// language ruling. NBM cycle-over-cycle deltas join this feed once the
// morning scan publishes consecutive-cycle distributions.

const SERIES = {
  KPHX: "KXHIGHTPHX", KLAS: "KXHIGHTLV", KDFW: "KXHIGHTDAL", KHOU: "KXHIGHTHOU",
  KMIA: "KXHIGHMIA", KATL: "KXHIGHTATL", KLAX: "KXHIGHLAX", KSFO: "KXHIGHTSFO",
  KSAN: "KXHIGHTSAN", KDEN: "KXHIGHDEN", KMDW: "KXHIGHCHI", KMSP: "KXHIGHTMIN",
  KOKC: "KXHIGHTOKC", KMSY: "KXHIGHTNOLA", KSAT: "KXHIGHTSATX", KAUS: "KXHIGHAUS",
  KSDF: "KXHIGHTSDF", KNYC: "KXHIGHNY", KEWR: "KXHIGHTEWR", KTTN: "KXHIGHTTTN",
  KPHL: "KXHIGHPHIL", KDCA: "KXHIGHTDC", KBOS: "KXHIGHTBOS", KSEA: "KXHIGHTSEA",
};
// HRRR is deliberately excluded: the Previous Runs API silently falls back
// to best-match data for it (verified 2026-11-16 — its "previous run" was
// byte-identical to GFS), which would print a phantom duplicate revision.
const MODELS = [
  { id: "gfs_seamless", name: "GFS" },
  { id: "ecmwf_ifs025", name: "ECMWF" },
  { id: "icon_seamless", name: "ICON" },
];
const UA = { "User-Agent": "HighTempToday-Pro/1.0 (+https://hightemptoday.com)" };
const cents = (v) => (v == null || v === "" ? null : Math.round(parseFloat(v) * 100));

function localYmd(tz, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}
function kalshiEventTicker(series, ymd) {
  const [y, m, dd] = ymd.split("-").map(Number);
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][m - 1];
  return `${series}-${String(y).slice(2)}${mon}${String(dd).padStart(2, "0")}`;
}
function kalshiRange(m) {
  const f = m.floor_strike, c = m.cap_strike;
  if (m.strike_type === "less") return { lo: null, hi: c == null ? null : c - 1 };
  if (m.strike_type === "greater") return { lo: f == null ? null : f + 1, hi: null };
  return { lo: f ?? null, hi: c ?? null };
}
const rangeLabel = (r) =>
  r.lo == null ? `${r.hi}° or below` : r.hi == null ? `${r.lo}° or above` : `${r.lo}° to ${r.hi}°`;

async function fetchKalshi(station, ymd) {
  const series = SERIES[station];
  if (!series) return null;
  const et = kalshiEventTicker(series, ymd);
  const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${et}&limit=100`, { headers: UA });
  if (!r.ok) return null;
  const d = await r.json();
  const brackets = (d.markets || []).map((m) => {
    const range = kalshiRange(m);
    const bid = m.yes_bid ?? cents(m.yes_bid_dollars);
    const ask = m.yes_ask ?? cents(m.yes_ask_dollars);
    const last = cents(m.last_price_dollars);
    const prev = cents(m.previous_price_dollars);
    return {
      ...range, label: rangeLabel(range), bid, ask,
      mid: bid != null && ask != null ? (bid + ask) / 2 : null,
      last, prev, move: last != null && prev != null ? last - prev : null,
    };
  });
  const favorite = brackets.filter((b) => b.mid != null).sort((a, b) => b.mid - a.mid)[0] || null;
  return { brackets, favorite };
}

function dayMax(times, vals, ymd) {
  let best = null, bestH = null;
  for (let i = 0; i < times.length; i++) {
    if (!times[i].startsWith(ymd) || vals[i] == null) continue;
    if (best == null || vals[i] > best) { best = vals[i]; bestH = Number(times[i].slice(11, 13)); }
  }
  return best == null ? null : { high: best, hour: bestH };
}

async function fetchModelRevisions(lat, lon, tz, ymd) {
  const entries = [];
  await Promise.all(MODELS.map(async (mdl) => {
    try {
      const url = `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&hourly=temperature_2m,temperature_2m_previous_day1&models=${mdl.id}&forecast_days=2` +
        `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) return;
      const d = await r.json();
      const h = d.hourly || {};
      const cur = dayMax(h.time || [], h.temperature_2m || [], ymd);
      const prev = dayMax(h.time || [], h.temperature_2m_previous_day1 || [], ymd);
      if (!cur || !prev) return;
      const dHigh = Math.round((cur.high - prev.high) * 10) / 10;
      const dPeak = cur.hour - prev.hour;
      if (Math.abs(dHigh) < 1.0 && Math.abs(dPeak) < 1) return;
      entries.push({
        model: mdl.name, prevHigh: Math.round(prev.high * 10) / 10, newHigh: Math.round(cur.high * 10) / 10,
        dHigh, prevPeakHour: prev.hour, newPeakHour: cur.hour, dPeak,
      });
    } catch { /* a model that fails to return simply has no entry */ }
  }));
  return entries.sort((a, b) => Math.abs(b.dHigh) - Math.abs(a.dHigh));
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const station = (q.station || "").toUpperCase();
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon), tz = q.tz || "America/New_York";
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, s-maxage=600, stale-while-revalidate=120",
  };
  if (!station || Number.isNaN(lat) || Number.isNaN(lon)) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: "station, lat and lon are required", entries: [] }) };
  }
  const ymd = localYmd(tz);
  try {
    const [entries, kalshi] = await Promise.all([
      fetchModelRevisions(lat, lon, tz, ymd),
      fetchKalshi(station, ymd).catch(() => null),
    ]);
    for (const e of entries) {
      if (!kalshi) break;
      const v = Math.round(e.newHigh);
      e.bracket = kalshi.brackets.find((b) => (b.lo == null || v >= b.lo) && (b.hi == null || v <= b.hi)) || null;
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        station, date: ymd,
        window: "Latest model run vs the run of ~24 hours ago (Open-Meteo Previous Runs)",
        threshold: "Feed lists moves of 1° or more in the projected high, or a peak-hour shift of 1 hour or more",
        entries,
        favorite: kalshi ? kalshi.favorite : null,
        fetched_at: new Date().toISOString(),
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ station, error: String(e.message || e), entries: [] }) };
  }
};
