// pro-precompute-background.js — Pro Command Center precompute worker.
//
// Kicked every 5 minutes by pro-precompute.js (a scheduled function, which
// itself is capped at 30s — too short for a 24-city pull). Background
// functions get 15 minutes. This worker composes the EXISTING per-city
// function handlers in-process (no extra function invocations, no duplicated
// upstream logic), assembles one bundle JSON per city, and stores them in
// Netlify Blobs (store "pro-bundles", keys "city-<STID>" + "meta").
// pro-bundle.js serves one bundle per request so pro.html makes a single
// fast call per city instead of ~10.
//
// Zero-dependency: the Blobs client below is hand-rolled against the same
// HTTP API the official @netlify/blobs SDK uses (context arrives in
// event.blobs for Lambda-compat functions, or NETLIFY_BLOBS_CONTEXT).
// Local dev fallback: if PRO_BLOB_DIR is set, bundles go to that directory.

const fs = require("fs");
const path = require("path");

const STORE = "site:pro-bundles";
const RUN_DEADLINE_MS = 12 * 60 * 1000;
const CALL_TIMEOUT_MS = 30000;
const CITY_POOL = 4;

const CITIES = [
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

// ---------- blob storage (edge mode direct; API mode via signed URLs) ----------
function blobConfig(event) {
  try {
    const d = JSON.parse(Buffer.from((event && event.blobs) || "", "base64").toString());
    const h = (event && event.headers) || {};
    const sid = h["x-nf-site-id"] || h["X-Nf-Site-Id"] || d.siteID;
    if (d.url && d.token && sid) return { edge: d.url, token: d.token, siteID: sid };
  } catch (e) { /* fall through */ }
  try {
    const c = JSON.parse(Buffer.from(process.env.NETLIFY_BLOBS_CONTEXT || "", "base64").toString());
    if (c.token && c.siteID && (c.edgeURL || c.apiURL)) return { edge: c.edgeURL, api: c.apiURL, token: c.token, siteID: c.siteID };
  } catch (e) { /* fall through */ }
  return null;
}

async function blobPut(event, key, text) {
  if (process.env.PRO_BLOB_DIR) {
    fs.mkdirSync(process.env.PRO_BLOB_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PRO_BLOB_DIR, key), text);
    return;
  }
  const cfg = blobConfig(event);
  if (!cfg) throw new Error("blobs_not_configured");
  const auth = { authorization: `Bearer ${cfg.token}` };
  if (cfg.edge) {
    const r = await fetch(`${cfg.edge}/${cfg.siteID}/${STORE}/${key}`, {
      method: "PUT", headers: { ...auth, "cache-control": "max-age=0, stale-while-revalidate=60" }, body: text,
    });
    if (!(r.status === 200 || r.status === 204)) throw new Error("blob_put_" + r.status);
    return;
  }
  const base = `${cfg.api || "https://api.netlify.com"}/api/v1/blobs/${cfg.siteID}/${STORE}/${key}`;
  const s = await fetch(base, { method: "PUT", headers: { ...auth, accept: "application/json;type=signed-url" } });
  if (s.status !== 200) throw new Error("blob_put_sign_" + s.status);
  const { url } = await s.json();
  const r = await fetch(url, { method: "PUT", headers: { "cache-control": "max-age=0, stale-while-revalidate=60" }, body: text });
  if (!(r.status === 200 || r.status === 204)) throw new Error("blob_put_" + r.status);
}

// ---------- timezone helpers (mirror pro.html's todayStart) ----------
function parts(epochSec, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  const o = {};
  for (const p of f.formatToParts(new Date(epochSec * 1000))) if (p.type !== "literal") o[p.type] = +p.value;
  return { y: o.year, m: o.month, d: o.day, h: o.hour, min: o.minute, s: o.second };
}
function zonedMidnight(tz, y, m, d) {
  // Epoch seconds of local midnight on y-m-d in tz (iterative offset solve).
  let guess = Date.UTC(y, m - 1, d) / 1000;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess, tz);
    const localAsUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) / 1000;
    const target = Date.UTC(y, m - 1, d) / 1000;
    guess += target - localAsUTC;
  }
  return guess;
}
function todayStart(tz) { const n = parts(Date.now() / 1000, tz); return zonedMidnight(tz, n.y, n.m, n.d); }

// ---------- in-process handler composition ----------
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout:" + label)), ms)),
  ]);
}
async function call(handler, qs, label, timeoutMs) {
  try {
    const r = await withTimeout(Promise.resolve().then(() => handler({ queryStringParameters: qs || {}, headers: {} })), timeoutMs || CALL_TIMEOUT_MS, label);
    if (!r || r.statusCode !== 200) return null;
    return JSON.parse(r.body);
  } catch (e) { return null; }
}

