const cities = [
  { city: "Phoenix",        state: "AZ", stid: "KPHX", tz: "America/Phoenix" },
  { city: "Las Vegas",      state: "NV", stid: "KLAS", tz: "America/Los_Angeles" },
  { city: "Dallas",         state: "TX", stid: "KDFW", tz: "America/Chicago" },
  { city: "Houston",        state: "TX", stid: "KHOU", tz: "America/Chicago" },
  { city: "Miami",          state: "FL", stid: "KMIA", tz: "America/New_York" },
  { city: "Atlanta",        state: "GA", stid: "KATL", tz: "America/New_York" },
  { city: "Los Angeles",    state: "CA", stid: "KLAX", tz: "America/Los_Angeles" },
  { city: "Chicago",        state: "IL", stid: "KORD", tz: "America/Chicago" },
  { city: "New York",       state: "NY", stid: "KJFK", tz: "America/New_York" },
  { city: "Denver",         state: "CO", stid: "KDEN", tz: "America/Denver" },
  { city: "Seattle",        state: "WA", stid: "KSEA", tz: "America/Los_Angeles" },
  { city: "Boston",         state: "MA", stid: "KBOS", tz: "America/New_York" },
  { city: "Minneapolis",    state: "MN", stid: "KMSP", tz: "America/Chicago" },
  { city: "Nashville",      state: "TN", stid: "KBNA", tz: "America/Chicago" },
  { city: "Austin",         state: "TX", stid: "KAUS", tz: "America/Chicago" },
  { city: "San Diego",      state: "CA", stid: "KSAN", tz: "America/Los_Angeles" },
  { city: "Charlotte",      state: "NC", stid: "KCLT", tz: "America/New_York" },
  { city: "Portland",       state: "OR", stid: "KPDX", tz: "America/Los_Angeles" },
  { city: "Salt Lake City", state: "UT", stid: "KSLC", tz: "America/Denver" },
  { city: "Columbus",       state: "OH", stid: "KCMH", tz: "America/New_York" },
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

exports.handler = async () => {
  const stids = cities.map(c => c.stid).join(',');
  const token = process.env.SYNOPTIC_TOKEN;
  const latestUrl = `https://api.synopticdata.com/v2/stations/latest?stid=${stids}&vars=air_temp&units=temp|F&token=${token}`;

  try {
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

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ temps, fetched_at: new Date().toISOString() }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
