// netlify/functions/markets.js
// Pulls live Kalshi daily-high temperature brackets (public API, no auth needed).

const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";

// City → Kalshi series + the station that ACTUALLY settles the contract.
// NOTE: settlement stations are not always the obvious airport.
//   Chicago settles on Midway (KMDW), NOT O'Hare.
//   New York settles on Central Park (KNYC), NOT JFK/LGA/EWR.
//   Houston settles on Hobby (KHOU), NOT Bush.
//   Austin settles on Bergstrom (KAUS), NOT Camp Mabry.
const SERIES = [
  { city: "New York",      series: "KXHIGHNY",   station: "KNYC" },
  { city: "Chicago",       series: "KXHIGHCHI",  station: "KMDW" },
  { city: "Los Angeles",   series: "KXHIGHLAX",  station: "KLAX" },
  { city: "Miami",         series: "KXHIGHMIA",  station: "KMIA" },
  { city: "Austin",        series: "KXHIGHAUS",  station: "KAUS" },
  { city: "Denver",        series: "KXHIGHDEN",  station: "KDEN" },
  { city: "Philadelphia",  series: "KXHIGHPHIL", station: "KPHL" },
  // Below are reported to exist but ticker spelling is less certain.
  // Any that 404 are silently skipped, so it's safe to leave them in.
  { city: "Phoenix",       series: "KXHIGHPHX",  station: "KPHX" },
  { city: "Dallas",        series: "KXHIGHDFW",  station: "KDFW" },
  { city: "Houston",       series: "KXHIGHHOU",  station: "KHOU" },
  { city: "Seattle",       series: "KXHIGHSEA",  station: "KSEA" },
  { city: "Atlanta",       series: "KXHIGHATL",  station: "KATL" },
  { city: "Boston",        series: "KXHIGHBOS",  station: "KBOS" },
  { city: "Las Vegas",     series: "KXHIGHLAS",  station: "KLAS" },
  { city: "Minneapolis",   series: "KXHIGHMSP",  station: "KMSP" },
  { city: "Washington DC", series: "KXHIGHDC",   station: "KDCA" },
  { city: "San Diego",     series: "KXHIGHSAN",  station: "KSAN" },
];

// simple in-memory cache so we don't hammer Kalshi's public endpoint
let cache = { data: null, at: 0 };
const CACHE_MS = 60 * 1000; // 60 seconds

async function fetchSeries(entry) {
  const url = `${KALSHI_BASE}/markets?series_ticker=${entry.series}&status=open&limit=60`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "HighTempToday/1.0" },
  });

  if (!res.ok) return null; // 404 = series ticker doesn't exist; skip quietly

  const json = await res.json();
  const markets = json.markets || [];
  if (markets.length === 0) return null;

  // Normalize each bracket
  const brackets = markets.map(m => {
    // Kalshi returns prices in cents on `yes_bid` / `yes_ask`,
    // and dollar strings on the *_dollars fields. Prefer cents, fall back.
    const yesBid = m.yes_bid ?? (m.yes_bid_dollars ? Math.round(parseFloat(m.yes_bid_dollars) * 100) : null);
    const yesAsk = m.yes_ask ?? (m.yes_ask_dollars ? Math.round(parseFloat(m.yes_ask_dollars) * 100) : null);
    const mid = (yesBid != null && yesAsk != null) ? Math.round((yesBid + yesAsk) / 2) : (yesBid ?? yesAsk);

    return {
      ticker: m.ticker,
      title: m.title || m.subtitle || m.yes_sub_title || "",
      subtitle: m.yes_sub_title || m.subtitle || "",
      floor: m.floor_strike ?? null,
      cap: m.cap_strike ?? null,
      yes_bid: yesBid,
      yes_ask: yesAsk,
      mid_price: mid,                       // implied probability in cents
      volume: m.volume ?? 0,
      open_interest: m.open_interest ?? 0,
      close_time: m.close_time || null,
    };
  })
  // only keep brackets with an actual market
  .filter(b => b.mid_price != null)
  // sort low bracket → high bracket
  .sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0));

  if (brackets.length === 0) return null;

  // the bracket the market currently thinks is most likely
  const favorite = brackets.reduce((best, b) =>
    (b.mid_price > (best?.mid_price ?? -1) ? b : best), null);

  const totalVolume = brackets.reduce((s, b) => s + (b.volume || 0), 0);

  return {
    city: entry.city,
    series: entry.series,
    settlement_station: entry.station,
    event_ticker: markets[0].event_ticker || null,
    kalshi_url: `https://kalshi.com/markets/${entry.series.toLowerCase()}`,
    bracket_count: brackets.length,
    total_volume: totalVolume,
    favorite,
    brackets,
  };
}

exports.handler = async () => {
  // serve cache if fresh
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
      .map(r => r.value)
      // busiest markets first — that's where the edge is
      .sort((a, b) => b.total_volume - a.total_volume);

    const payload = {
      cities,
      count: cities.length,
      fetched_at: new Date().toISOString(),
      source: "Kalshi public Trade API v2",
      note: "Kalshi settles on the official daily climate report for the listed station, not live ASOS readings.",
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
