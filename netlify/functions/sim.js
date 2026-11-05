// sim.js — Paper Peak live simulator feed (Netlify function).
// mode=board: today's open daily-high markets for the 24 stations from Kalshi's
// public API (no auth), plus each station's NWS high-so-far for its local day.
// mode=results&tickers=A,B: settlement results for specific market tickers.
// The simulator itself (bankroll, positions, fills) runs entirely in the
// visitor's browser; this function only serves public market data, the same
// way /.netlify/functions/markets serves the dashboard.
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const UA = { "Accept": "application/json", "User-Agent": "HighTempToday/1.0" };

const STATIONS = [
  { city: "Phoenix", stid: "KPHX", tz: "America/Phoenix", series: "KXHIGHTPHX" },
  { city: "Las Vegas", stid: "KLAS", tz: "America/Los_Angeles", series: "KXHIGHTLV" },
  { city: "Dallas", stid: "KDFW", tz: "America/Chicago", series: "KXHIGHTDAL" },
  { city: "Houston", stid: "KHOU", tz: "America/Chicago", series: "KXHIGHTHOU" },
  { city: "Miami", stid: "KMIA", tz: "America/New_York", series: "KXHIGHMIA" },
  { city: "Atlanta", stid: "KATL", tz: "America/New_York", series: "KXHIGHTATL" },
  { city: "Los Angeles", stid: "KLAX", tz: "America/Los_Angeles", series: "KXHIGHLAX" },
  { city: "San Francisco", stid: "KSFO", tz: "America/Los_Angeles", series: "KXHIGHTSFO" },
  { city: "San Diego", stid: "KSAN", tz: "America/Los_Angeles", series: "KXHIGHTSAN" },
  { city: "Denver", stid: "KDEN", tz: "America/Denver", series: "KXHIGHDEN" },
  { city: "Chicago", stid: "KMDW", tz: "America/Chicago", series: "KXHIGHCHI" },
  { city: "Minneapolis", stid: "KMSP", tz: "America/Chicago", series: "KXHIGHTMIN" },
  { city: "Oklahoma City", stid: "KOKC", tz: "America/Chicago", series: "KXHIGHTOKC" },
  { city: "New Orleans", stid: "KMSY", tz: "America/Chicago", series: "KXHIGHTNOLA" },
  { city: "San Antonio", stid: "KSAT", tz: "America/Chicago", series: "KXHIGHTSATX" },
  { city: "Austin", stid: "KAUS", tz: "America/Chicago", series: "KXHIGHAUS" },
  { city: "Louisville", stid: "KSDF", tz: "America/Kentucky/Louisville", series: "KXHIGHTSDF" },
  { city: "New York", stid: "KNYC", tz: "America/New_York", series: "KXHIGHNY" },
  { city: "Newark", stid: "KEWR", tz: "America/New_York", series: "KXHIGHTEWR" },
  { city: "Trenton", stid: "KTTN", tz: "America/New_York", series: "KXHIGHTTTN" },
  { city: "Philadelphia", stid: "KPHL", tz: "America/New_York", series: "KXHIGHPHIL" },
  { city: "Washington DC", stid: "KDCA", tz: "America/New_York", series: "KXHIGHTDC" },
  { city: "Boston", stid: "KBOS", tz: "America/New_York", series: "KXHIGHTBOS" },
  { city: "Seattle", stid: "KSEA", tz: "America/Los_Angeles", series: "KXHIGHTSEA" },
];

