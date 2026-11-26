#!/usr/bin/env node
// build-city-pages.mjs — bakes the OFFICIAL daily highs into the city pages.
//
// Why this exists: search engines may not run the page's JavaScript, so a
// page that only loads its numbers in the browser can look empty to Google.
// This script writes yesterday's official high and the last 7 official highs
// straight into each page's HTML, between marker comments:
//   <!--BAKE:yesterday--> … <!--/BAKE:yesterday-->
//   <!--BAKE:week-->      … <!--/BAKE:week-->
//   <!--BAKE:month30-->   … <!--/BAKE:month30-->   (thick pages only)
//   <!--BAKE:stamp-->     … <!--/BAKE:stamp-->
// Everything outside the markers (the hand-written local content) is never
// touched. Live "high so far today" still loads in the browser.
//
// Source: NWS daily climate reports (CLI), via the Iowa Environmental
// Mesonet's JSON service — one request per station per run.
//
// Run it once a day after the morning climate reports post (about 9 AM ET
// is safe), from the repo root:
//   node scripts/build-city-pages.mjs
// Then commit the changed pages. If a station's pull fails, that page is
// left exactly as it was and the script reports it.

import { readFile, writeFile } from "node:fs/promises";

const IEM_BASE = process.env.IEM_BASE || "https://mesonet.agron.iastate.edu";
const UA = { "User-Agent": "HighTempToday-CityPages/1.0 (+https://hightemptoday.com)" };

