// pro-precompute.js — scheduled trigger for the Pro precompute worker.
// Netlify caps scheduled functions at 30 seconds, far too short to pull
// 24 cities of upstream data, so this trigger's only job is to kick the
// background worker (15-minute budget) and return. Schedule lives in
// netlify.toml: every 5 minutes.

exports.handler = async () => {
  const base = process.env.URL || "https://hightemptoday.com";
  try {
    const r = await fetch(`${base}/.netlify/functions/pro-precompute-background`, { method: "POST" });
    return { statusCode: 200, body: JSON.stringify({ kicked: true, worker_status: r.status }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ kicked: false, error: String(e && e.message || e) }) };
  }
};
