// watch-watcher.js — Watchlist + Alerts watcher for HighTempToday Pro.
// Scope: WATCHLIST-ALERTS-SCOPE-v1.md (approved v1). Runs on a schedule,
// evaluates four triggers per watched station against watcher_state (the
// per-station-day dedupe), logs firings to alert_log, and emails the
// subscribed users via Resend.
//
// SCHEDULE (Netlify Scheduled Functions): declared in netlify.toml at the
// repo root —
//   [functions."watch-watcher"]
//   schedule = "*/5 14-23,0-2 * * *"
// Netlify cron is UTC. 14:00–02:00 UTC covers 10 AM–9 PM ET in EDT and
// 9 AM–9 PM ET in EST; the extra shoulder hour is harmless because every
// trigger is state-based and fires at most once per station-day (new-high:
// once per whole degree). Manual/test invocation hits exports.handler the
// same way; production HTTP hits on a scheduled function are rejected by
// Netlify itself, which is fine — nothing here needs a public URL.
//
// Env (all required pieces degrade gracefully):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY — missing → returns {skipped:"not_configured"}
//   RESEND_API_KEY, ALERTS_FROM        — missing key → firings still logged, no mail sent
//   SITE_URL                           — feed + link base (default https://hightemptoday.com)
//   WATCH_TOKEN_SECRET                 — if set, alert emails carry a live manage link
//                                        (token = HMAC-SHA256(secret, user.id), as in watch-api)
//
// Feeds are the site's own functions: pro-obs (MADIS 5-min; KNYC falls
// back to pro-nws hourly obs) and pro-nws cli mode for the CLI trigger.
// Peak windows come from peak-bands.json (built nightly by
// kalshi-trading/tools/peak_bands_build.py); if it can't be fetched, the
// peak-window and topped-out triggers are skipped for that run.
const crypto = require("crypto");

const META = {
  KPHX: ["Phoenix", "America/Phoenix"], KLAS: ["Las Vegas", "America/Los_Angeles"],
  KDFW: ["Dallas", "America/Chicago"], KHOU: ["Houston", "America/Chicago"],
  KMIA: ["Miami", "America/New_York"], KATL: ["Atlanta", "America/New_York"],
  KLAX: ["Los Angeles", "America/Los_Angeles"], KSFO: ["San Francisco", "America/Los_Angeles"],
  KSAN: ["San Diego", "America/Los_Angeles"], KDEN: ["Denver", "America/Denver"],
  KMDW: ["Chicago", "America/Chicago"], KMSP: ["Minneapolis", "America/Chicago"],
  KOKC: ["Oklahoma City", "America/Chicago"], KMSY: ["New Orleans", "America/Chicago"],
  KSAT: ["San Antonio", "America/Chicago"], KAUS: ["Austin", "America/Chicago"],
  KSDF: ["Louisville", "America/Kentucky/Louisville"], KNYC: ["New York", "America/New_York"],
  KEWR: ["Newark", "America/New_York"], KTTN: ["Trenton", "America/New_York"],
  KPHL: ["Philadelphia", "America/New_York"], KDCA: ["Washington DC", "America/New_York"],
  KBOS: ["Boston", "America/New_York"], KSEA: ["Seattle", "America/Los_Angeles"]
};
const SITE = () => (process.env.SITE_URL || "https://hightemptoday.com").replace(/\/$/, "");
const FROM = () => process.env.ALERTS_FROM || "HighTempToday Alerts <alerts@hightemptoday.com>";
const configured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

// ------------------------------------------------------------ Supabase REST
function sb(path, opts = {}) {
  return fetch(process.env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
      ...(opts.prefer ? { Prefer: opts.prefer } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(async r => {
    const text = await r.text();
    if (!r.ok) throw new Error("Supabase " + r.status + ": " + text.slice(0, 200));
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  });
}

// ------------------------------------------------------------ time helpers
function localParts(epochSec, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(epochSec * 1000))) p[x.type] = +x.value;
  return p;
}
const dateKey = (epochSec, tz) => { const p = localParts(epochSec, tz); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; };
const minOfDay = (epochSec, tz) => { const p = localParts(epochSec, tz); return p.hour * 60 + p.minute; };
const fmtTime = (epochSec, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(epochSec * 1000));
const fmtHM = mins => { const h = Math.floor(mins / 60), m = Math.round(mins % 60); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
function zonedMidnightEpoch(tz, ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const key = e => { const p = localParts(e, tz); return ((p.year * 100 + p.month) * 100 + p.day) * 86400 + p.hour * 3600 + p.minute * 60; };
  const target = ((y * 100 + m) * 100 + d) * 86400;
  let lo = Date.UTC(y, m - 1, d) / 1000 - 14 * 3600, hi = Date.UTC(y, m - 1, d) / 1000 + 14 * 3600;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (key(mid) < target) lo = mid + 1; else hi = mid; }
  return lo;
}
function interpAt(series, t) {
  if (!series.length) return null;
  if (t <= series[0].t) return series[0].v;
  if (t >= series[series.length - 1].t) return series[series.length - 1].v;
  for (let i = 1; i < series.length; i++) {
    if (series[i].t >= t) {
      const a = series[i - 1], b = series[i];
      return b.t === a.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
    }
  }
  return null;
}