function sectionJobs(entry, b, handlers, timeoutMs) {
  const { nwsH, iemH, modelsH, revH, xvH } = handlers;
  const code3 = entry.stid.slice(1);
  const jobs = {
    nwsForecast: () => call(nwsH, { mode: "forecast", stid: entry.stid }, "forecast", timeoutMs),
    nwsCli: () => call(nwsH, { mode: "cli", code: code3 }, "cli", timeoutMs),
    iem: () => call(iemH, { stid: code3, days: "30" }, "iem", timeoutMs),
    xvenue: () => call(xvH, { station: entry.stid }, "xvenue", timeoutMs),
  };
  if (b.lat != null) {
    jobs.modelsForecast = () => call(modelsH, { mode: "forecast", lat: String(b.lat), lon: String(b.lon), tz: entry.tz }, "modelsFc", timeoutMs),
    jobs.modelsBias = () => call(modelsH, { mode: "bias", lat: String(b.lat), lon: String(b.lon), tz: entry.tz }, "modelsBias", timeoutMs),
    jobs.revisions = () => call(revH, { station: entry.stid, lat: String(b.lat), lon: String(b.lon), tz: entry.tz }, "revisions", timeoutMs);
  }
  return jobs;
}

async function buildCity(entry, marketsPayload, handlers) {
  const { obsH, nwsH, iemH, modelsH, revH, xvH } = handlers;
  const code3 = entry.stid.slice(1);
  const day0 = todayStart(entry.tz);
  const fromHour = Math.floor(day0 / 3600);
  const b = {
    v: 1, station: entry.stid, series: entry.series, tz: entry.tz,
    generated_at: new Date().toISOString(), fromHour,
    obsDay: null, nwsObs: null, nwsMeta: null, nwsForecast: null, nwsCli: null,
    iem: null, modelsForecast: null, modelsBias: null, revisions: null, xvenue: null,
    markets: null, lat: null, lon: null,
  };
  const [meta, obsDay] = await Promise.all([
    call(nwsH, { mode: "meta", stid: entry.stid }, "meta"),
    call(obsH, { stid: entry.stid, mode: "day", from: String(fromHour) }, "obsDay"),
  ]);
  b.nwsMeta = meta; b.obsDay = obsDay;
  if (meta && meta.lat != null) { b.lat = meta.lat; b.lon = meta.lon; }
  const lat = b.lat, lon = b.lon;
  const jobList = Object.entries(sectionJobs(entry, b, handlers));
  // NWS obs fallback only when MADIS is thin — exactly the page's rule.
  const rows = obsDay && Array.isArray(obsDay.obs) ? obsDay.obs.filter(o => o.t >= day0 && o.tempF != null) : [];
  if (rows.length < 6) {
    const start = new Date(day0 * 1000).toISOString();
    jobList.push(["nwsObs", () => call(nwsH, { mode: "obs", stid: entry.stid, start }, "nwsObs")]);
  }
  const results = await Promise.allSettled(jobList.map(j => j[1]()));
  results.forEach((r, i) => { b[jobList[i][0]] = r.status === "fulfilled" ? r.value : null; });
  if (marketsPayload) {
    const c = (marketsPayload.cities || []).find(x => x.series === entry.series);
    b.markets = c ? { ...marketsPayload, cities: [c] } : marketsPayload;
  }
  return b;
}

exports.handler = async (event) => {
  const started = Date.now();
  const handlers = {
    obsH: require("./pro-obs.js").handler,
    nwsH: require("./pro-nws.js").handler,
    iemH: require("./pro-iem.js").handler,
    modelsH: require("./pro-models.js").handler,
    revH: require("./pro-revisions.js").handler,
    xvH: require("./pro-xvenue.js").handler,
  };
  const marketsH = require("./markets.js").handler;
  const marketsPayload = await call(marketsH, {}, "markets");

  const status = {};
  const built = [];
  let idx = 0;
  async function worker() {
    while (idx < CITIES.length) {
      if (Date.now() - started > RUN_DEADLINE_MS) return;
      const entry = CITIES[idx++];
      try {
        const bundle = await buildCity(entry, marketsPayload, handlers);
        built.push({ entry, bundle });
        await blobPut(event, "city-" + entry.stid, JSON.stringify(bundle));
        const filled = Object.keys(bundle).filter(k => bundle[k] != null && !["v", "station", "series", "tz", "generated_at", "fromHour"].includes(k)).length;
        status[entry.stid] = "ok:" + filled;
      } catch (e) {
        status[entry.stid] = "error:" + (e && e.message || "unknown");
      }
    }
  }
  await Promise.all(Array.from({ length: CITY_POOL }, worker));

  // Repair pass: sections that lost the parallel race (notably the large
  // Open-Meteo forecast pull, which timed out for most cities in testing)
  // get one sequential retry each with a longer timeout.
  for (const { entry, bundle } of built) {
    if (Date.now() - started > RUN_DEADLINE_MS) break;
    const jobs = sectionJobs(entry, bundle, handlers, 60000);
    let fixed = 0;
    for (const [key, fn] of Object.entries(jobs)) {
      if (bundle[key] != null) continue;
      const v = await fn();
      if (v != null) { bundle[key] = v; fixed++; }
    }
    if (fixed) {
      try {
        await blobPut(event, "city-" + entry.stid, JSON.stringify(bundle));
        status[entry.stid] += "+repaired:" + fixed;
      } catch (e) { /* keep the unrepaired bundle */ }
    }
  }
  const meta = { generated_at: new Date().toISOString(), duration_ms: Date.now() - started, cities: status };
  try { await blobPut(event, "meta", JSON.stringify(meta)); } catch (e) { /* non-fatal */ }
  return { statusCode: 200, body: JSON.stringify(meta) };
};
