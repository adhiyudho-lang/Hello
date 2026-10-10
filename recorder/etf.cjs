/* Spot Bitcoin ETF daily net flows (USD million) from bitbo.io, merged into data/etf.json
   so history keeps growing past the ~10 days the source page shows. Safe to run often:
   a failed fetch leaves the file untouched and exits 0. */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = process.env.ETF_OUT || path.join(__dirname, "..", "data", "etf.json");
const URL = "https://bitbo.io/treasuries/etf-flows";
const KEEP = 180;
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

const strip = s => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function parse(html) {
  const t = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  const rows = [...t.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => strip(c[1])));
  if (!rows.length || rows[0][0] !== "Date") throw new Error("table layout changed");
  const funds = rows[0].slice(1, -1);
  const days = [];
  for (const r of rows.slice(1)) {
    const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(r[0]);
    if (!m || !MON[m[1]]) continue;               // skips Total / Average / Maximum rows
    const date = `${m[3]}-${String(MON[m[1]]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    const by = {};
    funds.forEach((f, i) => { const v = parseFloat(r[i + 1]); if (isFinite(v)) by[f] = v; });
    const total = parseFloat(r[r.length - 1]);
    if (isFinite(total)) days.push({ date, total, by });
  }
  if (!days.length) throw new Error("no rows parsed");
  return { funds, days };
}

(async () => {
  let fresh;
  try {
    const r = await fetch(URL, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    fresh = parse(await r.text());
  } catch (e) { console.log("etf: skipped (" + e.message + ")"); return; }
  let cur = { days: [] };
  try { cur = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
  const map = new Map((cur.days || []).map(d => [d.date, d]));
  for (const d of fresh.days) map.set(d.date, d);   // the source revises recent days; newest wins
  const days = [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-KEEP);
  const funds = [...new Set([...(cur.funds || []), ...fresh.funds])];
  const out = { updated: Date.now(), source: "bitbo.io", sourceUrl: URL, unit: "USD juta", asset: "BTC", funds, days };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const last = days[days.length - 1];
  console.log(`etf: ${days.length} hari, terakhir ${last.date} total ${last.total} jt`);
})();