// ------------------------------------------------------------ feeds
async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error(r.status + " " + url); return r.json(); }
async function dayObs(stid, tz, ymd) {
  const dayStart = zonedMidnightEpoch(tz, ymd);
  const fromHour = Math.floor(dayStart / 3600);
  try {
    const d = await jget(`${SITE()}/.netlify/functions/pro-obs?stid=${stid}&mode=day&from=${fromHour}`);
    const rows = (d.obs || []).filter(o => o.t >= dayStart && o.tempF != null).map(o => ({ t: o.t, v: o.tempF }));
    if (rows.length) return rows;
  } catch (e) { /* fall through to NWS hourly */ }
  // KNYC (and any HFMETAR gap): NWS hourly decimal obs via pro-nws.
  const d = await jget(`${SITE()}/.netlify/functions/pro-nws?mode=obs&stid=${stid}&start=${encodeURIComponent(new Date(dayStart * 1000).toISOString())}`);
  return (d.rows || []).filter(o => o.t >= dayStart && o.v != null).map(o => ({ t: o.t, v: o.v }));
}
const MONTHS = { JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12 };
async function fetchCLI(stid) {
  const d = await jget(`${SITE()}/.netlify/functions/pro-nws?mode=cli&code=${stid.slice(1)}`);
  if (!d.text) return null;
  const dm = d.text.match(/CLIMATE SUMMARY FOR ([A-Z]+) (\d{1,2}) (\d{4})/);
  if (!dm) return null;
  const date = `${dm[3]}-${String(MONTHS[dm[1]]).padStart(2, "0")}-${String(+dm[2]).padStart(2, "0")}`;
  const mx = d.text.match(/MAXIMUM\s+(-?\d+)\s+(\d{1,2}:?\d{2}\s*[AP]M)/);
  return { date, issued: d.issued || null, max: mx ? +mx[1] : null, maxTime: mx ? mx[2].replace(/\s+/g, " ") : null };
}

// ------------------------------------------------------------ mail
function manageLink(userId) {
  const secret = process.env.WATCH_TOKEN_SECRET;
  if (!secret) return SITE() + "/watch-manage.html";
  const token = crypto.createHmac("sha256", secret).update(userId).digest("base64url");
  return SITE() + "/watch-manage.html?t=" + token;
}
async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), to, subject, text })
  });
  if (!r.ok) throw new Error("Resend " + r.status);
  return true;
}