// Add a line here as each city page ships.
const PAGES = [
  { file: "new-york-high-temperature.html", station: "KNYC", place: "Central Park", tz: "America/New_York" },
  { file: "miami-high-temperature.html", station: "KMIA", place: "Miami International", tz: "America/New_York" },
  { file: "los-angeles-high-temperature.html", station: "KLAX", place: "LAX", tz: "America/Los_Angeles" },
  { file: "philadelphia-high-temperature.html", station: "KPHL", place: "Philadelphia International", tz: "America/New_York" },
  { file: "denver-high-temperature.html", station: "KDEN", place: "Denver International", tz: "America/Denver" },
  { file: "phoenix-high-temperature.html", station: "KPHX", place: "Phoenix Sky Harbor", tz: "America/Phoenix" },
  { file: "las-vegas-high-temperature.html", station: "KLAS", place: "Harry Reid International", tz: "America/Los_Angeles" },
  { file: "dallas-high-temperature.html", station: "KDFW", place: "DFW International", tz: "America/Chicago" },
  { file: "houston-high-temperature.html", station: "KHOU", place: "Houston Hobby", tz: "America/Chicago" },
  { file: "atlanta-high-temperature.html", station: "KATL", place: "Hartsfield-Jackson International", tz: "America/New_York" },
  { file: "san-francisco-high-temperature.html", station: "KSFO", place: "San Francisco International", tz: "America/Los_Angeles" },
  { file: "san-diego-high-temperature.html", station: "KSAN", place: "San Diego International", tz: "America/Los_Angeles" },
  { file: "chicago-high-temperature.html", station: "KMDW", place: "Chicago Midway", tz: "America/Chicago" },
  { file: "minneapolis-high-temperature.html", station: "KMSP", place: "Minneapolis–St. Paul International", tz: "America/Chicago" },
  { file: "oklahoma-city-high-temperature.html", station: "KOKC", place: "Will Rogers World Airport", tz: "America/Chicago" },
  { file: "new-orleans-high-temperature.html", station: "KMSY", place: "Louis Armstrong International", tz: "America/Chicago" },
  { file: "san-antonio-high-temperature.html", station: "KSAT", place: "San Antonio International", tz: "America/Chicago" },
  { file: "austin-high-temperature.html", station: "KAUS", place: "Austin-Bergstrom International", tz: "America/Chicago" },
  { file: "louisville-high-temperature.html", station: "KSDF", place: "Louisville International", tz: "America/New_York" },
  { file: "newark-high-temperature.html", station: "KEWR", place: "Newark Liberty International", tz: "America/New_York" },
  { file: "trenton-high-temperature.html", station: "KTTN", place: "Trenton-Mercer Airport", tz: "America/New_York" },
  { file: "washington-dc-high-temperature.html", station: "KDCA", place: "Reagan National Airport", tz: "America/New_York" },
  { file: "boston-high-temperature.html", station: "KBOS", place: "Boston Logan International", tz: "America/New_York" },
  { file: "seattle-high-temperature.html", station: "KSEA", place: "Seattle-Tacoma International", tz: "America/Los_Angeles" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localYmd(tz, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}
function label(ymd, withDay = true) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${withDay ? dow + " " : ""}${MONTHS[m - 1]} ${d}`;
}
const num = v => (v === null || v === undefined || v === "M" || v === "" || Number.isNaN(Number(v))) ? null : Number(v);
// The climate feed writes times like "248 PM"; show them as "2:48 PM".
const fmtTime = t => { const m = /^(\d{1,2})(\d{2})\s*(AM|PM)$/i.exec(String(t || "").trim()); return m ? `${Number(m[1])}:${m[2]} ${m[3].toUpperCase()}` : String(t || ""); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function fetchYear(station, year) {
  const res = await fetch(`${IEM_BASE}/json/cli.py?station=${station}&year=${year}`, { headers: UA });
  if (!res.ok) throw new Error(`IEM ${res.status} for ${station} ${year}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

// The last `n` finished days with an official high, newest first.
async function officialHighs(station, tz, n = 7) {
  const today = localYmd(tz);
  const year = Number(today.slice(0, 4));
  let rows = await fetchYear(station, year);
  if (rows.filter(r => r.valid < today).length < n) rows = (await fetchYear(station, year - 1)).concat(rows);
  const byDay = new Map();
  for (const r of rows) {
    if (!r.valid || r.valid >= today || num(r.high) === null) continue;
    byDay.set(r.valid, r); // a later product for the same day replaces an earlier one
  }
  return [...byDay.values()].sort((a, b) => (a.valid < b.valid ? 1 : -1)).slice(0, n);
}

function renderYesterday(r, place) {
  const high = num(r.high), normal = num(r.high_normal), rec = num(r.high_record);
  const dep = high !== null && normal !== null ? high - normal : null;
  const depTxt = dep === null ? "" : dep === 0 ? "right at normal" : `${Math.abs(dep)}° ${dep > 0 ? "above" : "below"} normal`;
  const recYears = Array.isArray(r.high_record_years) && r.high_record_years.length ? ` (${r.high_record_years.join(", ")})` : "";
  return `<div class="ab-label">Official high, ${esc(label(r.valid))}</div>
      <div class="ab-value">${high}°F</div>
      <div class="ab-sub">${esc(place)}${r.high_time ? `, at ${esc(fmtTime(r.high_time))}` : ""}${depTxt ? ` · ${depTxt}` : ""}${normal !== null ? ` · normal ${normal}°` : ""}${rec !== null ? ` · record ${rec}°${esc(recYears)}` : ""}</div>`;
}

function renderWeek(rows) {
  const body = rows.map(r => {
    const high = num(r.high), normal = num(r.high_normal);
    const dep = high !== null && normal !== null ? high - normal : null;
    const depCell = dep === null ? "–" : `${dep > 0 ? "+" : ""}${dep}°`;
    const cls = dep === null ? "" : dep > 0 ? " warm" : dep < 0 ? " cool" : "";
    return `<tr><td>${esc(label(r.valid))}</td><td class="r">${high}°</td><td class="r">${r.high_time ? esc(fmtTime(r.high_time)) : "–"}</td><td class="r">${normal ?? "–"}${normal !== null ? "°" : ""}</td><td class="r${cls}">${depCell}</td></tr>`;
  }).join("\n        ");
  return `<table class="gtable week" data-newest="${rows[0] ? rows[0].valid : ""}">
        <tr><th>Day</th><th class="r">Official high</th><th class="r">Time</th><th class="r">Normal</th><th class="r">vs normal</th></tr>
        ${body}
      </table>`;
}

function renderMonth30(rows) {
  const body = rows.map(r => {
    const high = num(r.high), normal = num(r.high_normal);
    const dep = high !== null && normal !== null ? high - normal : null;
    const depCell = dep === null ? "–" : `${dep > 0 ? "+" : ""}${dep}°`;
    const cls = dep === null ? "" : dep > 0 ? " warm" : dep < 0 ? " cool" : "";
    return `<tr><td>${esc(label(r.valid))}</td><td class="r">${high}°</td><td class="r">${r.high_time ? esc(fmtTime(r.high_time)) : "–"}</td><td class="r">${normal ?? "–"}${normal !== null ? "°" : ""}</td><td class="r${cls}">${depCell}</td></tr>`;
  }).join("\n        ");
  return `<table class="gtable">
        <tr><th>Day</th><th class="r">Official high</th><th class="r">Time</th><th class="r">Normal</th><th class="r">vs normal</th></tr>
        ${body}
      </table>`;
}

function replaceBlock(html, name, inner) {
  const re = new RegExp(`(<!--BAKE:${name}-->)[\\s\\S]*?(<!--/BAKE:${name}-->)`);
  if (!re.test(html)) throw new Error(`marker BAKE:${name} not found`);
  return html.replace(re, `$1\n      ${inner}\n      $2`);
}

let failed = 0;
for (const page of PAGES) {
  try {
    const rows = await officialHighs(page.station, page.tz, 30);
    if (!rows.length) throw new Error("no official highs returned");
    let html = await readFile(page.file, "utf8");
    html = replaceBlock(html, "yesterday", renderYesterday(rows[0], page.place));
    html = replaceBlock(html, "week", renderWeek(rows.slice(0, 7)));
    if (html.includes("<!--BAKE:month30-->")) html = replaceBlock(html, "month30", renderMonth30(rows));
    const stamp = new Date().toISOString().slice(0, 10);
    html = replaceBlock(html, "stamp", `<span class="updated">Official highs updated ${esc(label(stamp, false))}, ${stamp.slice(0, 4)}, from the NWS climate reports.</span>`);
    html = html.replace(/("dateModified":")\d{4}-\d{2}-\d{2}(")/, `$1${stamp}$2`);
    await writeFile(page.file, html);
    console.log(`ok   ${page.file}: newest official high ${rows[0].valid} = ${rows[0].high}°F`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${page.file}: ${e.message} (page left unchanged)`);
  }
}
process.exitCode = failed ? 1 : 0;
