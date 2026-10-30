// ── FEED SWITCH ──
// 2026-10-30: Synoptic's account access is blocked on THEIR side (their API
// answers "Unauthorized. Review your account access settings in the customer
// console") and their support has been contacted. While SYNOPTIC_ENABLED is
// false this function serves National Weather Service data directly, so the
// daily card tool keeps working. When Synoptic confirms the fix, set this
// back to true — Synoptic becomes primary again, with NWS staying on as the
// automatic fallback if Synoptic ever errors.
const SYNOPTIC_ENABLED = false;

const cities = [
  { city: "Phoenix",        state: "AZ", stid: "KPHX", tz: "America/Phoenix" },
  { city: "Las Vegas",      state: "NV", stid: "KLAS", tz: "America/Los_Angeles" },
  { city: "Dallas",         state: "TX", stid: "KDFW", tz: "America/Chicago" },
  { city: "Houston",        state: "TX", stid: "KHOU", tz: "America/Chicago" },
  { city: "Miami",          state: "FL", stid: "KMIA", tz: "America/New_York" },
  { city: "Atlanta",        state: "GA", stid: "KATL", tz: "America/New_York" },
  { city: "Los Angeles",    state: "CA", stid: "KLAX", tz: "America/Los_Angeles" },
  { city: "San Francisco",  state: "CA", stid: "KSFO", tz: "America/Los_Angeles" },
  { city: "San Diego",      state: "CA", stid: "KSAN", tz: "America/Los_Angeles" },
  { city: "Denver",         state: "CO", stid: "KDEN", tz: "America/Denver" },
  { city: "Chicago",        state: "IL", stid: "KMDW", tz: "America/Chicago" },
  { city: "Minneapolis",    state: "MN", stid: "KMSP", tz: "America/Chicago" },
  { city: "Oklahoma City",  state: "OK", stid: "KOKC", tz: "America/Chicago" },
  { city: "New Orleans",    state: "LA", stid: "KMSY", tz: "America/Chicago" },
  { city: "San Antonio",    state: "TX", stid: "KSAT", tz: "America/Chicago" },
  { city: "Austin",         state: "TX", stid: "KAUS", tz: "America/Chicago" },
  { city: "Louisville",     state: "KY", stid: "KSDF", tz: "America/Kentucky/Louisville" },
  { city: "New York",       state: "NY", stid: "KNYC", tz: "America/New_York" },
  { city: "Newark",         state: "NJ", stid: "KEWR", tz: "America/New_York" },
  { city: "Trenton",        state: "NJ", stid: "KTTN", tz: "America/New_York" },
  { city: "Philadelphia",   state: "PA", stid: "KPHL", tz: "America/New_York" },
  { city: "Washington DC",  state: "DC", stid: "KDCA", tz: "America/New_York" },
  { city: "Boston",         state: "MA", stid: "KBOS", tz: "America/New_York" },
  { city: "Seattle",        state: "WA", stid: "KSEA", tz: "America/Los_Angeles" },
];

// "Today" for a station means the station's own local calendar day.
// Returns a YYYY-MM-DD key for the given instant in the given IANA zone.
function localDayKey(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Synoptic wants YYYYMMDDHHMM (UTC) for timeseries start/end.
function synopticTime(date) {
  const p = n => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

function jsonResponse(payload) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(payload),
  };
}

