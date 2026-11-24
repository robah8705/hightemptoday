// poll.js — Desk Poll tallies for hightemptoday.com. Live Nov 24, 2026.
// Zero dependencies. Tallies live in Netlify Blobs (store "polls", key "poll-<id>"),
// using the same access pattern as pro-precompute-background.js.
// GET  /.netlify/functions/poll?id=brings-you        -> { id, counts, total }
// POST /.netlify/functions/poll { id, choice }       -> updated tally
// One vote per browser is enforced client-side (localStorage); the server just
// counts. Read-modify-write can lose a vote under truly simultaneous posts —
// acceptable for a lightweight feedback poll; counts are indicative, not audited.

const fs = require("fs");
const path = require("path");

const STORE = "polls";
const POLLS = {
  "brings-you": ["kalshi", "polymarket", "starting", "weather"],
};

// ---------- blob storage (mirrors pro-precompute-background.js) ----------
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
  if (process.env.POLL_BLOB_DIR) {
    fs.mkdirSync(process.env.POLL_BLOB_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.POLL_BLOB_DIR, key), text);
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

async function blobGet(event, key) {
  if (process.env.POLL_BLOB_DIR) {
    try { return JSON.parse(fs.readFileSync(path.join(process.env.POLL_BLOB_DIR, key), "utf8")); } catch (e) { return null; }
  }
  const cfg = blobConfig(event);
  if (!cfg) return null;
  const auth = { authorization: `Bearer ${cfg.token}` };
  try {
    if (cfg.edge) {
      const r = await fetch(`${cfg.edge}/${cfg.siteID}/${STORE}/${key}`, { headers: auth });
      if (r.status !== 200) return null;
      return await r.json();
    }
    const r = await fetch(`${cfg.api || "https://api.netlify.com"}/api/v1/blobs/${cfg.siteID}/${STORE}/${key}`, { headers: auth });
    if (r.status !== 200) return null;
    return await r.json();
  } catch (e) { return null; }
}

// ---------- tally ----------
function emptyTally(id) {
  const counts = {};
  POLLS[id].forEach((c) => { counts[c] = 0; });
  return { id, counts, total: 0 };
}

async function getTally(event, id) {
  const t = await blobGet(event, "poll-" + id);
  if (t && t.counts) {
    const e = emptyTally(id);
    POLLS[id].forEach((c) => { e.counts[c] = t.counts[c] || 0; });
    e.total = POLLS[id].reduce((s, c) => s + e.counts[c], 0);
    return e;
  }
  return emptyTally(id);
}

function reply(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      const id = (event.queryStringParameters || {}).id || "";
      if (!POLLS[id]) return reply(404, { error: "unknown_poll" });
      return reply(200, await getTally(event, id));
    }
    if (event.httpMethod === "POST") {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad_json" }); }
      const { id, choice } = body;
      if (!POLLS[id] || !POLLS[id].includes(choice)) return reply(400, { error: "bad_vote" });
      const tally = await getTally(event, id);
      tally.counts[choice] += 1;
      tally.total += 1;
      await blobPut(event, "poll-" + id, JSON.stringify(tally));
      return reply(200, tally);
    }
    return reply(405, { error: "method_not_allowed" });
  } catch (e) {
    return reply(500, { error: "poll_error", detail: String(e && e.message || e) });
  }
};
