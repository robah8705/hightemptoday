// netlify/functions/markets.js  — v3
// Pulls live Kalshi daily-high temperature brackets (public API, no auth).
// v3 changes (2026-11-02): all 24 settlement-station series (was 7);
// volume / open interest now read the current *_fp field names (the old
// names went silent and the site had been showing no volume at all);
// adds 24h volume, last-vs-previous price movement, bid/ask size and
// spread per bracket, and a per-day top mover.

const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";

// City → Kalshi series + the station that ACTUALLY settles the contract.
// City names match temps.js exactly (the homepage joins the two feeds
// by city name). Series tickers verified live against the API
// 2026-11-02 — incl. San Diego = KXHIGHTSAN, Minneapolis = KXHIGHTMIN.
//   Chicago settles on Midway (KMDW), NOT O'Hare.
//   New York settles on Central Park (KNYC), NOT JFK/LGA/EWR.
//   Houston settles on Hobby (KHOU), NOT Bush.
//   Austin settles on Bergstrom (KAUS), NOT Camp Mabry.
const SERIES = [
  { city: "Phoenix",       series: "KXHIGHTPHX", station: "KPHX" },
  { city: "Las Vegas",     series: "KXHIGHTLV",  station: "KLAS" },
  { city: "Dallas",        series: "KXHIGHTDAL", station: "KDFW" },
  { city: "Houston",       series: "KXHIGHTHOU", station: "KHOU" },
  { city: "Miami",         series: "KXHIGHMIA",  station: "KMIA" },
  { city: "Atlanta",       series: "KXHIGHTATL", station: "KATL" },
  { city: "Los Angeles",   series: "KXHIGHLAX",  station: "KLAX" },
  { city: "San Francisco", series: "KXHIGHTSFO", station: "KSFO" },
  { city: "San Diego",     series: "KXHIGHTSAN", station: "KSAN" },
  { city: "Denver",        series: "KXHIGHDEN",  station: "KDEN" },
  { city: "Chicago",       series: "KXHIGHCHI",  station: "KMDW" },
  { city: "Minneapolis",   series: "KXHIGHTMIN", station: "KMSP" },
  { city: "Oklahoma City", series: "KXHIGHTOKC", station: "KOKC" },
  { city: "New Orleans",   series: "KXHIGHTNOLA", station: "KMSY" },
  { city: "San Antonio",   series: "KXHIGHTSATX", station: "KSAT" },
  { city: "Austin",        series: "KXHIGHAUS",  station: "KAUS" },
  { city: "Louisville",    series: "KXHIGHTSDF", station: "KSDF" },
  { city: "New York",      series: "KXHIGHNY",   station: "KNYC" },
  { city: "Newark",        series: "KXHIGHTEWR", station: "KEWR" },
  { city: "Trenton",       series: "KXHIGHTTTN", station: "KTTN" },
  { city: "Philadelphia",  series: "KXHIGHPHIL", station: "KPHL" },
  { city: "Washington DC", series: "KXHIGHTDC",  station: "KDCA" },
  { city: "Boston",        series: "KXHIGHTBOS", station: "KBOS" },
  { city: "Seattle",       series: "KXHIGHTSEA", station: "KSEA" },
];

let cache = { data: null, at: 0 };
const CACHE_MS = 60 * 1000;

