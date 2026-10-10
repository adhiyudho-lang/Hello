/* Adhi Whale Terminal recorder.
   Runs inside GitHub Actions for RUN_MINUTES, records every signal the dashboard would show
   (same engine.js rules) and fills in price outcomes 1h/4h/24h later.

   Two modes, so overlapping runs can never overwrite each other's data:
     node record.cjs                 record; writes only a journal file (JOURNAL) of what it found
     node record.cjs merge <journal> apply a journal onto the freshest data/ checkout, then rebuild
                                     the index. The workflow re-runs this after every fetch/reset,
                                     so a push race just means merging again on top of the new data.

   data/days/YYYY-MM-DD.json  one file per WIB day: signals + liquidation totals
   data/index.json            daily summaries + recommendation accuracy, read by the dashboard
   No dependencies: Node 22 has fetch and WebSocket built in. */
"use strict";
const fs = require("fs");
const path = require("path");
const W = require("../engine.js");

const RUN_MS = (+process.env.RUN_MINUTES || 55) * 60000;
const KEEP_DAYS = +process.env.KEEP_DAYS || 30;
const DATA = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DAYS = path.join(DATA, "days");
const HORIZONS = [1, 4, 24];
const START = Date.now();
const JOURNAL = process.env.JOURNAL || path.join(require("os").tmpdir(), "recorder-out.json");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dateWIB = t => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);

/* ---------- engine ---------- */
const CFG = { ...W.DEFAULTS };
let FNG = null, BTC = null;
// journal of this run: new signals, outcome values found for older signals, liquidation totals
const J = { items: [], outcomes: {}, liq: {}, fng: null };
const stats = { whale: 0, liq: 0, signal: 0 };

const E = W.create({
  cfg: CFG,
  getFng: () => FNG,
  getBtc: () => BTC,
  emit: (feed, s) => {
    if (FNG) s.fng = FNG.value;
    // trim float noise to keep the daily files small
    for (const k of ["value", "cluster"]) if (s[k] != null) s[k] = Math.round(s[k]);
    for (const k of ["chg", "chg24"]) if (s[k] != null) s[k] = +s[k].toFixed(5);
    if (s.mult != null) s.mult = +s.mult.toFixed(1);
    J.items.push(s);
    stats[feed]++;
  },
  onLiqRaw: (mk, coin, pos, v, t) => {
    const a = J.liq[dateWIB(t)] || (J.liq[dateWIB(t)] = { L: 0, S: 0, nL: 0, nS: 0 });
    if (pos === "LONG") { a.L += v; a.nL++; } else { a.S += v; a.nS++; }
  }
});

/* ---------- network helpers ---------- */
async function getJSON(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
      if (r.status === 451 || r.status === 403) throw new Error(`blocked ${r.status}`);
    } catch (e) { if (i === tries - 1) throw e; }
    await sleep(1000);
  }
  throw new Error("failed " + url);
}

