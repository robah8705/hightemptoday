// pro-xvenue.js — Cross-venue board data for the Pro command center (Phase 2).
// For the six cities verified on 2026-11-16 to settle IDENTICALLY on Kalshi
// and Polymarket US (same station, same NWS Climatological Report (Daily)),
// returns both venues' brackets aligned by exact integer range with top of
// book. All other stations return { matched: false } — no second venue is
// shown for them rather than showing a differently-settling price.
// Sources: Kalshi public API (api.elections.kalshi.com) and the Polymarket US
// public gateway (gateway.polymarket.us, no key). Verification record:
// CROSS-VENUE-VERIFICATION-2026-11-16.md.

const CITIES = {
  KPHL: { city: "Philadelphia", series: "KXHIGHPHIL", pmus: "phl" },
  KMDW: { city: "Chicago", series: "KXHIGHCHI", pmus: "mdw" },
  KLAX: { city: "Los Angeles", series: "KXHIGHLAX", pmus: "lax" },
  KMIA: { city: "Miami", series: "KXHIGHMIA", pmus: "mia" },
  KNYC: { city: "New York", series: "KXHIGHNY", pmus: "nyc" },
  KSFO: { city: "San Francisco", series: "KXHIGHTSFO", pmus: "sfo" },
};

const UA = { "User-Agent": "HighTempToday-Pro/1.0 (+https://hightemptoday.com)" };

function etDate(d = new Date()) {
  // YYYY-MM-DD in America/New_York
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}
function kalshiEventTicker(series, ymd) {
  const [y, m, dd] = ymd.split("-").map(Number);
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][m - 1];
  return `${series}-${String(y).slice(2)}${mon}${String(dd).padStart(2, "0")}`;
}
const cents = (v) => (v == null || v === "" ? null : Math.round(parseFloat(v) * 100));
const fp = (v) => (v == null || v === "" ? null : parseFloat(v));

// Kalshi strikes by strike_type (verified against yes_sub_title 2026-11-16):
// 'between' -> [floor, cap] inclusive; 'less' -> hi = cap-1; 'greater' -> lo = floor+1.
function kalshiRange(m) {
  const f = m.floor_strike, c = m.cap_strike;
  if (m.strike_type === "less") return { lo: null, hi: c == null ? null : c - 1 };
  if (m.strike_type === "greater") return { lo: f == null ? null : f + 1, hi: null };
  return { lo: f ?? null, hi: c ?? null };
}
// Polymarket US range from the market's own rule text (authoritative).
function pmusRange(desc) {
  let m = desc.match(/less than or equal to (\d+)F/);
  if (m) return { lo: null, hi: Number(m[1]) };
  m = desc.match(/greater than or equal to (\d+)F/);
  if (m) return { lo: Number(m[1]), hi: null };
  m = desc.match(/between (\d+)F and (\d+)F/);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]) };
  return null;
}
const rangeKey = (r) => `${r.lo == null ? "-inf" : r.lo}..${r.hi == null ? "inf" : r.hi}`;
const rangeLabel = (r) =>
  r.lo == null ? `${r.hi}° or below` : r.hi == null ? `${r.lo}° or above` : `${r.lo}° to ${r.hi}°`;

async function fetchKalshi(series, ymd) {
  const et = kalshiEventTicker(series, ymd);
  const url = `https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${et}&limit=100`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`kalshi ${r.status}`);
  const d = await r.json();
  return (d.markets || []).map((m) => {
    const range = kalshiRange(m);
    const bid = m.yes_bid ?? cents(m.yes_bid_dollars);
    const ask = m.yes_ask ?? cents(m.yes_ask_dollars);
    return {
      ...range, bid, ask,
      mid: bid != null && ask != null ? (bid + ask) / 2 : null,
      bidSize: fp(m.yes_bid_size_fp), askSize: fp(m.yes_ask_size_fp),
    };
  }).filter((b) => b.lo != null || b.hi != null);
}