// Kalshi event tickers look like KXHIGHNY-26OCT19 — pull the date out
// as a plain YYYY-MM-DD string (no Date object, no timezone shifting).
function eventDateFromTicker(eventTicker) {
  if (!eventTicker) return null;
  const m = eventTicker.match(/-(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const [, yy, mon, dd] = m;
  const months = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
                   JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
  if (!months[mon]) return null;
  return `20${yy}-${months[mon]}-${dd}`;
}

// Returns YYYY-MM-DD in US Eastern, where Kalshi operates.
function easternDateString(d) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function settlementDate(market) {
  const fromTicker = eventDateFromTicker(market.event_ticker);
  if (fromTicker) return fromTicker;
  if (market.close_time) {
    const d = new Date(market.close_time);
    if (!isNaN(d)) return easternDateString(d);
  }
  return null;
}

function dayLabel(dateStr) {
  if (!dateStr) return "unknown";
  const today = easternDateString(new Date());
  const tomorrow = easternDateString(new Date(Date.now() + 86400000));
  if (dateStr === today) return "today";
  if (dateStr === tomorrow) return "tomorrow";
  return dateStr;
}

// Kalshi's current API reports counts as fractional "fp" strings
// (e.g. volume_fp: "1175.75"). Round to whole contracts for display.
function fp(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : Math.round(n);
}

function readVolume(m) {
  return fp(m.volume_fp) ?? m.volume ?? m.total_volume ?? m.dollar_volume ?? 0;
}

function readVolume24(m) {
  return fp(m.volume_24h_fp) ?? m.volume_24h ?? m.dollar_volume_24h ?? 0;
}

function readOpenInterest(m) {
  return fp(m.open_interest_fp) ?? m.open_interest ?? m.openInterest ?? 0;
}

// Dollar-string price ("0.88") → whole cents (88). Null-safe.
function cents(dollars) {
  if (dollars == null) return null;
  const n = parseFloat(dollars);
  return isNaN(n) ? null : Math.round(n * 100);
}

async function fetchSeries(entry) {
  const url = `${KALSHI_BASE}/markets?series_ticker=${entry.series}&status=open&limit=200`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "HighTempToday/1.0" },
  });

  if (!res.ok) return null;

  const json = await res.json();
  const raw = json.markets || [];
  if (raw.length === 0) return null;

  // Bucket markets by their settlement day
  const byDay = {};

  for (const m of raw) {
    const date = settlementDate(m);
    const label = dayLabel(date);

    const yesBid = m.yes_bid ?? cents(m.yes_bid_dollars);
    const yesAsk = m.yes_ask ?? cents(m.yes_ask_dollars);
    const mid = (yesBid != null && yesAsk != null)
      ? Math.round((yesBid + yesAsk) / 2)
      : (yesBid ?? yesAsk);

    if (mid == null) continue;

    const lastPrice = cents(m.last_price_dollars);
    const prevPrice = cents(m.previous_price_dollars);
    const move = (lastPrice != null && prevPrice != null) ? lastPrice - prevPrice : null;

    const bracket = {
      ticker: m.ticker,
      title: m.title || m.subtitle || m.yes_sub_title || "",
      subtitle: m.yes_sub_title || m.subtitle || "",
      floor: m.floor_strike ?? null,
      cap: m.cap_strike ?? null,
      yes_bid: yesBid,
      yes_ask: yesAsk,
      mid_price: mid,
      last_price: lastPrice,
      prev_price: prevPrice,
      move: move,
      spread: (yesBid != null && yesAsk != null) ? yesAsk - yesBid : null,
      bid_size: fp(m.yes_bid_size_fp),
      ask_size: fp(m.yes_ask_size_fp),
      volume: readVolume(m),
      volume_24h: readVolume24(m),
      open_interest: readOpenInterest(m),
      close_time: m.close_time || null,
    };

    if (!byDay[label]) {
      byDay[label] = {
        day: label,
        date: date,
        event_ticker: m.event_ticker || null,
        brackets: [],
      };
    }
    byDay[label].brackets.push(bracket);
  }

  // Finalize each day bucket
  const days = Object.values(byDay).map(d => {
    d.brackets.sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0));
    d.favorite = d.brackets.reduce((best, b) =>
      (b.mid_price > (best?.mid_price ?? -1) ? b : best), null);
    d.total_volume = d.brackets.reduce((s, b) => s + (b.volume || 0), 0);
    d.total_volume_24h = d.brackets.reduce((s, b) => s + (b.volume_24h || 0), 0);
    d.total_open_interest = d.brackets.reduce((s, b) => s + (b.open_interest || 0), 0);
    // Biggest single-bracket price move of the day (last vs previous).
    const movers = d.brackets.filter(b => b.move != null && b.move !== 0);
    const top = movers.length
      ? movers.reduce((best, b) => (Math.abs(b.move) > Math.abs(best.move) ? b : best))
      : null;
    d.top_mover = top ? { subtitle: top.subtitle, move: top.move, last_price: top.last_price } : null;
    d.bracket_count = d.brackets.length;
    return d;
  });

  // today first, then tomorrow, then anything further out
  const order = { today: 0, tomorrow: 1 };
  days.sort((a, b) => (order[a.day] ?? 2) - (order[b.day] ?? 2));

  return {
    city: entry.city,
    series: entry.series,
    settlement_station: entry.station,
    kalshi_url: `https://kalshi.com/markets/${entry.series.toLowerCase()}`,
    days,
  };
}

exports.handler = async () => {
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      body: JSON.stringify(cache.data),
    };
  }

  try {
    const settled = await Promise.allSettled(SERIES.map(fetchSeries));

    const cities = settled
      .filter(r => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value);

    // sort by today's 24h volume (the action), falling back to
    // total volume, then open interest
    cities.sort((a, b) => {
      const av = a.days[0]?.total_volume_24h || a.days[0]?.total_volume || a.days[0]?.total_open_interest || 0;
      const bv = b.days[0]?.total_volume_24h || b.days[0]?.total_volume || b.days[0]?.total_open_interest || 0;
      return bv - av;
    });

    const payload = {
      cities,
      count: cities.length,
      fetched_at: new Date().toISOString(),
      source: "Kalshi public Trade API v2",
      note: "Kalshi settles on the official NWS daily climate report for the listed station, not live ASOS readings.",
    };

    cache = { data: payload, at: Date.now() };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
      body: JSON.stringify(payload),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
