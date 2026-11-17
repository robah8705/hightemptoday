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
//
// The netCDF reader below is INLINED on purpose: this repo has no build step
// and Netlify never installed the dependency from netlify/functions/
// package.json, so `require("netcdfjs")` died in production with
// Runtime.ImportModuleError. The inline reader is dependency-free (Node
// builtins only) and mirrors netcdfjs semantics exactly — including its use
// of the header vsize (padded) as the per-record element count and its
// single-trailing-null trim on char values — so extraction output is
// byte-for-byte identical to the netcdfjs build (verified locally against
// real HFMETAR files, 2026-11-16).
const zlib = require("zlib");

// ==== BEGIN inline netCDF3 reader (no external deps) ====
// Minimal classic-format (CDF-1 / CDF-2) reader: header parse (dims, attrs
// skipped, vars with type/vsize/begin) + getDataVariable(name) with the same
// return shapes as netcdfjs — record vars come back as one entry per record
// (scalar when the per-record width is 1, an array for numeric/byte widths
// > 1, a string for char), non-record vars as a flat element list.
const NC_TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 }; // byte char short int float double

function ncScalar(buf, off, type) {
  switch (type) {
    case 1: return buf[off]; // byte: unsigned, as netcdfjs Array.from(readBytes)
    case 3: return buf.readInt16BE(off);
    case 4: return buf.readInt32BE(off);
    case 5: return buf.readFloatBE(off);
    case 6: return buf.readDoubleBE(off);
    default: throw new Error("non valid type " + type);
  }
}

function ncReadType(buf, off, type, count) {
  if (type === 2) { // char: one string, built per byte like iobuffer readChars
    let s = "";
    for (let i = 0; i < count; i++) s += String.fromCharCode(buf.readInt8(off + i));
    if (s.length && s.charCodeAt(s.length - 1) === 0) s = s.substring(0, s.length - 1); // trimNull: one trailing NUL
    return s;
  }
  if (type === 1) { // byte: array of unsigned values
    const a = new Array(count);
    for (let i = 0; i < count; i++) a[i] = buf[off + i];
    return a;
  }
  if (count === 1) return ncScalar(buf, off, type);
  const tb = NC_TYPE_BYTES[type];
  const a = new Array(count);
  for (let i = 0; i < count; i++) a[i] = ncScalar(buf, off + i * tb, type);
  return a;
}

class NcCursor {
  constructor(buf) { this.b = buf; this.o = 0; }
  u32() { const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
  pad() { const m = this.o % 4; if (m) this.o += 4 - m; }
  name() {
    const n = this.u32();
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b.readInt8(this.o++));
    this.pad();
    return s;
  }
  attrs() { // parse-and-skip an attribute list (values not needed by callers)
    const tag = this.u32();
    if (tag === 0) {
      if (this.u32() !== 0) throw new Error("Not a valid NetCDF v3.x file: wrong empty tag for list of attributes");
      return;
    }
    if (tag !== 12) throw new Error("Not a valid NetCDF v3.x file: wrong tag for list of attributes");
    const n = this.u32();
    for (let i = 0; i < n; i++) {
      this.name();
      const type = this.u32();
      if (type < 1 || type > 6) throw new Error("Not a valid NetCDF v3.x file: non valid type " + type);
      const count = this.u32();
      this.o += count * NC_TYPE_BYTES[type];
      this.pad();
    }
  }
}

function ncParseHeader(buf) {
  if (buf.length < 4 || buf.toString("latin1", 0, 3) !== "CDF") {
    throw new Error("Not a valid NetCDF v3.x file: should start with CDF");
  }
  const version = buf[3];
  if (version > 2) throw new Error("Not a valid NetCDF v3.x file: unknown version");
  const c = new NcCursor(buf);
  c.o = 4;
  const numrecs = c.u32();
  // Dimension list; the dim with size 0 is the record dimension.
  let recordId;
  const dimTag = c.u32();
  if (dimTag === 0) {
    if (c.u32() !== 0) throw new Error("Not a valid NetCDF v3.x file: wrong empty tag for list of dimensions");
  } else {
    if (dimTag !== 10) throw new Error("Not a valid NetCDF v3.x file: wrong tag for list of dimensions");
    const n = c.u32();
    for (let i = 0; i < n; i++) {
      c.name();
      if (c.u32() === 0) recordId = i;
    }
  }
  c.attrs(); // global attributes
  // Variable list.
  const vars = [];
  let recordStep = 0;
  const varTag = c.u32();
  if (varTag === 0) {
    if (c.u32() !== 0) throw new Error("Not a valid NetCDF v3.x file: wrong empty tag for list of variables");
  } else {
    if (varTag !== 11) throw new Error("Not a valid NetCDF v3.x file: wrong tag for list of variables");
    const n = c.u32();
    for (let i = 0; i < n; i++) {
      const name = c.name();
      const nd = c.u32();
      const dimIds = new Array(nd);
      for (let d = 0; d < nd; d++) dimIds[d] = c.u32();
      c.attrs();
      const type = c.u32();
      const vsize = c.u32();
      let offset = c.u32();
      if (version === 2) { // 64-bit begin: high word must be 0, low word follows
        if (offset > 0) throw new Error("Not a valid NetCDF v3.x file: offsets larger than 4GB not supported");
        offset = c.u32();
      }
      const record = recordId !== undefined && dimIds[0] === recordId;
      if (record) recordStep += vsize;
      vars.push({ name, dimensions: dimIds, type, size: vsize, offset, record });
    }
  }
  return { numrecs, recordStep, vars };
}

class NetCDFReader {
  constructor(data) {
    this._buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const h = ncParseHeader(this._buf);
    this._numrecs = h.numrecs;
    this._recordStep = h.recordStep;
    this._vars = h.vars;
  }
  getDataVariable(name) {
    const v = this._vars.find(x => x.name === name);
    if (!v) throw new Error("Not a valid NetCDF v3.x file: variable not found");
    const tb = NC_TYPE_BYTES[v.type];
    if (v.record) {
      // Per-record slice width comes from the header vsize (already padded),
      // exactly as netcdfjs computes it; records stride by recordStep.
      const width = v.size ? v.size / tb : 1;
      const out = new Array(this._numrecs);
      for (let i = 0; i < this._numrecs; i++) {
        out[i] = ncReadType(this._buf, v.offset + i * this._recordStep, v.type, width);
      }
      return out;
    }
    const size = v.size / tb;
    const out = new Array(size);
    for (let i = 0; i < size; i++) out[i] = ncReadType(this._buf, v.offset + i * tb, v.type, 1);
    return out;
  }
}
// ==== END inline netCDF3 reader ====

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
