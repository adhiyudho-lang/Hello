/* Crypto ETF Daily Brief builder (weekdays 07:00 WIB, run by a Claude Routine).
   Numbers are never written by hand: prices, 7d/30d change, 50-day range and EMA5/25/99 come
   from OKX daily candles here. Claude only supplies the narrative (bias, summary, events,
   reminders, S/R zones, scenarios, actions, risk, sources) in a narrative JSON file.

   1) node recorder/brief-build.cjs draft [draft.json]
        -> computed numbers + swing highs/lows + ETF flows + yesterday's brief, as research input
   2) node recorder/brief-build.cjs build narrative.json [data/brief.json]
        -> merges narrative + freshly computed numbers, validates, writes data/brief.json

   Narrative JSON shape (all text Bahasa Indonesia):
   { bias:{score:-100..100,label,note}, summary:[{tone,title,text}] (3),
     events:[{day:"YYYY-MM-DD",short,icon,date,time,scope,tone,title,detail,up,down}], eventsNote,
     reminders:[{title,when,alert,note,siri}],
     btc:{ zones:[{side:"up"|"down",lo,hi,label,basis}], emaStatus:{EMA5,EMA25,EMA99}, emaNote,
           main:{title,tone,path:[6 numbers 0..1.2],items:[]}, alt:{...}, fib:[{name,lv,role,fn}] },
     tokens:{ ETH:{bucket,sup,res}, ... }, actions:[{bucket,sym,action,tone,long,trim?,inval}],
     risk:[strings], sources:[[title,url], ...] }
   tone is one of up / down / flat / swing. */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PREV = path.join(ROOT, "data", "brief.json");
const TOKENS = ["ETH", "SOL", "HYPE", "LINK", "PENDLE", "INJ", "TAO"];
const D = 864e5;
const idNum = (v, d) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = v => idNum(v, v >= 1000 ? 0 : v >= 100 ? 2 : v >= 1 ? 3 : 4);
const r2 = v => Math.round(v * 100) / 100;
const ema = (v, n) => { const a = 2 / (n + 1); let e = v[0]; return v.map(x => (e = x * a + e * (1 - a))); };