const sockets = [];
let stopping = false;
function wsConnect(name, urls, onOpen, onMsg) {
  let i = 0, delay = 2000, fails = 0;
  const go = () => {
    if (stopping) return;
    const url = urls[i % urls.length];
    let ws, opened = false;
    try { ws = new WebSocket(url); } catch (e) { log(name, "ws error", e.message); i++; return setTimeout(go, delay); }
    sockets.push(ws);
    ws.onopen = () => { opened = true; fails = 0; delay = 2000; log(name, "connected", url); onOpen(ws); };
    ws.onmessage = e => { try { onMsg(String(e.data), ws); } catch (err) { /* ignore bad frame */ } };
    ws.onclose = () => {
      if (stopping) return;
      if (!opened) { i++; fails++; }
      if (fails >= 2 * urls.length) { log(name, "unreachable from this runner, giving up"); return; }
      delay = Math.min(delay * 2, 60000);
      setTimeout(go, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  go();
}
const coinOf = sym => sym.endsWith("USDT") ? sym.slice(0, -4) : null;
const pickTop = (mk, n) => [...E.M[mk].entries()].filter(([c]) => !W.STABLE.has(c)).sort((a, b) => b[1].q - a[1].q).slice(0, n).map(([c]) => c);

/* ---------- sources ---------- */
const okxCtVal = new Map();
const okxPings = [];
function startSources() {
  // Binance Futures: usually blocked for US-hosted runners; tried anyway, gives up quietly.
  wsConnect("binance-futures", ["wss://fstream.binance.com/stream?streams=!forceOrder@arr/!miniTicker@arr"], ws => { ws._sub = false; }, (raw, ws) => {
    const m = JSON.parse(raw); if (!m.data) return;
    const d = m.data, st = m.stream || "";
    if (st.startsWith("!miniTicker")) {
      const t = Date.now();
      for (const x of d) { const c = coinOf(x.s); if (c) E.onTick("BF", c, +x.c, +x.o, +x.q, t); }
      if (!ws._sub && E.M.BF.size > 50) { ws._sub = true; ws.send(JSON.stringify({ method: "SUBSCRIBE", params: pickTop("BF", 40).map(c => c.toLowerCase() + "usdt@aggTrade"), id: 1 })); }
    } else if (d.e === "forceOrder") {
      const o = d.o, c = coinOf(o.s); if (!c) return;
      const price = +o.ap || +o.p, qty = +o.z || +o.q;
      E.onLiq("BF", c, o.S === "SELL" ? "LONG" : "SHORT", price, price * qty, +o.T || d.E);
    } else if (d.e === "aggTrade") { const c = coinOf(d.s); if (c) E.onTrade("BF", c, +d.p, +d.q, d.m, +d.T); }
  });

  // Binance Spot via the public market-data mirror (reachable from GitHub runners)
  wsConnect("binance-spot", ["wss://data-stream.binance.vision/stream?streams=!miniTicker@arr", "wss://stream.binance.com:9443/stream?streams=!miniTicker@arr"], ws => { ws._sub = false; }, (raw, ws) => {
    const m = JSON.parse(raw); if (!m.data) return;
    const d = m.data;
    if (Array.isArray(d)) {
      const t = Date.now();
      for (const x of d) { const c = coinOf(x.s); if (c) E.onTick("BS", c, +x.c, +x.o, +x.q, t); }
      if (!ws._sub && E.M.BS.size > 50) { ws._sub = true; ws.send(JSON.stringify({ method: "SUBSCRIBE", params: pickTop("BS", 30).map(c => c.toLowerCase() + "usdt@aggTrade"), id: 2 })); }
    } else if (d.e === "aggTrade") { const c = coinOf(d.s); if (c) E.onTrade("BS", c, +d.p, +d.q, d.m, +d.T); }
  });

  // OKX liquidations
  wsConnect("okx", ["wss://ws.okx.com:8443/ws/v5/public", "wss://wsaws.okx.com:8443/ws/v5/public"], ws => {
    ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }));
    okxPings.push(setInterval(() => { try { ws.send("ping"); } catch {} }, 25000));
  }, raw => {
    if (raw === "pong") return;
    const m = JSON.parse(raw);
    if (!m.data || !m.arg || m.arg.channel !== "liquidation-orders") return;
    for (const it of m.data) {
      if (!/-USDT-SWAP$/.test(it.instId)) continue;
      const c = it.instId.split("-")[0], ct = okxCtVal.get(it.instId);
      if (!ct) continue;
      for (const dt of it.details || []) {
        const price = +dt.bkPx, value = +dt.sz * ct * price;
        const pos = dt.posSide === "long" ? "LONG" : dt.posSide === "short" ? "SHORT" : (dt.side === "sell" ? "LONG" : "SHORT");
        E.onLiq("OF", c, pos, price, value, +dt.ts);
      }
    }
  });
}

