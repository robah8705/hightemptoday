// wire.js — hero intel grid feed for hightemptoday.com.
// Card 1 REGULATORY WATCH + Card 2 GRASSROOTS: Google News RSS (free, public, no key).
// Card 3 LIVE WIRE: Bluesky public API author feeds (free, no key, no account).
// Zero dependencies (this repo's Netlify setup does not install function deps).
// Everything degrades independently: a failed source returns null and the page hides that card.

const BSKY_HANDLES = [
  "nws.noaa.gov",               // National Weather Service
  "noaacomms.noaa.gov",         // NOAA Communications
  "polymarket.com",             // Polymarket (Bluesky-native)
  "polymarket.extwitter.link",  // Polymarket's X posts, mirrored to Bluesky
  "weatherkatie.bsky.social",   // Meteorologist Katie Nickolaou
];

const QUERIES = {
  regulatory: "Kalshi CFTC OR prediction markets regulation OR Polymarket regulation",
  grassroots: "\"Freedom to Forecast\" OR prediction market advocacy OR Kalshi state ban fight",
};

function fetchText(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "HighTempTodayWire/1.0" } })
    .then(r => { if (!r.ok) throw new Error("http " + r.status); return r.text(); })
    .finally(() => clearTimeout(t));
}
function fetchJson(url, ms = 9000) { return fetchText(url, ms).then(s => JSON.parse(s)); }

function decodeEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">"));
  return m ? decodeEntities(m[1]) : "";
}
function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    let title = tag(b, "title");
    const source = tag(b, "source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(" - " + source).length);
    const ts = Date.parse(tag(b, "pubDate")) || 0;
    const url = tag(b, "link");
    if (title && url) items.push({ headline: title, source, url, ts });
  }
  items.sort((a, b) => b.ts - a.ts);
  return items;
}
async function newsCard(query, maxAgeMs) {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
  const items = parseRss(await fetchText(url));
  if (!items.length) return null;
  const fresh = items.find(i => Date.now() - i.ts <= maxAgeMs);
  return fresh || items[0];
}

async function bskyCard() {
  const feeds = await Promise.all(BSKY_HANDLES.map(h =>
    fetchJson("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=" +
      encodeURIComponent(h) + "&limit=5&filter=posts_no_replies").catch(() => null)));
  let best = null;
  feeds.forEach((f, i) => {
    if (!f || !Array.isArray(f.feed)) return;
    for (const item of f.feed) {
      if (item.reason) continue; // reposts don't count
      const p = item.post, rec = p && p.record;
      if (!rec || !rec.text || rec.reply) continue;
      const ts = Date.parse(rec.createdAt) || 0;
      if (Date.now() - ts > 7 * 24 * 3600 * 1000) continue;
      if (best && ts <= best.ts) continue;
      const rkey = (p.uri || "").split("/").pop();
      best = {
        text: rec.text,
        name: (p.author && p.author.displayName) || BSKY_HANDLES[i],
        handle: BSKY_HANDLES[i],
        url: "https://bsky.app/profile/" + BSKY_HANDLES[i] + "/post/" + rkey,
        ts,
      };
    }
  });
  return best;
}

exports.handler = async () => {
  const [regulatory, grassroots, wire] = await Promise.all([
    newsCard(QUERIES.regulatory, 96 * 3600 * 1000).catch(() => null),
    newsCard(QUERIES.grassroots, 45 * 24 * 3600 * 1000).catch(() => null),
    bskyCard().catch(() => null),
  ]);
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
    },
    body: JSON.stringify({ generated_at: new Date().toISOString(), regulatory, grassroots, wire }),
  };
};