const cents = d => (d == null ? null : Math.round(parseFloat(d) * 100));
function rawKey(sub) {
  let m = /^(\d+)° to (\d+)°$/.exec(sub || "");
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d+)° or below$/.exec(sub || "");
  if (m) return `<=${m[1]}`;
  m = /^(\d+)° or above$/.exec(sub || "");
  if (m) return `>=${m[1]}`;
  return sub;
}
function localDayKey(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function etTodaySuffix() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "2-digit", month: "short", day: "2-digit" }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get("year")}${get("month").toUpperCase()}${get("day")}`;
}
async function fetchJSON(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function seriesBoard(entry, todaySuffix) {
  const json = await fetchJSON(`${KALSHI_BASE}/markets?series_ticker=${entry.series}&status=open&limit=200`);
  const byEvent = {};
  for (const m of json.markets || []) (byEvent[m.event_ticker] ||= []).push(m);
  const events = Object.keys(byEvent);
  let ev = events.find(e => e.endsWith("-" + todaySuffix));
  let day = todaySuffix;
  if (!ev) {
    // Today's event is not open (settled or not yet posted): take the earliest open event.
    const dated = events.map(e => ({ e, suf: e.split("-").pop() })).sort((a, b) => a.suf < b.suf ? -1 : 1);
    if (!dated.length) return { ...entry, brackets: [], event: null };
    ev = dated[0].e; day = dated[0].suf;
  }
  const brackets = byEvent[ev].map(m => ({
    ticker: m.ticker, label: m.yes_sub_title, raw: rawKey(m.yes_sub_title),
    bid: cents(m.yes_bid_dollars), ask: cents(m.yes_ask_dollars),
    last: cents(m.last_price_dollars), vol: m.volume_fp ?? null,
    floor: m.floor_strike ?? null,
  })).sort((a, b) => (a.floor ?? -1e9) - (b.floor ?? -1e9));
  return { station: entry.stid, city: entry.city, tz: entry.tz, series: entry.series, event: ev, day, brackets };
}

async function stationHigh(entry) {
  const start = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const url = `https://api.weather.gov/stations/${entry.stid}/observations?start=${encodeURIComponent(start)}&limit=250`;
  const res = await fetch(url, { headers: { "User-Agent": "HighTempToday/1.0 (robah8705@gmail.com)", "Accept": "application/geo+json" } });
  if (!res.ok) return null;
  const data = await res.json();
  const today = localDayKey(new Date(), entry.tz);
  let high = null;
  for (const f of data.features || []) {
    const ts = f.properties?.timestamp, c = f.properties?.temperature?.value;
    if (!ts || c == null) continue;
    if (localDayKey(new Date(ts), entry.tz) !== today) continue;
    const fahr = c * 9 / 5 + 32;
    if (high === null || fahr > high) high = fahr;
  }
  return high === null ? null : Math.round(high * 10) / 10;
}

async function board() {
  const todaySuffix = etTodaySuffix();
  const stations = [];
  for (let i = 0; i < STATIONS.length; i += 4) {           // sequential batches of 4 (the v3.1 lesson)
    const batch = STATIONS.slice(i, i + 4);
    const got = await Promise.allSettled(batch.map(e => seriesBoard(e, todaySuffix)));
    got.forEach((r, j) => stations.push(r.status === "fulfilled" ? r.value : { station: batch[j].stid, city: batch[j].city, tz: batch[j].tz, series: batch[j].series, brackets: [], event: null }));
  }
  const highs = await Promise.allSettled(STATIONS.map(e => stationHigh(e)));
  stations.forEach((s, i) => { s.high_so_far = highs[i].status === "fulfilled" ? highs[i].value : null; });
  const day = stations.find(s => s.day)?.day || todaySuffix;
  return { as_of: new Date().toISOString(), board_day: day, is_today: day === todaySuffix, stations };
}

async function results(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 4) {
    const batch = tickers.slice(i, i + 4);
    const got = await Promise.allSettled(batch.map(t => fetchJSON(`${KALSHI_BASE}/markets/${t}`)));
    got.forEach((r, j) => { if (r.status === "fulfilled") out[batch[j]] = { result: r.value.market?.result || "", status: r.value.market?.status || "" }; });
  }
  return { results: out };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    if (q.mode === "results") {
      const tickers = (q.tickers || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 60);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(await results(tickers)) };
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" }, body: JSON.stringify(await board()) };
  } catch (e) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
