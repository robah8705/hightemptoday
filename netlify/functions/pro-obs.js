// pro-obs.js — 5-minute ASOS observations from NOAA MADIS public HFMETAR.
// Source: https://madis-data.ncep.noaa.gov/madisPublic1/data/LDAD/hfmetar/netCDF/
// Hourly netCDF files (YYYYMMDD_HH00.gz), each carrying 5-minute records for
// ~9,000 stations; the current hour's file is rewritten as prints land
// (measured latency ~8 min, 2026-11-16). Public tier is 5-minute only —
// 1-minute obs are Gov/NOAA tier (MADIS ruling, 2026-11-16).
// KNYC (Central Park) is NOT in HFMETAR — it returns an empty series and the
// page falls back to NWS hourly obs for that station.
// Modes: ?stid=KPHL&mode=recent (last 2 hour-files)
//        ?stid=KPHL&mode=day&from=<epoch-hour> (files from that UTC hour to now)
const zlib = require("zlib");
const { NetCDFReader } = require("netcdfjs");

const BASE = "https://madis-data.ncep.noaa.gov/madisPublic1/data/LDAD/hfmetar/netCDF/";
const UA = { "User-Agent": "HighTempToday/1.0 (robah8705@gmail.com)" };
const K2F = k => (k == null || k > 400 || k < 150) ? null : Math.round(((k - 273.15) * 9 / 5 + 32) * 10) / 10;
const MS2KT = v => (v == null || v > 9000) ? null : Math.round(v * 1.94384);

function hourStamp(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}00`;
}

async function fetchHour(stamp) {
  const res = await fetch(BASE + stamp + ".gz", { headers: UA });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return zlib.gunzipSync(buf);
}

function extract(ncBuf, stid) {
  const r = new NetCDFReader(ncBuf);
  const sids = r.getDataVariable("stationId");
  const obs = r.getDataVariable("observationTime");
  const tmp = r.getDataVariable("temperature");
  const dew = r.getDataVariable("dewpoint");
  const wd = r.getDataVariable("windDir");
  const ws = r.getDataVariable("windSpeed");
  let sky = null;
  try { sky = r.getDataVariable("skyCvr"); } catch (e) { /* older files */ }
  const out = [];
  for (let i = 0; i < sids.length; i++) {
    const id = (Array.isArray(sids[i]) ? sids[i].join("") : String(sids[i])).replace(/\0/g, "").trim();
    if (id !== stid) continue;
    let skyTxt = "";
    if (sky && sky[i]) {
      const layers = Array.isArray(sky[i]) ? sky[i] : [sky[i]];
      skyTxt = layers.map(l => (Array.isArray(l) ? l.join("") : String(l)).replace(/\0/g, "").trim()).filter(Boolean).join(" ");
    }
    out.push({
      t: Number(obs[i]),
      tempF: K2F(Number(tmp[i])),
      dewF: K2F(Number(dew[i])),
      wDir: (wd[i] == null || Number(wd[i]) > 9000) ? null : Math.round(Number(wd[i])),
      wKt: MS2KT(ws[i] == null ? null : Number(ws[i])),
      sky: skyTxt
    });
  }
  return out;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const stid = (q.stid || "").toUpperCase();
  if (!/^[A-Z]{4}$/.test(stid)) {
    return { statusCode: 400, body: JSON.stringify({ error: "stid required (e.g. KPHL)" }) };
  }
  const mode = q.mode === "day" ? "day" : "recent";
  const now = new Date();
  const stamps = [];
  if (mode === "recent") {
    for (let h = 1; h >= 0; h--) stamps.push(hourStamp(new Date(now.getTime() - h * 3600e3)));
  } else {
    let fromH = parseInt(q.from || "0", 10);
    const nowH = Math.floor(now.getTime() / 3600e3);
    if (!fromH || fromH < nowH - 30 || fromH > nowH) fromH = nowH - 23;
    for (let h = fromH; h <= nowH; h++) stamps.push(hourStamp(new Date(h * 3600e3)));
  }
  try {
    const bufs = await Promise.all(stamps.map(s => fetchHour(s).catch(() => null)));
    let rows = [];
    bufs.forEach(b => { if (b) rows = rows.concat(extract(b, stid)); });
    rows.sort((a, b) => a.t - b.t);
    rows = rows.filter((r, i) => i === 0 || r.t !== rows[i - 1].t);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=240, stale-while-revalidate=600",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ stid, mode, source: "MADIS HFMETAR 5-min", generatedAt: new Date().toISOString(), obs: rows })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "HFMETAR pull failed", detail: String(e && e.message || e) }) };
  }
};