// ── PRIMARY FEED: Synoptic ──
// Throws on any Synoptic failure so the handler can fall back to NWS.
async function synopticResponse() {
  const stids = cities.map(c => c.stid).join(',');
  const token = process.env.SYNOPTIC_TOKEN;
  const latestUrl = `https://api.synopticdata.com/v2/stations/latest?stid=${stids}&vars=air_temp&units=temp|F&token=${token}`;

  const res = await fetch(latestUrl);
  if (!res.ok) throw new Error(`Synoptic returned ${res.status}`);
  const data = await res.json();
  const stations = data.STATION || [];

  // ---- High so far today (per station's local day) ----
  // One batched timeseries call for the last 30 hours covers every
  // station's local "today" no matter its timezone; observations are
  // then filtered to each station's own local calendar day in code.
  // Any failure here is non-fatal: highs fall back to current temps.
  const highs = {};
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 60 * 60 * 1000);
    const tsUrl = `https://api.synopticdata.com/v2/stations/timeseries?stid=${stids}&vars=air_temp&units=temp|F&start=${synopticTime(start)}&end=${synopticTime(now)}&token=${token}`;
    const tsRes = await fetch(tsUrl);
    if (tsRes.ok) {
      const tsData = await tsRes.json();
      for (const station of tsData.STATION || []) {
        const meta = cities.find(c => c.stid === station.STID);
        if (!meta) continue;
        const obs = station.OBSERVATIONS || {};
        const times = obs.date_time || [];
        const values = obs.air_temp_value_1 || [];
        const todayKey = localDayKey(now, meta.tz);
        let best = null, bestAt = null;
        for (let i = 0; i < times.length; i++) {
          const v = values[i];
          if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
          if (localDayKey(new Date(times[i]), meta.tz) !== todayKey) continue;
          if (best === null || Number(v) > best) { best = Number(v); bestAt = times[i]; }
        }
        if (best !== null) highs[station.STID] = { high: Math.round(best), high_at: bestAt };
      }
    }
  } catch (_) { /* highs are best-effort; latest data below still serves */ }

  const temps = cities.map(city => {
    const station = stations.find(s => s.STID === city.stid);
    const obs = station?.OBSERVATIONS?.air_temp_value_1;
    const temp = obs?.value ? Math.round(obs.value) : null;
    const observed_at = obs?.date_time || null;
    // Fallback: high is never below the current reading; if the day
    // query found nothing, the current temp is the floor for the high.
    let high = highs[city.stid]?.high ?? null;
    let high_at = highs[city.stid]?.high_at ?? null;
    if (temp !== null && (high === null || temp > high)) { high = temp; high_at = observed_at; }
    return {
      city: city.city,
      state: city.state,
      stid: city.stid,
      temp,
      observed_at,
      high,
      high_at,
    };
  });

  return jsonResponse({ temps, fetched_at: new Date().toISOString(), source: "Synoptic" });
}

// ── FALLBACK FEED: National Weather Service (api.weather.gov) ──
// Per station, read the last 30 hours of observations from the LIST
// endpoint and take the newest reading as current, plus the max over the
// station's own local calendar day as the high so far. (The
// /observations/latest endpoint lags badly — verified 2026-10-30 — the
// list carries much fresher prints.) Same response shape as Synoptic.
async function nwsResponse() {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString();
  const headers = {
    "User-Agent": "HighTempToday/1.0 (robah8705@gmail.com)",
    "Accept": "application/geo+json",
  };

  const results = await Promise.allSettled(
    cities.map(async meta => {
      const url = `https://api.weather.gov/stations/${meta.stid}/observations?start=${encodeURIComponent(start)}&limit=250`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`NWS returned ${res.status} for ${meta.stid}`);
      const data = await res.json();
      const obs = (data.features || [])
        .map(f => ({ ts: f.properties?.timestamp, c: f.properties?.temperature?.value }))
        .filter(o => o.ts && o.c != null)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts));
      if (!obs.length) throw new Error(`No recent NWS observations for ${meta.stid}`);

      const toF = c => Math.round(c * 9 / 5 + 32);
      const latest = obs[0];
      const temp = toF(latest.c);
      const todayKey = localDayKey(now, meta.tz);
      let high = null, high_at = null;
      for (const o of obs) {
        if (localDayKey(new Date(o.ts), meta.tz) !== todayKey) continue;
        const f = toF(o.c);
        if (high === null || f > high) { high = f; high_at = o.ts; }
      }
      // High is never below the current reading.
      if (high === null || temp > high) { high = temp; high_at = latest.ts; }

      return {
        city: meta.city,
        state: meta.state,
        stid: meta.stid,
        temp,
        observed_at: latest.ts,
        high,
        high_at,
        source: "NWS",
      };
    })
  );

  const temps = cities.map((meta, i) => {
    const r = results[i];
    if (r.status === "fulfilled") return r.value;
    return {
      city: meta.city, state: meta.state, stid: meta.stid,
      temp: null, observed_at: null, high: null, high_at: null, source: "NWS",
    };
  });

  if (temps.every(t => t.temp === null)) {
    throw new Error("NWS returned no usable observations for any station");
  }

  return jsonResponse({ temps, fetched_at: new Date().toISOString(), source: "NWS" });
}

exports.handler = async () => {
  if (SYNOPTIC_ENABLED) {
    try {
      return await synopticResponse();
    } catch (_) {
      // Synoptic failed — fall through to the NWS feed.
    }
  }
  try {
    return await nwsResponse();
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