async function okxInstruments() {
  const j = await getJSON("https://www.okx.com/api/v5/public/instruments?instType=SWAP");
  for (const x of j.data) if (x.ctType === "linear") okxCtVal.set(x.instId, +x.ctVal * (+x.ctMult || 1));
  log("okx instruments", okxCtVal.size);
}
async function okxTickers() {
  try {
    const [sp, sw] = await Promise.all([
      getJSON("https://www.okx.com/api/v5/market/tickers?instType=SPOT", 1),
      getJSON("https://www.okx.com/api/v5/market/tickers?instType=SWAP", 1)
    ]);
    const t = Date.now();
    for (const x of sp.data) if (/-USDT$/.test(x.instId)) E.onTick("OS", x.instId.split("-")[0], +x.last, +x.open24h, +x.volCcy24h, t);
    for (const x of sw.data) if (/-USDT-SWAP$/.test(x.instId)) E.onTick("OF", x.instId.split("-")[0], +x.last, +x.open24h, +x.volCcy24h * +x.last, t);
  } catch (e) { log("okx tickers", e.message); }
}
async function loadFng() {
  try {
    const j = await getJSON("https://api.alternative.me/fng/?limit=1");
    FNG = { value: +j.data[0].value, label: j.data[0].value_classification };
    log("fear & greed", FNG.value);
  } catch (e) { log("fng", e.message); }
}
async function loadBtcTrend() {
  for (const u of ["https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=60", "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=60"]) {
    try {
      const j = await getJSON(u, 1);
      const closes = u.includes("okx") ? j.data.map(x => +x[4]).reverse() : j.map(x => +x[4]);
      const a = 2 / 21; let ema = closes[0];
      const emas = closes.map(c => (ema = c * a + ema * (1 - a)));
      const p = closes[closes.length - 1], e = emas[emas.length - 1], ePrev = emas[emas.length - 4];
      const dir = p > e * 1.002 && e > ePrev ? "up" : p < e * 0.998 && e < ePrev ? "down" : "flat";
      BTC = { dir, note: dir === "up" ? "naik, di atas EMA20" : dir === "down" ? "turun, di bawah EMA20" : "sideways" };
      return;
    } catch (e) { log("btc trend", e.message); }
  }
}

/* ---------- storage ---------- */
function readJSON(file, dflt) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; } }
function writeJSON(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); }
const dayFile = d => path.join(DAYS, d + ".json");
const loadDay = d => readJSON(dayFile(d), { date: d, liq: { L: 0, S: 0, nL: 0, nS: 0 }, fng: null, items: [] });

function writeJournal() {
  if (FNG) J.fng = FNG.value;
  fs.writeFileSync(JOURNAL, JSON.stringify(J));
  log(`journal: ${J.items.length} signals, ${Object.keys(J.outcomes).length} outcome updates`);
}

/* apply a journal onto data/ (idempotent for a fresh checkout) */
function applyJournal(j) {
  const byDay = {};
  for (const s of j.items) (byDay[dateWIB(s.t)] = byDay[dateWIB(s.t)] || []).push(s);
  const outByDay = {};
  for (const id in j.outcomes) { const u = j.outcomes[id]; (outByDay[u.d] = outByDay[u.d] || {})[id] = u.o; }
  const today = dateWIB(Date.now());
  const dates = new Set([...Object.keys(byDay), ...Object.keys(j.liq), ...Object.keys(outByDay), today]);
  for (const d of dates) {
    if (d === today && !byDay[d] && !j.liq[d] && !outByDay[d] && !fs.existsSync(dayFile(d))) continue;
    const day = loadDay(d);
    const seen = new Set(day.items.map(x => x.id));
    for (const s of byDay[d] || []) if (!seen.has(s.id)) day.items.push(s);
    day.items.sort((a, b) => a.t - b.t);
    const outs = outByDay[d] || {};
    for (const s of day.items) {
      const o = outs[s.id]; if (!o) continue;
      s.o = s.o || {};
      for (const h in o) if (s.o[h] === undefined) s.o[h] = o[h];
    }
    const a = j.liq[d];
    if (a) { day.liq.L += a.L; day.liq.S += a.S; day.liq.nL += a.nL; day.liq.nS += a.nS; }
    if (j.fng != null && d === today) day.fng = j.fng;
    writeJSON(dayFile(d), day);
  }
}

