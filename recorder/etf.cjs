/* Spot crypto ETF daily net flows, merged into data/etf.json so history keeps growing.
   - Per asset (BTC, ETH, SOL): daily net flow in USD + the coin price that day,
     from CoinMarketCap's public ETF data endpoint (same data as coinmarketcap.com/etf/...).
   - Per issuer for BTC (IBIT, FBTC, ...): USD million, from bitbo.io.
   Safe to run often: a failed source is skipped and leaves its previous data in place. */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = process.env.ETF_OUT || path.join(__dirname, "..", "data", "etf.json");
const ASSETS = { BTC: "btc", ETH: "eth", SOL: "sol" };
const KEEP = 400;
const UA = { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36" };
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

async function get(url, json) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return json ? r.json() : r.text();
}

async function cmc(cat) {
  for (let i = 0; i < 3; i++) {
    const j = await get(`https://api.coinmarketcap.com/data-api/v3/etf/overview/netflow/chart?category=${cat}&range=90d&convertId=2781`, true);
    const pts = j && j.data && j.data.points;
    if (Array.isArray(pts) && pts.length) {
      return pts.map(p => ({ date: new Date(+p.timestamp).toISOString().slice(0, 10), flow: Math.round(+p.value), price: +(+p.cryptoPrice).toPrecision(8) }));
    }
    await new Promise(r => setTimeout(r, 2000)); // endpoint answers "system busy" now and then
  }
  throw new Error("no points");
}

const strip = s => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function parseBitbo(html) {
  const t = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  const rows = [...t.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => strip(c[1])));
  if (!rows.length || rows[0][0] !== "Date") throw new Error("table layout changed");
  const funds = rows[0].slice(1, -1), days = [];
  for (const r of rows.slice(1)) {
    const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(r[0]);
    if (!m || !MON[m[1]]) continue;               // skips Total / Average / Maximum rows
    const by = {};
    funds.forEach((f, i) => { const v = parseFloat(r[i + 1]); if (isFinite(v)) by[f] = v; });
    const total = parseFloat(r[r.length - 1]);
    if (isFinite(total)) days.push({ date: `${m[3]}-${String(MON[m[1]]).padStart(2, "0")}-${m[2].padStart(2, "0")}`, total, by });
  }
  if (!days.length) throw new Error("no rows parsed");
  return { funds, days };
}

function merge(oldDays, fresh, keep) {
  const map = new Map((oldDays || []).map(d => [d.date, d]));
  for (const d of fresh) map.set(d.date, d);      // sources revise recent days; newest wins
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-keep);
}

(async () => {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
  // files written before per-asset support kept only the BTC issuer table at the top level
  const out = { updated: Date.now(), sources: { assets: "coinmarketcap.com/etf", issuers: "bitbo.io/treasuries/etf-flows" }, unit: "USD", assets: cur.assets || {}, issuers: cur.issuers || {} };
  if (!out.issuers.BTC && cur.days) out.issuers.BTC = { funds: cur.funds, days: cur.days };
  let ok = 0;
  for (const [sym, cat] of Object.entries(ASSETS)) {
    try {
      const fresh = await cmc(cat);
      out.assets[sym] = { days: merge(out.assets[sym] && out.assets[sym].days, fresh, KEEP) };
      ok++;
      console.log(`etf ${sym}: ${out.assets[sym].days.length} hari, terakhir ${fresh[fresh.length - 1].date}`);
    } catch (e) { console.log(`etf ${sym}: skipped (${e.message})`); }
  }
  try {
    const b = parseBitbo(await get("https://bitbo.io/treasuries/etf-flows"));
    const prev = out.issuers.BTC || {};
    out.issuers.BTC = { unit: "USD juta", funds: [...new Set([...(prev.funds || []), ...b.funds])], days: merge(prev.days, b.days, 180) };
    ok++;
    console.log(`etf issuers BTC: ${out.issuers.BTC.days.length} hari`);
  } catch (e) { console.log("etf issuers: skipped (" + e.message + ")"); }
  if (!ok) { console.log("etf: nothing fetched, file unchanged"); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
})();
