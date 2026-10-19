// netlify/functions/markets.js  — v2
// Pulls live Kalshi daily-high temperature brackets (public API, no auth).
// v2 changes: groups markets by settlement DAY, broader volume field detection.

const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";

// City → Kalshi series + the station that ACTUALLY settles the contract.
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
  
// Volume can appear under several names depending on endpoint/tier.
function readVolume(m) {
  return m.volume
      ?? m.volume_24h
      ?? m.total_volume
      ?? m.dollar_volume
      ?? m.dollar_volume_24h
      ?? 0;
}

function readOpenInterest(m) {
  return m.open_interest ?? m.openInterest ?? 0;
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

    const yesBid = m.yes_bid ?? (m.yes_bid_dollars ? Math.round(parseFloat(m.yes_bid_dollars) * 100) : null);
    const yesAsk = m.yes_ask ?? (m.yes_ask_dollars ? Math.round(parseFloat(m.yes_ask_dollars) * 100) : null);
    const mid = (yesBid != null && yesAsk != null)
      ? Math.round((yesBid + yesAsk) / 2)
      : (yesBid ?? yesAsk);

    if (mid == null) continue;

    const bracket = {
      ticker: m.ticker,
      title: m.title || m.subtitle || m.yes_sub_title || "",
      subtitle: m.yes_sub_title || m.subtitle || "",
      floor: m.floor_strike ?? null,
      cap: m.cap_strike ?? null,
      yes_bid: yesBid,
      yes_ask: yesAsk,
      mid_price: mid,
      volume: readVolume(m),
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
    d.total_open_interest = d.brackets.reduce((s, b) => s + (b.open_interest || 0), 0);
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

    // sort by today's volume where available, else open interest
    cities.sort((a, b) => {
      const av = a.days[0]?.total_volume || a.days[0]?.total_open_interest || 0;
      const bv = b.days[0]?.total_volume || b.days[0]?.total_open_interest || 0;
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