/* ---------- outcomes: where did price go 1h / 4h / 24h after the signal? ---------- */
const priceCache = new Map();
async function priceAt(mk, coin, T) {
  const key = `${mk}:${coin}:${Math.floor(T / 300000)}`;
  if (priceCache.has(key)) return priceCache.get(key);
  const okx = inst => getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=5m&after=${T + 300000}&limit=1`, 1)
    .then(j => (j.data && j.data[0] ? +j.data[0][1] : null));
  const bin = () => getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=5m&startTime=${T}&limit=1`, 1)
    .then(j => (j[0] ? +j[0][1] : null));
  const order = mk === "OF" ? [() => okx(`${coin}-USDT-SWAP`), bin]
    : mk === "OS" ? [() => okx(`${coin}-USDT`), bin]
    : mk === "BS" ? [bin, () => okx(`${coin}-USDT`)]
    : [() => okx(`${coin}-USDT-SWAP`), bin];
  let p = null;
  for (const f of order) { try { p = await f(); } catch { p = null; } if (p) break; await sleep(60); }
  priceCache.set(key, p);
  return p;
}
// 1 = TP1 reached first, -1 = stop loss first (or both inside one candle), 0 = neither within 4h
async function tpSl(s, pl) {
  const T = s.t, end = T + 4 * 3600e3;
  const bin = () => getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${s.coin}USDT&interval=5m&startTime=${T}&limit=48`, 1)
    .then(k => k.map(x => ({ t: +x[0], h: +x[2], l: +x[3] })));
  const okx = inst => getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=5m&after=${end + 1}&limit=48`, 1)
    .then(j => (j.data || []).map(x => ({ t: +x[0], h: +x[2], l: +x[3] })).reverse());
  const order = s.mk === "BS" ? [bin, () => okx(`${s.coin}-USDT`)] : s.mk === "OS" ? [() => okx(`${s.coin}-USDT`), bin] : [() => okx(`${s.coin}-USDT-SWAP`), bin];
  let cs = null;
  for (const f of order) { try { cs = await f(); } catch { cs = null; } if (cs && cs.length) break; await sleep(60); }
  if (!cs || !cs.length) return null;
  const long = s.dir === "up";
  for (const c of cs) {
    if (c.t < T - 300000 || c.t > end) continue;
    const hitSl = long ? c.l <= pl.sl : c.h >= pl.sl, hitTp = long ? c.h >= pl.tp1 : c.l <= pl.tp1;
    if (hitSl) return -1;
    if (hitTp) return 1;
  }
  return 0;
}

async function fillOutcomes(budgetMs) {
  const until = Date.now() + budgetMs, now = Date.now();
  let filled = 0;
  for (const d of [dateWIB(now - 2 * 86400e3), dateWIB(now - 86400e3), dateWIB(now)]) {
    if (!fs.existsSync(dayFile(d))) continue;
    const day = loadDay(d);
    for (const s of day.items) {
      if (Date.now() > until) break;
      if (s.dir !== "up" && s.dir !== "down") continue;
      if (!(s.price > 0)) continue;
      const o = s.o || {};
      for (const h of HORIZONS) {
        const u = J.outcomes[s.id];
        if (o[h] !== undefined || (u && u.o[h] !== undefined)) continue;
        const T = s.t + h * 3600e3;
        if (now < T + 6 * 60000) continue;           // candle not closed yet
        const rec = J.outcomes[s.id] || (J.outcomes[s.id] = { d, o: {} });
        if (now - T > 3 * 86400e3) { rec.o[h] = null; continue; }
        const p = await priceAt(s.mk, s.coin, T);
        rec.o[h] = p ? +(p / s.price - 1).toFixed(5) : null;
        filled++;
        await sleep(110);
      }
      // TP/SL check for IKUT and would-be IKUT (score >= 75): which was hit first within 4 hours
      const pl = s.reco && s.reco.plan, v = s.reco && s.reco.verdict;
      if (pl && (v === "IKUT" || (v === "TUNGGU" && s.reco.score >= 75))) {
        const u = J.outcomes[s.id];
        if (o.tp === undefined && !(u && u.o.tp !== undefined) && now > s.t + 4 * 3600e3 + 6 * 60000) {
          const rec = J.outcomes[s.id] || (J.outcomes[s.id] = { d, o: {} });
          if (now - s.t > 3 * 86400e3) rec.o.tp = null;
          else { rec.o.tp = await tpSl(s, pl); filled++; await sleep(110); }
        }
      }
    }
  }
  log(`outcomes filled: ${filled}`);
}

