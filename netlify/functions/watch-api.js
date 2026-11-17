// watch-api.js — Watchlist + Alerts API for HighTempToday Pro.
// Scope: WATCHLIST-ALERTS-SCOPE-v1.md (approved v1: email-only alerts,
// magic manage-links, no passwords).
//
// POST JSON actions:
//   subscribe     {email, station}            → create/re-request a user, email a confirm link
//   confirm       {token}                     → finish double opt-in, returns the manage token ONCE
//   manage-get    {manageToken}               → the user's subscriptions
//   manage-update {manageToken, subscriptions:[{station, alert_types, active}]}
//   unsubscribe   {manageToken, station?}     → one city off, or all off without station
//
// Storage is Supabase PostgREST, hit with the service-role key (RLS is on
// with no public policies — see supabase/schema.sql). Email goes through
// Resend. Everything is env-driven and inert until provisioned:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY — missing → 503 {error:"alerts_not_configured"}
//   RESEND_API_KEY                     — missing → subscribe returns {dev:true} (no email sent)
//   ALERTS_FROM                        — From: for alert mail (default below)
//   SITE_URL                           — link base (default https://hightemptoday.com)
//   WATCH_TOKEN_SECRET                 — if set, manage tokens are minted as
//                                        HMAC-SHA256(secret, user.id) so alert emails can
//                                        carry a live manage link; otherwise tokens are
//                                        random and shown only once, at confirm time.
// Only SHA-256 hashes of tokens are ever stored.
const crypto = require("crypto");

const STATIONS = new Set(["KPHX","KLAS","KDFW","KHOU","KMIA","KATL","KLAX","KSFO","KSAN","KDEN","KMDW","KMSP","KOKC","KMSY","KSAT","KAUS","KSDF","KNYC","KEWR","KTTN","KPHL","KDCA","KBOS","KSEA"]);
const ALERT_TYPES = ["new_high", "peak_window", "topped_out", "cli_posted"];
const SITE = () => (process.env.SITE_URL || "https://hightemptoday.com").replace(/\/$/, "");
const FROM = () => process.env.ALERTS_FROM || "HighTempToday Alerts <alerts@hightemptoday.com>";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body)
});
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("hex");
const configured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

function sb(path, opts = {}) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + path;
  return fetch(url, {
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
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
    if (!r.ok) throw new Error("Supabase " + r.status + ": " + text.slice(0, 200));
    return data;
  });
}

async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), to, subject, text })
  });
  if (!r.ok) throw new Error("Resend " + r.status + ": " + (await r.text()).slice(0, 200));
  return true;
}

function mintManageToken(userId) {
  const secret = process.env.WATCH_TOKEN_SECRET;
  if (secret) return crypto.createHmac("sha256", secret).update(userId).digest("base64url");
  return newToken();
}

async function userByManageToken(manageToken) {
  if (!manageToken || typeof manageToken !== "string") return null;
  const rows = await sb("users?manage_token_hash=eq." + encodeURIComponent(sha256(manageToken)) + "&select=id,email,confirmed_at");
  const u = (rows || [])[0];
  return u && u.confirmed_at ? u : null;
}

const validEmail = e => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const validTypes = ts => Array.isArray(ts) && ts.length > 0 && ts.every(t => ALERT_TYPES.includes(t));

