// tape-live.js — Settled Tape LIVE: today's Kalshi daily-high tape so far,
// across all 24 cities. Rolling pull of the public trades feed, deduped on
// the exchange's trade_id (Kalshi's cursor pagination repeats ~4–6% of
// prints). Everything here is UNSETTLED — prints are shown as size and side
// only (the tape is anonymous by design), never as a signal. The graded
// scoreboards still land in the next-day recap, as before.
// Pull discipline (learned from the desk's 429s): Kalshi's limiter trips on
// bursts, so pulls run through a 2-wide pool with spacing — never a wide
// parallel batch. Scope is bounded on purpose: market lists for all 24
// events (cheap, complete), then trade prints for the most-traded markets
// only (big prints live there by construction). A soft deadline stops new
// pulls and returns labeled partial coverage rather than timing out; a 429
// stops the pull. The payload always states its coverage.

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = {
  NYC: "KXHIGHNY", MIA: "KXHIGHMIA", CHI: "KXHIGHCHI", DEN: "KXHIGHDEN",
  PHL: "KXHIGHPHIL", LAX: "KXHIGHLAX", AUS: "KXHIGHAUS", EWR: "KXHIGHTEWR",
  TTN: "KXHIGHTTTN", DC: "KXHIGHTDC", BOS: "KXHIGHTBOS", NOLA: "KXHIGHTNOLA",
  ATL: "KXHIGHTATL", SDF: "KXHIGHTSDF", HOU: "KXHIGHTHOU", DAL: "KXHIGHTDAL",
  OKC: "KXHIGHTOKC", MIN: "KXHIGHTMIN", SFO: "KXHIGHTSFO", LV: "KXHIGHTLV",
  PHX: "KXHIGHTPHX", SEA: "KXHIGHTSEA", SATX: "KXHIGHTSATX", SAN: "KXHIGHTSAN",
};
const CITY_NAME = {
  NYC: "New York", MIA: "Miami", CHI: "Chicago", DEN: "Denver", PHL: "Philadelphia",
  LAX: "Los Angeles", AUS: "Austin", EWR: "Newark", TTN: "Trenton", DC: "Washington DC",
  BOS: "Boston", NOLA: "New Orleans", ATL: "Atlanta", SDF: "Louisville", HOU: "Houston",
  DAL: "Dallas", OKC: "Oklahoma City", MIN: "Minneapolis", SFO: "San Francisco",
  LV: "Las Vegas", PHX: "Phoenix", SEA: "Seattle", SATX: "San Antonio", SAN: "San Diego",
};
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const UA = { "User-Agent": "HighTempToday-TapeLive/1.0 (+https://hightemptoday.com)" };
const DEADLINE_MS = 18000;
const TOP_MARKETS = 36;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function etYmd(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}
function etMidnightEpoch(ymd) {
  // Epoch of 00:00 America/New_York on ymd: binary search on the ET
  // wall-clock key (date packed with time-of-day), hourCycle h23.
  const [y, m, dd] = ymd.split("-").map(Number);
  const key = (e) => {
    const p = {};
    for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(e * 1000))) p[x.type] = +x.value;
    return ((p.year * 100 + p.month) * 100 + p.day) * 86400 + p.hour * 3600 + p.minute * 60 + p.second;
  };
  const target = ((y * 100 + m) * 100 + dd) * 86400;
  let lo = Date.UTC(y, m - 1, dd) / 1000 - 14 * 3600, hi = Date.UTC(y, m - 1, dd) / 1000 + 14 * 3600;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (key(mid) < target) lo = mid + 1; else hi = mid; }
  return lo;
}

