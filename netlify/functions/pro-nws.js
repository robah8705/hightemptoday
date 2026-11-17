// pro-nws.js — NWS api.weather.gov proxy for the Pro command center.
// Server-side so the required identifying User-Agent is always sent and no
// panel depends on a visitor's browser reaching api.weather.gov directly.
// Modes: meta&stid=KPHL · forecast&stid=KPHL · cli&code=PHL · obs&stid=KPHL&start=<iso>
const UA = { "User-Agent": "HighTempToday/1.0 (robah8705@gmail.com)", "Accept": "application/geo+json" };
const BASE = "https://api.weather.gov";

async function jget(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error("NWS " + r.status + " " + url); return r.json(); }
const ok = (body, cache) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": cache || "public, s-maxage=300, stale-while-revalidate=900", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const mode = q.mode || "";
  try {
    if (mode === "meta") {
      const stid = (q.stid || "").toUpperCase();
      const m = await jget(`${BASE}/stations/${stid}`);
      const [lon, lat] = m.geometry.coordinates;
      return ok({
        stid, name: m.properties.name, lat, lon,
        elevationFt: m.properties.elevation && m.properties.elevation.value != null ? Math.round(m.properties.elevation.value * 3.28084) : null,
        wfo: m.properties.forecastOffice ? m.properties.forecastOffice.split("/").pop() : null,
        timeZone: m.properties.timeZone || null
      });
    }
    if (mode === "forecast") {
      const stid = (q.stid || "").toUpperCase();
      const m = await jget(`${BASE}/stations/${stid}`);
      const [lon, lat] = m.geometry.coordinates;
      const pts = await jget(`${BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
      const fc = await jget(pts.properties.forecastHourly);
      const periods = (fc.properties.periods || []).map(p => ({
        startTime: p.startTime, temperature: p.temperature,
        windSpeed: p.windSpeed, relativeHumidity: p.relativeHumidity,
        dewpoint: p.dewpoint, probabilityOfPrecipitation: p.probabilityOfPrecipitation,
        shortForecast: p.shortForecast
      }));
      return ok({ stid, periods });
    }
    if (mode === "cli") {
      const code = (q.code || "").toUpperCase();
      const list = await jget(`${BASE}/products/types/CLI/locations/${code}`);
      const first = (list["@graph"] || [])[0];
      if (!first) return ok({ code, text: null });
      const prod = await jget(first["@id"]);
      return ok({ code, text: prod.productText || null, issued: first.issuanceTime }, "public, s-maxage=900, stale-while-revalidate=1800");
    }
    if (mode === "obs") {
      const stid = (q.stid || "").toUpperCase();
      const start = q.start || new Date(Date.now() - 86400e3).toISOString();
      const d = await jget(`${BASE}/stations/${stid}/observations?start=${encodeURIComponent(start)}&limit=250`);
      const rows = (d.features || []).map(f => ({
        t: Date.parse(f.properties.timestamp) / 1000,
        v: f.properties.temperature && f.properties.temperature.value != null ? f.properties.temperature.value * 9 / 5 + 32 : null,
        dew: f.properties.dewpoint && f.properties.dewpoint.value != null ? f.properties.dewpoint.value * 9 / 5 + 32 : null,
        wKt: f.properties.windSpeed && f.properties.windSpeed.value != null ? f.properties.windSpeed.value * 0.539957 : null,
        wDir: f.properties.windDirection ? f.properties.windDirection.value : null,
        sky: ""
      })).filter(o => o.v != null).sort((a, b) => a.t - b.t);
      return ok({ stid, rows }, "public, s-maxage=240, stale-while-revalidate=600");
    }
    return { statusCode: 400, body: JSON.stringify({ error: "mode required: meta|forecast|cli|obs" }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "NWS pull failed", detail: String(e && e.message || e) }) };
  }
};
