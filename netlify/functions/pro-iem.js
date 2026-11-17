// pro-iem.js — IEM (Iowa Mesonet) ASOS archive proxy for the Pro command center.
// mode=asos&stid=PHL&days=30 → hourly METAR + SPECI rows (tmpf/dwpf/wind/sky/wx)
// as JSON. Powers the typical-day curve, the peak-timing band, and the
// 30-day observed history behind the station bias strip.
const UA = { "User-Agent": "HighTempToday/1.0 (robah8705@gmail.com)" };

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const stid = (q.stid || "").replace(/^K/, "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(stid)) {
    return { statusCode: 400, body: JSON.stringify({ error: "stid required (e.g. PHL)" }) };
  }
  const days = Math.min(31, Math.max(1, parseInt(q.days || "30", 10)));
  const end = new Date(Date.now() + 86400e3); // include tomorrow's early hours UTC
  const start = new Date(end.getTime() - days * 86400e3);
  const p = d => [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  const [y1, m1, d1] = p(start), [y2, m2, d2] = p(end);
  const url = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=" + stid +
    "&data=tmpf,dwpf,sknt,drct,wxcodes,skyc1,skyc2,skyc3,skyc4,alti" +
    `&year1=${y1}&month1=${m1}&day1=${d1}&year2=${y2}&month2=${m2}&day2=${d2}` +
    "&tz=Etc%2FUTC&format=onlycomma&latlon=no&elev=no&missing=empty&trace=T&direct=no&report_type=3&report_type=4";
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error("IEM " + res.status);
    const csv = await res.text();
    const lines = csv.trim().split("\n");
    const head = lines[0].split(",");
    const idx = n => head.indexOf(n);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(",");
      const num = v => (v === "" || v == null) ? null : parseFloat(v);
      const sky = [...new Set(["skyc1", "skyc2", "skyc3", "skyc4"].map(k => (c[idx(k)] || "").trim()).filter(Boolean))].join(" ");
      rows.push({
        t: Math.floor(Date.parse(c[idx("valid")] + "Z") / 1000),
        tmpf: num(c[idx("tmpf")]), dwpf: num(c[idx("dwpf")]),
        sknt: num(c[idx("sknt")]), drct: num(c[idx("drct")]),
        wx: (c[idx("wxcodes")] || "").trim(), sky
      });
    }
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ stid: "K" + stid, days, source: "IEM ASOS archive", rows })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "IEM pull failed", detail: String(e && e.message || e) }) };
  }
};