async function getJSON(path, params, state) {
  const url = BASE + path + "?" + new URLSearchParams(params).toString();
  const r = await fetch(url, { headers: UA });
  if (r.status === 429) { state.rateLimited = true; throw new Error("rate limited"); }
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function pool(items, width, fn, state, started) {
  let i = 0;
  const workers = Array.from({ length: width }, async () => {
    while (i < items.length) {
      if (state.rateLimited || Date.now() - started > DEADLINE_MS) return;
      const item = items[i++];
      try { await fn(item); } catch { /* gaps are reported as coverage */ }
      await sleep(150);
    }
  });
  await Promise.all(workers);
}

exports.handler = async () => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, s-maxage=600, stale-while-revalidate=180",
  };
  const started = Date.now();
  const state = { rateLimited: false };
  const ymd = etYmd();
  const [y, m, dd] = ymd.split("-").map(Number);
  const suffix = `${String(y).slice(2)}${MONTHS[m - 1]}${String(dd).padStart(2, "0")}`;
  const minTs = etMidnightEpoch(ymd);
  try {
    // 1) Market lists for all 24 events — sequential, spaced.
    const markets = [];
    let volumeAll = 0;
    for (const [code, series] of Object.entries(SERIES)) {
      if (state.rateLimited) break;
      try {
        const d = await getJSON("/markets", { event_ticker: `${series}-${suffix}`, limit: 200 }, state);
        for (const mm of d.markets || []) {
          const vol = parseFloat(mm.volume_fp || 0);
          volumeAll += vol;
          markets.push({ code, ticker: mm.ticker, bracket: mm.yes_sub_title || "", vol });
        }
      } catch { /* event gap shows up in coverage */ }
      await sleep(120);
    }
    // 2) Trade prints for the most-traded markets only, 2-wide pool.
    const targets = [...markets].sort((a, b) => b.vol - a.vol).slice(0, TOP_MARKETS);
    const seen = new Set();
    const trades = [];
    let marketsPulled = 0, truncated = 0;
    await pool(targets, 2, async (mk) => {
      const resp = await getJSON("/markets/trades", { ticker: mk.ticker, limit: 1000, min_ts: minTs }, state);
      for (const t of resp.trades || []) {
        const tid = t.trade_id;
        if (tid != null) { if (seen.has(tid)) continue; seen.add(tid); }
        trades.push({
          city: mk.code, cityName: CITY_NAME[mk.code], ticker: mk.ticker, bracket: mk.bracket,
          time: t.created_time, count: parseFloat(t.count_fp),
          yesPrice: parseFloat(t.yes_price_dollars),
          side: t.taker_outcome_side, block: !!t.is_block_trade,
        });
      }
      if (resp.cursor) truncated++;
      marketsPulled++;
    }, state, started);
    // 3) Aggregates.
    const risk = (t) => t.count * (t.side === "yes" ? t.yesPrice : 1 - t.yesPrice);
    const byCity = {};
    const accum = {};
    for (const t of trades) {
      const c = byCity[t.code] || (byCity[t.code] = { code: t.code, cityName: t.cityName, contracts: 0, trades: 0, takerYes: 0, takerNo: 0 });
      c.contracts += t.count; c.trades++; if (t.side === "yes") c.takerYes += t.count; else c.takerNo += t.count;
      const k = `${t.code}|${t.bracket}|${t.side}`;
      const a = accum[k] || (accum[k] = { city: t.code, cityName: t.cityName, bracket: t.bracket, side: t.side, contracts: 0, dollars: 0 });
      a.contracts += t.count; a.dollars += risk(t);
    }
    const fmtT = (t) => ({
      city: t.code, cityName: t.cityName, bracket: t.bracket, side: t.side,
      count: Math.round(t.count),
      // The price the TAKER paid (the recap's convention): Yes prints show
      // the yes price; No prints show 100 minus it.
      priceC: Math.round((t.side === "yes" ? t.yesPrice : 1 - t.yesPrice) * 100),
      dollars: Math.round(risk(t) * 100) / 100, time: t.time, block: t.block,
    });
    const body = {
      date: ymd, unsettled: true, fetched_at: new Date().toISOString(),
      coverage: {
        marketsPulled, marketsTargeted: targets.length, marketsTotal: markets.length,
        truncatedMarkets: truncated,
        partial: marketsPulled < targets.length, rateLimited: state.rateLimited,
        note: "Prints and piles cover the most-traded markets (where size lives); city volume below is complete for all 24 cities from Kalshi market data.",
      },
      totals: {
        trades: trades.length,
        contracts: Math.round(trades.reduce((a, t) => a + t.count, 0)),
        volumeAllCities: Math.round(volumeAll),
        markets: new Set(trades.map((t) => t.ticker)).size,
        blocks: trades.filter((t) => t.block).length,
      },
      cityVolume: Object.values(markets.reduce((acc, mk) => {
        const c = acc[mk.code] || (acc[mk.code] = { code: mk.code, cityName: CITY_NAME[mk.code], contracts: 0, markets: 0 });
        c.contracts += mk.vol; c.markets++; return acc;
      }, {})).sort((a, b) => b.contracts - a.contracts).map((c) => ({ ...c, contracts: Math.round(c.contracts) })),
      byCity: Object.values(byCity).sort((a, b) => b.contracts - a.contracts)
        .map((c) => ({ ...c, contracts: Math.round(c.contracts), takerYes: Math.round(c.takerYes), takerNo: Math.round(c.takerNo) })),
      largestByContracts: [...trades].sort((a, b) => b.count - a.count).slice(0, 10).map(fmtT),
      largestByDollars: [...trades].sort((a, b) => risk(b) - risk(a)).slice(0, 10).map(fmtT),
      accumulations: Object.values(accum).filter((a) => a.contracts >= 1000)
        .sort((a, b) => b.contracts - a.contracts).slice(0, 8)
        .map((a) => ({ ...a, contracts: Math.round(a.contracts), dollars: Math.round(a.dollars), vwapC: Math.round(100 * a.dollars / a.contracts) })),
    };
    return { statusCode: 200, headers, body: JSON.stringify(body) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ date: ymd, error: String(e.message || e), totals: null }) };
  }
};
