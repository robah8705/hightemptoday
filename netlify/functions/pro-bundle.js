// pro-bundle.js — serves one precomputed Pro city bundle per request.
// Bundles are written every ~5 minutes by pro-precompute-background.js into
// Netlify Blobs (store "pro-bundles", key "city-<STID>"). pro.html fetches
// this endpoint first and falls back to its direct per-function calls when
// no fresh bundle exists, so this layer can never break the page.
//
// Zero-dependency: hand-rolled Blobs read (same HTTP API as @netlify/blobs).
// Local dev fallback: PRO_BLOB_DIR directory.

const fs = require("fs");
const path = require("path");

const STORE = "site:pro-bundles";

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

async function blobGet(event, key) {
  if (process.env.PRO_BLOB_DIR) {
    try { return fs.readFileSync(path.join(process.env.PRO_BLOB_DIR, key), "utf8"); } catch (e) { return null; }
  }
  const cfg = blobConfig(event);
  if (!cfg) throw new Error("blobs_not_configured");
  const auth = { authorization: `Bearer ${cfg.token}` };
  if (cfg.edge) {
    const r = await fetch(`${cfg.edge}/${cfg.siteID}/${STORE}/${key}`, { headers: auth });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error("blob_get_" + r.status);
    return r.text();
  }
  const base = `${cfg.api || "https://api.netlify.com"}/api/v1/blobs/${cfg.siteID}/${STORE}/${key}`;
  const s = await fetch(base, { headers: { ...auth, accept: "application/json;type=signed-url" } });
  if (s.status === 404) return null;
  if (s.status !== 200) throw new Error("blob_get_sign_" + s.status);
  const { url } = await s.json();
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error("blob_get_" + r.status);
  return r.text();
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const station = (q.station || "").toUpperCase();
  if (!/^K[A-Z]{3}$/.test(station)) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "station required (e.g. KPHL)" }) };
  }
  try {
    const text = await blobGet(event, "city-" + station);
    if (!text) {
      return { statusCode: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "no_bundle" }) };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" },
      body: text,
    };
  } catch (e) {
    return { statusCode: 503, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