async function fetchPmus(code, ymd) {
  const slug = `temp-${code}high-${ymd}`;
  const r = await fetch(`https://gateway.polymarket.us/v1/events/slug/${slug}`, { headers: UA });
  if (!r.ok) throw new Error(`pmus ${r.status}`);
  const d = await r.json();
  const ev = d.event;
  if (!ev || !Array.isArray(ev.markets)) throw new Error("pmus bad payload");
  const brackets = [];
  for (const m of ev.markets) {
    const range = pmusRange(m.description || "");
    if (!range) continue;
    const yes = (m.marketSides || []).find((s) => s.long) || {};
    const bid = yes.price != null ? Math.round(parseFloat(yes.price) * 100) : null;
    const ask = yes.quote && yes.quote.value != null ? Math.round(parseFloat(yes.quote.value) * 100) : null;
    brackets.push({
      ...range, bid, ask,
      mid: bid != null && ask != null ? (bid + ask) / 2 : null,
      slug: m.slug, feeCoefficient: m.feeCoefficient ?? null,
    });
  }
  // Top of book per bracket from the book endpoint (fresher than the event
  // payload's side quotes); fall back to the payload values when it fails.
  await Promise.all(brackets.map(async (b) => {
    try {
      const br = await fetch(`https://gateway.polymarket.us/v1/markets/${b.slug}/book`, { headers: UA });
      if (!br.ok) return;
      const book = await br.json();
      const md = book.marketData || book;
      const bids = md.bids || [], offers = md.offers || [];
      if (bids.length) { b.bid = Math.round(parseFloat(bids[0].px.value) * 100); b.bidQty = parseFloat(bids[0].qty); }
      if (offers.length) { b.ask = Math.round(parseFloat(offers[0].px.value) * 100); b.askQty = parseFloat(offers[0].qty); }
      b.mid = b.bid != null && b.ask != null ? (b.bid + b.ask) / 2 : null;
    } catch { /* book is best effort */ }
  }));
  return { brackets, eventUrl: `https://polymarket.us/event/${slug}` };
}

exports.handler = async (event) => {
  const station = (event.queryStringParameters?.station || "").toUpperCase();
  const cfg = CITIES[station];
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, s-maxage=120, stale-while-revalidate=60",
  };
  if (!cfg) {
    return { statusCode: 200, headers, body: JSON.stringify({ matched: false, station, reason: "No verified second venue for this city. Polymarket US carries six cities; Polymarket global and Robinhood settle differently and are not shown." }) };
  }
  const ymd = etDate();
  try {
    const [kalshi, pmus] = await Promise.all([
      fetchKalshi(cfg.series, ymd).catch((e) => { throw new Error(`Kalshi feed failed: ${e.message}`); }),
      fetchPmus(cfg.pmus, ymd).catch((e) => { throw new Error(`Polymarket US feed failed: ${e.message}`); }),
    ]);
    const byKey = new Map();
    for (const b of kalshi) byKey.set(rangeKey(b), { range: b, label: rangeLabel(b), kalshi: b, pmus: null });
    for (const b of pmus.brackets) {
      const k = rangeKey(b);
      if (byKey.has(k)) byKey.get(k).pmus = b;
      else byKey.set(k, { range: b, label: rangeLabel(b), kalshi: null, pmus: b });
    }
    const sortKey = (r) => (r.lo == null ? (r.hi ?? 0) : r.lo) + (r.hi == null ? 0.25 : 0);
    const rows = [...byKey.values()].sort((a, b) => sortKey(a.range) - sortKey(b.range));
    for (const row of rows) {
      row.gap = row.kalshi?.mid != null && row.pmus?.mid != null
        ? Math.round((row.pmus.mid - row.kalshi.mid) * 10) / 10 : null;
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        matched: true, station, city: cfg.city, date: ymd,
        basis: "Same station · same NWS Climatological Report (Daily) on both venues — verified 2026-11-16",
        pmusEventUrl: pmus.eventUrl, rows, fetched_at: new Date().toISOString(),
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ matched: true, station, city: cfg.city, error: String(e.message || e), rows: [] }) };
  }
};
