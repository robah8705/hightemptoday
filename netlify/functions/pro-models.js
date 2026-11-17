// pro-models.js — Open-Meteo proxy for the Pro command center.
// mode=forecast&lat&lon&tz → hourly temperature_2m for GFS / ECMWF IFS /
// ICON / HRRR (2 days). mode=bias&lat&lon&tz → the same models from the
// historical-forecast API for the last 31 days (the page computes each
// model's daily-high bias against IEM's observed highs).
const UA = { "User-Agent": "HighTempToday/1.0 (robah8705@gmail.com)" };
const MODELS = "gfs_seamless,ecmwf_ifs025,icon_seamless,ncep_hrrr_conus";
const ok = (body, cache) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": cache || "public, s-maxage=900, stale-while-revalidate=1800", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon), tz = q.tz || "UTC";
  if (isNaN(lat) || isNaN(lon)) return { statusCode: 400, body: JSON.stringify({ error: "lat/lon required" }) };
  try {
    if (q.mode === "forecast") {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&models=${MODELS}&forecast_days=2&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error("Open-Meteo " + r.status);
      const d = await r.json();
      return ok({ utc_offset_seconds: d.utc_offset_seconds, hourly: d.hourly });
    }
    if (q.mode === "bias") {
      const iso = d => d.toISOString().slice(0, 10);
      const end = new Date(Date.now() - 86400e3), start = new Date(Date.now() - 31 * 86400e3);
      const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${iso(start)}&end_date=${iso(end)}&hourly=temperature_2m&models=${MODELS}&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error("Open-Meteo hist " + r.status);
      const d = await r.json();
      return ok({ hourly: d.hourly }, "public, s-maxage=21600, stale-while-revalidate=43200");
    }
    return { statusCode: 400, body: JSON.stringify({ error: "mode required: forecast|bias" }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "model pull failed", detail: String(e && e.message || e) }) };
  }
};