/* ---------- index + retention ---------- */
function buildIndex() {
  fs.mkdirSync(DAYS, { recursive: true });
  const cutoff = dateWIB(Date.now() - KEEP_DAYS * 86400e3);
  const days = [];
  for (const f of fs.readdirSync(DAYS).filter(f => f.endsWith(".json")).sort()) {
    const d = f.slice(0, 10);
    if (d < cutoff) { fs.unlinkSync(path.join(DAYS, f)); log("removed old", f); continue; }
    const day = loadDay(d);
    const n = { whale: 0, liq: 0, signal: 0 }, coins = {}, acc = {};
    let ikut = 0;
    for (const s of day.items) {
      n[s.f] = (n[s.f] || 0) + 1;
      coins[s.coin] = (coins[s.coin] || 0) + 1;
      const v = s.reco && s.reco.verdict;
      if (v === "IKUT") ikut++;
      if (!v || !s.o || (s.dir !== "up" && s.dir !== "down")) continue;
      for (const h of HORIZONS) {
        const r = s.o[h]; if (r == null) continue;
        const dr = s.dir === "up" ? r : -r;
        const a = ((acc[v] = acc[v] || {})[h] = acc[v][h] || { w: 0, n: 0, sum: 0 });
        a.n++; a.sum += dr; if (dr > 0) a.w++;
      }
    }
    const top = Object.entries(coins).sort((a, b) => b[1] - a[1]).slice(0, 5);
    days.push({ date: d, fng: day.fng, liq: day.liq, n, ikut, top, acc });
  }
  writeJSON(path.join(DATA, "index.json"), { updated: Date.now(), keepDays: KEEP_DAYS, days: days.reverse() });
}

/* ---------- main ---------- */
if (require.main !== module) { module.exports = { fillOutcomes, buildIndex, loadDay, dayFile, writeJSON, applyJournal, J }; return; }
if (process.argv[2] === "merge") {
  const file = process.argv[3] || JOURNAL;
  if (fs.existsSync(file)) { applyJournal(JSON.parse(fs.readFileSync(file, "utf8"))); log("merged", file); }
  else log("no journal at", file);
  buildIndex();
  process.exit(0);
}
(async () => {
  log(`recording for ${RUN_MS / 60000} minutes`);
  setInterval(E.flushBursts, 300);
  startSources();
  await Promise.all([loadFng(), loadBtcTrend(), okxInstruments().catch(e => log("okx instruments", e.message))]);
  await fillOutcomes(4 * 60000);
  writeJournal();
  setInterval(okxTickers, 10000); okxTickers();
  setInterval(loadBtcTrend, 5 * 60000);
  setInterval(writeJournal, 5 * 60000);

  const end = () => {
    stopping = true;
    for (const ws of sockets) { try { ws.close(); } catch {} }
    okxPings.forEach(clearInterval);
  };
  process.on("SIGTERM", () => { end(); writeJournal(); process.exit(0); });
  await sleep(Math.max(0, RUN_MS - (Date.now() - START)));
  end();
  E.flushBursts();
  writeJournal();
  await fillOutcomes(3 * 60000);
  writeJournal();
  log("done", JSON.stringify(stats));
  process.exit(0);
})();