async function getJSON(url) {
  for (let k = 0; k < 3; k++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (r.ok) return await r.json(); } catch {}
    await new Promise(r => setTimeout(r, 1000 * (k + 1)));
  }
  throw new Error("fetch failed " + url);
}
// closed UTC daily candles (07:00 WIB = 00:00 UTC, so the last one closed this morning)
async function daily(sym) {
  const now = Date.now(), tries = [
    () => getJSON(`https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT&bar=1Dutc&limit=200`).then(j => j.data.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] })).reverse()),
    () => getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1d&limit=200`).then(k => k.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] }))),
    () => getJSON(`https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT-SWAP&bar=1Dutc&limit=200`).then(j => j.data.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] })).reverse())
  ];
  for (const f of tries) { try { const cs = (await f()).filter(c => c.t + D <= now); if (cs.length >= 60) return cs; } catch {} }
  throw new Error("no daily candles for " + sym);
}
function stats(cs) {
  const cl = cs.map(c => c.c), i = cl.length - 1, p = cl[i];
  const last50 = cs.slice(-50), e5 = ema(cl, 5), e25 = ema(cl, 25), e99 = ema(cl, 99);
  const slope = (e, n = 3) => e[i] > e[i - n] * 1.002 ? "up" : e[i] < e[i - n] * 0.998 ? "down" : "flat";
  // swing points: a high/low that is the extreme of +-3 days
  const swings = [];
  for (let k = cs.length - 60; k < cs.length - 3; k++) {
    if (k < 3) continue;
    const w = cs.slice(k - 3, k + 4);
    if (cs[k].h === Math.max(...w.map(x => x.h))) swings.push({ date: new Date(cs[k].t).toISOString().slice(0, 10), type: "high", px: cs[k].h });
    if (cs[k].l === Math.min(...w.map(x => x.l))) swings.push({ date: new Date(cs[k].t).toISOString().slice(0, 10), type: "low", px: cs[k].l });
  }
  return {
    p, d7: r2((p / cl[i - 7] - 1) * 100), d30: r2((p / cl[i - 30] - 1) * 100),
    hi50: Math.max(...last50.map(c => c.h)), lo50: Math.min(...last50.map(c => c.l)),
    ema5: e5[i], ema25: e25[i], ema99: e99[i], slope5: slope(e5), slope25: slope(e25), slope99: slope(e99, 5),
    closeDate: new Date(cs[i].t).toISOString().slice(0, 10), swings
  };
}
const wibNow = () => new Date(Date.now() + 7 * 36e5);
const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"], BLN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

async function compute(tokens) {
  const btcC = await daily("BTC"), btc = stats(btcC), tk = {};
  for (const s of tokens) { try { tk[s] = stats(await daily(s)); } catch (e) { tk[s] = { error: e.message }; } }
  let etf = null;
  try {
    const e = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "etf.json"), "utf8"));
    etf = Object.fromEntries(Object.entries(e.assets || {}).map(([k, a]) => [k, (a.days || []).slice(-7)]));
  } catch {}
  return { btc, tokens: tk, etf };
}

async function draft(out) {
  const prev = fs.existsSync(PREV) ? JSON.parse(fs.readFileSync(PREV, "utf8")) : null;
  const syms = prev && prev.tokens ? prev.tokens.map(t => t.sym) : TOKENS;
  const c = await compute(syms);
  const w = wibNow();
  const res = { today: `${HARI[w.getUTCDay()]}, ${w.getUTCDate()} ${BULAN[w.getUTCMonth()]} ${w.getUTCFullYear()}`, note: "Angka di sini dihitung dari candle harian OKX (UTC close = 07:00 WIB). Jangan ubah angka ini; tulis narasi saja.", ...c, previousBrief: prev };
  const txt = JSON.stringify(res, null, 1);
  if (out) fs.writeFileSync(out, txt); else console.log(txt);
  console.error(`draft: BTC ${fmt(c.btc.p)} (${c.btc.d7}% 7h) · ${syms.length} token`);
}

function check(cond, msg, errs) { if (!cond) errs.push(msg); }
async function build(narrFile, out = PREV) {
  const N = JSON.parse(fs.readFileSync(narrFile, "utf8"));
  const prev = fs.existsSync(PREV) ? JSON.parse(fs.readFileSync(PREV, "utf8")) : {};
  const syms = Object.keys(N.tokens || {});
  const c = await compute(syms);
  const errs = [], TONES = ["up", "down", "flat", "swing"];
  const b = c.btc;
  // ---- validation: shape + numbers must sit near the live data ----
  check(N.bias && typeof N.bias.score === "number" && N.bias.label && N.bias.note, "bias {score,label,note} wajib", errs);
  check(Array.isArray(N.summary) && N.summary.length >= 2 && N.summary.every(x => TONES.includes(x.tone) && x.title && x.text), "summary minimal 2 item {tone,title,text}", errs);
  check(Array.isArray(N.events) && N.events.every(e => /^\d{4}-\d{2}-\d{2}$/.test(e.day) && e.title && TONES.includes(e.tone)), "events: day YYYY-MM-DD, title, tone", errs);
  check(Array.isArray(N.reminders), "reminders harus array", errs);
  check(Array.isArray(N.actions) && N.actions.length && N.actions.every(a => a.sym && a.action && TONES.includes(a.tone) && a.inval), "actions {sym,action,tone,inval} wajib", errs);
  check(Array.isArray(N.risk) && N.risk.length, "risk wajib", errs);
  check(Array.isArray(N.sources) && N.sources.length >= 3 && N.sources.every(s => Array.isArray(s) && /^https?:\/\//.test(s[1])), "sources minimal 3 [judul,url]", errs);
  const z = (N.btc && N.btc.zones) || [];
  check(z.length >= 2 && z.every(x => ["up", "down"].includes(x.side) && x.lo > 0 && x.hi >= x.lo && x.label), "btc.zones minimal 2 {side,lo,hi,label}", errs);
  for (const x of z) check(Math.abs(x.lo / b.p - 1) < 0.35, `zona ${x.label} ${x.lo} terlalu jauh dari harga BTC ${Math.round(b.p)} (cek angka)`, errs);
  for (const x of z) check(x.side === "up" ? x.hi <= b.p * 1.01 : x.lo >= b.p * 0.99, `zona ${x.label}: support harus di bawah harga, resistance di atas`, errs);
  for (const k of ["main", "alt"]) check(N.btc && N.btc[k] && N.btc[k].title && Array.isArray(N.btc[k].items) && Array.isArray(N.btc[k].path) && N.btc[k].path.length >= 4, `btc.${k} {title,tone,path,items}`, errs);
  check(N.btc && Array.isArray(N.btc.fib), "btc.fib harus array", errs);
  for (const s of syms) check(c.tokens[s] && !c.tokens[s].error, `token ${s}: data harga tidak tersedia`, errs);
  if (errs.length) { console.error("BRIEF DITOLAK:\n- " + errs.join("\n- ")); process.exit(1); }

  const w = wibNow();
  const emaRow = (name, v, sl) => ({ name, value: idNum(v, v >= 1000 ? 0 : 2), tone: sl, status: (N.btc.emaStatus && N.btc.emaStatus[name]) || (sl === "up" ? "Naik" : sl === "down" ? "Turun" : "Datar") });
  const lo = Math.min(b.lo50, ...z.map(x => x.lo)), hi = Math.max(b.hi50, ...z.map(x => x.hi));
  const tokens = syms.map(s => {
    const t = c.tokens[s], n = N.tokens[s];
    const bull = t.ema5 > t.ema25;
    return { sym: s, bucket: n.bucket || "Watchlist", price: fmt(t.p), p: t.p, lo50: t.lo50, hi50: t.hi50, d7: t.d7, d30: t.d30, sup: n.sup || "--", res: n.res || "--", tone: bull ? "up" : "down", trend: `${bull ? "Bullish" : "Bearish"} (5: ${fmt(t.ema5)} ${bull ? ">" : "<"} 25: ${fmt(t.ema25)})` };
  });
  const out_ = {
    kind: "daily",
    period: `${HARI[w.getUTCDay()]}, ${w.getUTCDate()} ${BULAN[w.getUTCMonth()]} ${w.getUTCFullYear()}`,
    date: w.toISOString().slice(0, 10),
    snapshot: `${HARI[w.getUTCDay()]}, ${w.getUTCDate()} ${BLN[w.getUTCMonth()]} ${w.getUTCFullYear()} · ${String(w.getUTCHours()).padStart(2, "0")}:${String(w.getUTCMinutes()).padStart(2, "0")} WIB`,
    source: `Harga & EMA: OKX candle harian (close ${b.closeDate} UTC = 07:00 WIB) · Narasi: Claude (riset web)`,
    bias: N.bias, coins: prev.coins || {}, summary: N.summary, events: N.events, eventsNote: N.eventsNote || "", reminders: N.reminders || [],
    btc: {
      price: b.p, d7: b.d7, d30: b.d30, hi50: b.hi50, lo50: b.lo50, range: [Math.floor(lo * 0.98 / 500) * 500, Math.ceil(hi * 1.02 / 500) * 500],
      zones: z, ema: [emaRow("EMA5", b.ema5, b.slope5), emaRow("EMA25", b.ema25, b.slope25), emaRow("EMA99", b.ema99, b.slope99)],
      emaNote: N.btc.emaNote || "EMA dari candle harian OKX BTC-USDT.", main: N.btc.main, alt: N.btc.alt, fib: N.btc.fib
    },
    tokens, actions: N.actions, risk: N.risk, sources: N.sources, syncedAt: new Date().toISOString()
  };
  fs.writeFileSync(out, JSON.stringify(out_, null, 1));
  console.log(`brief harian: ${out_.period} · BTC ${fmt(b.p)} · ${out_.events.length} event · ${tokens.length} token → ${path.relative(ROOT, out)}`);
}

const [mode, a, b] = process.argv.slice(2);
(mode === "draft" ? draft(a) : mode === "build" && a ? build(a, b) : Promise.reject(new Error("usage: brief-build.cjs draft [out] | build narrative.json [out]")))
  .catch(e => { console.error(e.message); process.exit(1); });