// ------------------------------------------------------------ watcher
exports.handler = async () => {
  const out = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!configured()) return out(200, { skipped: "not_configured" });
  const nowE = Date.now() / 1000;
  const summary = { stations: 0, fired: [], emails: 0, logged: 0, errors: [] };
  try {
    const subs = await sb("subscriptions?active=eq.true&select=station,alert_types,user_id,users!inner(email,confirmed_at)&users.confirmed_at=not.is.null") || [];
    const byStation = {};
    for (const s of subs) (byStation[s.station] = byStation[s.station] || []).push({ user_id: s.user_id, email: s.users.email, types: s.alert_types || [] });
    const stations = Object.keys(byStation).filter(s => META[s]);
    if (!stations.length) return out(200, { ok: true, ...summary });
    let bands = {};
    try { const b = await jget(SITE() + "/peak-bands.json"); bands = b.stations || {}; } catch (e) { /* peak/topped triggers skip this run */ }

    const stateCache = {};
    async function getState(station, date) {
      const k = station + "|" + date;
      if (stateCache[k]) return stateCache[k];
      const rows = await sb(`watcher_state?station=eq.${station}&date=eq.${date}&select=*`);
      const st = (rows && rows[0]) || { station, date, high_degree_alerted: null, peak_fired: false, topped_fired: false, cli_prelim_fired: false, cli_final_fired: false, _isNew: true };
      stateCache[k] = st;
      return st;
    }
    async function saveState(st) {
      const { _isNew, ...row } = st;
      row.updated_at = new Date().toISOString();
      await sb("watcher_state?on_conflict=station,date", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: row });
    }
    async function fire(station, typeKey, logType, payload, subject, bodyText) {
      const recipients = (byStation[station] || []).filter(r => r.types.includes(typeKey));
      for (const r of recipients) {
        await sb("alert_log", { method: "POST", prefer: "return=minimal", body: { user_id: r.user_id, station, type: logType, payload } });
        summary.logged++;
        const text = bodyText + `\n\nManage your watchlist (cities, alert types, unsubscribe):\n${manageLink(r.user_id)}\n\nHighTempToday Pro — alerts are information, not financial advice. Settlement is the official NWS climate report (CLI).`;
        try { if (await sendEmail(r.email, subject, text)) summary.emails++; } catch (e) { summary.errors.push(`mail ${station}/${logType}: ${e.message}`); }
      }
      if (recipients.length) summary.fired.push(`${station}:${logType}`);
    }

    for (const stid of stations) {
      const [city, tz] = META[stid];
      try {
        summary.stations++;
        const today = dateKey(nowE, tz);
        const nowMin = minOfDay(nowE, tz);
        const band = bands[stid] || null;
        const st = await getState(stid, today);
        let dirty = false;

        // --- obs-driven triggers ---
        let obs = [];
        try { obs = await dayObs(stid, tz, today); } catch (e) { summary.errors.push(`obs ${stid}: ${e.message}`); }
        if (obs.length) {
          const hi = obs.reduce((a, b) => (b.v > a.v ? b : a));
          const last = obs[obs.length - 1];
          if (st._isNew && st.high_degree_alerted == null) { st.high_degree_alerted = Math.floor(hi.v); dirty = true; } // baseline: no alert for the high already standing when the day starts
          const deg = Math.floor(hi.v);
          if (st.high_degree_alerted != null && deg > st.high_degree_alerted) {
            await fire(stid, "new_high", "new_high", { high: hi.v, degree: deg, at: new Date(hi.t * 1000).toISOString() },
              `${city} (${stid}) — new high ${deg}°`,
              `${city} just set a new high for the day: ${hi.v.toFixed(1)}° at ${fmtTime(hi.t, tz)} local (${stid}).\nThe running high has crossed into the ${deg}° bracket. The day settles on the official CLI, not the live print.`);
            st.high_degree_alerted = deg; dirty = true;
          }
          if (band && !st.peak_fired && nowMin >= band.q1 && nowMin <= band.q3) {
            await fire(stid, "peak_window", "peak_window", { window_q1: band.q1, window_q3: band.q3, high_so_far: hi.v },
              `${city} (${stid}) — entered its peak window`,
              `${city} has entered the window when its high usually lands: ${fmtHM(band.q1)} – ${fmtHM(band.q3)} local (from its last ${band.days || 30} days). High so far: ${hi.v.toFixed(1)}°.`);
            st.peak_fired = true; dirty = true;
          }
          if (band && !st.topped_fired && nowMin > band.q3) {
            const back = interpAt(obs, last.t - 1800);
            const slope30 = back == null ? null : last.v - back;
            if (slope30 != null && slope30 <= 0 && last.v < hi.v) {
              await fire(stid, "topped_out", "topped_out", { high: hi.v, slope30: Math.round(slope30 * 10) / 10, last: last.v },
                `${city} (${stid}) — likely topped out at ${Math.round(hi.v)}°`,
                `${city} looks topped out by the desk's rule: past the usual peak window (${fmtHM(band.q3)} local), the last 30 minutes are flat-to-falling (${slope30.toFixed(1)}°), and the print is off the high. High so far: ${hi.v.toFixed(1)}° at ${fmtTime(hi.t, tz)}. A late print can still tick it higher — the CLI decides.`);
              st.topped_fired = true; dirty = true;
            }
          }
        }

        // --- CLI triggers (polled only inside their local windows) ---
        const localHour = localParts(nowE, tz).hour;
        if (!st.cli_prelim_fired && localHour >= 15 && localHour < 22) {
          const cli = await fetchCLI(stid).catch(() => null);
          if (cli && cli.date === today) {
            await fire(stid, "cli_posted", "cli_prelim", { report_date: cli.date, max: cli.max, issued: cli.issued },
              `${city} (${stid}) — preliminary CLI posted${cli.max != null ? ": high " + cli.max + "°" : ""}`,
              `The preliminary NWS Climatological Report for ${city} (${stid}) is out for ${cli.date}${cli.max != null ? ` — maximum ${cli.max}°${cli.maxTime ? " at " + cli.maxTime : ""}` : ""}. Preliminary numbers can be corrected; the final CLI governs settlement.`);
            st.cli_prelim_fired = true; dirty = true;
          }
        }
        if (localHour >= 5 && localHour < 12) {
          const yKey = dateKey(nowE - 86400, tz);
          const yst = await getState(stid, yKey);
          if (!yst.cli_final_fired) {
            const cli = await fetchCLI(stid).catch(() => null);
            if (cli && cli.date === yKey) {
              await fire(stid, "cli_posted", "cli_final", { report_date: cli.date, max: cli.max, issued: cli.issued },
                `${city} (${stid}) — final CLI for ${yKey}${cli.max != null ? ": high " + cli.max + "°" : ""}`,
                `The final NWS Climatological Report for ${city} (${stid}) is posted for ${yKey}${cli.max != null ? ` — maximum ${cli.max}°${cli.maxTime ? " at " + cli.maxTime : ""}` : ""}. That is the settlement number for the day's market.`);
              yst.cli_final_fired = true;
              await saveState(yst);
            }
          }
        }
        if (dirty) await saveState(st);
      } catch (e) {
        summary.errors.push(`${stid}: ${e.message}`);
      }
    }
    return out(200, { ok: true, ...summary });
  } catch (e) {
    return out(502, { error: "watcher_failed", detail: String(e && e.message || e), ...summary });
  }
};