exports.handler = async (event) => {
  if (!configured()) return json(503, { error: "alerts_not_configured" });
  let req;
  try { req = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad_json" }); }
  const action = req.action || "";
  try {
    // ------------------------------------------------------------ subscribe
    if (action === "subscribe") {
      const email = (req.email || "").trim().toLowerCase();
      const station = (req.station || "").toUpperCase();
      if (!validEmail(email)) return json(400, { error: "invalid_email" });
      if (!STATIONS.has(station)) return json(400, { error: "invalid_station" });
      const confirmToken = newToken();
      const existing = (await sb("users?email=eq." + encodeURIComponent(email) + "&select=id")) || [];
      let userId;
      if (existing.length) {
        userId = existing[0].id;
        // Re-requesting rotates the confirm token (also the manage-link recovery path).
        await sb("users?id=eq." + userId, { method: "PATCH", body: { confirm_token_hash: sha256(confirmToken) } });
      } else {
        const created = await sb("users", {
          method: "POST", prefer: "return=representation",
          body: { email, confirm_token_hash: sha256(confirmToken) }
        });
        userId = created[0].id;
      }
      // Default subscription: the city they subscribed from, all four types.
      // Inert until the user confirms — the watcher only serves confirmed users.
      await sb("subscriptions?on_conflict=user_id,station", {
        method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
        body: { user_id: userId, station, alert_types: ALERT_TYPES, active: true }
      });
      const link = SITE() + "/watch-manage.html?c=" + confirmToken;
      const sent = await sendEmail(email, "Confirm your HighTempToday watchlist",
        "You asked to watch " + station + " on HighTempToday Pro.\n\n" +
        "Confirm your email to switch the alerts on:\n" + link + "\n\n" +
        "That link also becomes your manage page — pick cities and alert types there. " +
        "No password, ever. If you didn't ask for this, ignore this email and nothing happens.");
      if (!sent) return json(200, { ok: true, dev: true }); // no Resend key: flow exists, mail doesn't
      return json(200, { ok: true });
    }
    // -------------------------------------------------------------- confirm
    if (action === "confirm") {
      const token = req.token || "";
      if (!token) return json(400, { error: "token_required" });
      const rows = await sb("users?confirm_token_hash=eq." + encodeURIComponent(sha256(token)) + "&select=id,email,confirmed_at");
      const u = (rows || [])[0];
      if (!u) return json(400, { error: "invalid_token" });
      const manageToken = mintManageToken(u.id);
      await sb("users?id=eq." + u.id, {
        method: "PATCH",
        body: { confirmed_at: u.confirmed_at || new Date().toISOString(), confirm_token_hash: null, manage_token_hash: sha256(manageToken) }
      });
      return json(200, { ok: true, email: u.email, manageToken }); // shown once — bookmark the manage page
    }
    // ----------------------------------------------------------- manage-get
    if (action === "manage-get") {
      const u = await userByManageToken(req.manageToken);
      if (!u) return json(401, { error: "invalid_token" });
      const subs = await sb("subscriptions?user_id=eq." + u.id + "&select=station,alert_types,active&order=station");
      return json(200, { ok: true, email: u.email, subscriptions: subs || [] });
    }
    // -------------------------------------------------------- manage-update
    if (action === "manage-update") {
      const u = await userByManageToken(req.manageToken);
      if (!u) return json(401, { error: "invalid_token" });
      const list = req.subscriptions;
      if (!Array.isArray(list) || !list.length) return json(400, { error: "subscriptions_required" });
      for (const s of list) {
        if (!s || !STATIONS.has((s.station || "").toUpperCase())) return json(400, { error: "invalid_station" });
        if (!validTypes(s.alert_types)) return json(400, { error: "invalid_alert_types" });
      }
      const rows = list.map(s => ({
        user_id: u.id, station: s.station.toUpperCase(),
        alert_types: s.alert_types, active: s.active !== false, updated_at: new Date().toISOString()
      }));
      await sb("subscriptions?on_conflict=user_id,station", {
        method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows
      });
      return json(200, { ok: true, saved: rows.length });
    }
    // ---------------------------------------------------------- unsubscribe
    if (action === "unsubscribe") {
      const u = await userByManageToken(req.manageToken);
      if (!u) return json(401, { error: "invalid_token" });
      let path = "subscriptions?user_id=eq." + u.id;
      if (req.station) {
        const station = (req.station || "").toUpperCase();
        if (!STATIONS.has(station)) return json(400, { error: "invalid_station" });
        path += "&station=eq." + station;
      }
      await sb(path, { method: "PATCH", body: { active: false, updated_at: new Date().toISOString() } });
      return json(200, { ok: true });
    }
    return json(400, { error: "unknown_action" });
  } catch (e) {
    return json(502, { error: "watch_api_failed", detail: String(e && e.message || e) });
  }
};
