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
const WAC = require("../wac.js");
WAC.setConfig(require("../config/wac.json"));
const { execSync } = require("child_process");

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
const J = { items: [], outcomes: {}, liq: {}, fng: null, wac: null, flow: {}, flowLive: null, hl: null };
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
    if (s.kind !== "liq") { wacQueue.push(s); FL.add(s); }
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
  J.flowLive = FL.live([...recentItems, ...J.items]);
  J.hl = HLR.snapshot();
  fs.writeFileSync(JOURNAL, JSON.stringify(J));
  log(`journal: ${J.items.length} signals, ${Object.keys(J.outcomes).length} outcome updates`);
}

/* apply a journal onto data/ (idempotent for a fresh checkout) */
function applyJournal(j) {
  if (j.wac) writeJSON(path.join(DATA, "wac.json"), j.wac);
  if (j.flowLive) writeJSON(path.join(DATA, "flow-live.json"), j.flowLive);
  if (j.hl && j.hl.updated) writeJSON(path.join(DATA, "hl.json"), j.hl);
  const flowByDay = {};
  for (const id in j.flow || {}) { const u = j.flow[id]; (flowByDay[u.d] = flowByDay[u.d] || {})[id] = u; }
  const byDay = {};
  for (const s of j.items) (byDay[dateWIB(s.t)] = byDay[dateWIB(s.t)] || []).push(s);
  const outByDay = {};
  for (const id in j.outcomes) { const u = j.outcomes[id]; (outByDay[u.d] = outByDay[u.d] || {})[id] = u.o; }
  const today = dateWIB(Date.now());
  const dates = new Set([...Object.keys(byDay), ...Object.keys(j.liq), ...Object.keys(outByDay), ...Object.keys(flowByDay), today]);
  for (const d of dates) {
    if (d === today && !byDay[d] && !j.liq[d] && !outByDay[d] && !fs.existsSync(dayFile(d))) continue;
    const day = loadDay(d);
    const seen = new Set(day.items.map(x => x.id));
    for (const s of byDay[d] || []) if (!seen.has(s.id)) day.items.push(s);
    day.items.sort((a, b) => a.t - b.t);
    const outs = outByDay[d] || {}, fls = flowByDay[d] || {};
    for (const s of day.items) {
      const f = fls[s.id];
      if (f) { if (f.fl && !s.fl) s.fl = f.fl; if (f.trk) s.trk = Object.assign({}, f.trk, s.trk || {}); }
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
    const n = { whale: 0, liq: 0, signal: 0 }, coins = {}, acc = {}, flow = {};
    let ikut = 0;
    for (const s of day.items) {
      n[s.f] = (n[s.f] || 0) + 1;
      coins[s.coin] = (coins[s.coin] || 0) + 1;
      if (s.fl && s.fl.label) {
        const g = (flow[s.fl.label] = flow[s.fl.label] || { n: 0, cp: {} });
        g.n++;
        for (const c in s.trk || {}) { const st = s.trk[c].st; const h = (g.cp[c] = g.cp[c] || {}); h[st] = (h[st] || 0) + 1; }
      }
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
    days.push({ date: d, fng: day.fng, liq: day.liq, n, ikut, top, acc, flow });
  }
  writeJSON(path.join(DATA, "index.json"), { updated: Date.now(), keepDays: KEEP_DAYS, days: days.reverse() });
}

/* ---------- Signal Intelligence (flow label + T+5/15/60 tracker) ---------- */
const FL = require("./flow.cjs")({ getJSON, sleep, log, E, J, dateWIB });
const FLOWX = require("../flow.js");
let recentItems = [];
function loadRecentForFlow() {
  const now = Date.now();
  for (const d of new Set([dateWIB(now - 4 * 3600e3), dateWIB(now)])) {
    if (!fs.existsSync(dayFile(d))) continue;
    for (const s of loadDay(d).items) if (now - s.t < 4 * 3600e3) { recentItems.push(s); FL.add(s, d); }
  }
  log(`flow: ${FL.queue.size} sinyal dipantau dari rekaman sebelumnya`);
}
async function flowStatus(s, rec, cp, from, to) {
  // Telegram only for the actionable labels and the two decisive statuses (no spam)
  if (!["LONG_BARU", "SHORT_BARU"].includes(rec.fl.label) || !["FOLLOW_THROUGH", "SUDAH_KELUAR"].includes(to)) return;
  const r = rec.trk[cp], L = FLOWX.LABELS[rec.fl.label], S = FLOWX.STATUS[to];
  if (NOTIFY.flow === false) return;
  await tgSend(`${S.icon} ${s.coin} · T+${cp}: ${S.text} (${L.text})`, `${W.EX[s.mk]} · sinyal ${whenText(s.t)} · harga ${(r.dp * 100).toFixed(2)}%${r.doi == null ? "" : ` · OI ${(r.doi * 100).toFixed(1)}%`} · CVD ${W.usd(Math.abs(r.cvd))} ${r.cvd >= 0 ? "beli" : "jual"} · ${r.why}`);
}

/* ---------- Hyperliquid whale tracker ---------- */
const HLR = require("./hl.cjs")({ sleep, log, tgSend: (t, b, k) => tgSend(t, b, k), usd: W.usd, wib: t => W.wib(t), DATA });

/* ---------- WAC lifecycle (authoritative numbering + 24/7 zone monitoring) ---------- */
const WAC_FILE = path.join(DATA, "wac.json");
const WS = readJSON(WAC_FILE, { seq: 0, daily: {}, signals: [] });
J.wac = WS;
const wacQueue = [];
const cCache = new Map();
let REGIME = null, regimeAt = 0, ETF = null;
async function wacCandles(mk, coin, tf, limit) {
  const key = `${coin}:${tf}:${limit}`, ttl = tf === "1h" ? 4 * 60e3 : tf === "4h" ? 10 * 60e3 : 30 * 60e3;
  const hit = cCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.cs;
  const bar = { "1h": "1H", "4h": "4H", "1d": "1Dutc" }[tf];
  const okx = inst => getJSON(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${bar}&limit=${Math.min(limit, 300)}`, 1)
    .then(j => (j.data || []).map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).reverse());
  const bin = () => getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=${tf}&limit=${limit}`, 1)
    .then(k => k.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })));
  const order = mk === "BS" ? [bin, () => okx(`${coin}-USDT`), () => okx(`${coin}-USDT-SWAP`)] : [() => okx(`${coin}-USDT`), () => okx(`${coin}-USDT-SWAP`), bin];
  for (const f of order) { try { const cs = await f(); if (cs && cs.length >= 20) { cCache.set(key, { at: Date.now(), cs }); return cs; } } catch {} }
  return hit ? hit.cs : null;
}
async function wacRegime() {
  if (REGIME && Date.now() - regimeAt < 15 * 60e3) return REGIME;
  const [d1, h4] = await Promise.all([wacCandles("BS", "BTC", "1d", 250), wacCandles("BS", "BTC", "4h", 60)]);
  const now = Date.now();
  const r = WAC.regime(d1 && WAC.closed(d1, "1d", now), h4 && WAC.closed(h4, "4h", now), now);
  if (r.state) {
    if (REGIME && REGIME.state !== r.state) await tgSend(`🧭 Rezim BTC berubah: ${REGIME.state} → ${r.state}`, r.detail, "regime");
    REGIME = r; regimeAt = now;
  }
  return REGIME;
}
function etfFor(coin) {
  if (!WAC.cfg().etfAssets.includes(coin)) return null;
  if (ETF === null) ETF = readJSON(path.join(DATA, "etf.json"), {});
  const a = ETF.assets && ETF.assets[coin];
  return a ? WAC.etfScore(a.days, Date.now()) : null;
}
function lastPrice(coin) {
  for (const mk of ["BS", "OS", "OF", "BF"]) { const r = E.M[mk].get(coin); if (r && r.p) return { p: r.p, t: r.hist.length ? r.hist[r.hist.length - 1][0] : Date.now() }; }
  return null;
}
const srcText = sig => { const s = sig.src || {}; return s.kind === "volume" ? `Volume tak biasa ${W.usd(s.value || 0)}/menit (${Math.round(s.mult || 0)}x)` : s.kind === "trade" ? `Order besar ${W.usd(s.value || 0)} (proxy)` : `Gerak harga ${((s.chg || 0) * 100).toFixed(1)}%`; };
const whenText = t => W.wib(t).replace(" WIB", "") + " WIB";
const NOTIFY = readJSON(path.join(__dirname, "../config/notify.json"), { wac: true, regime: true, flow: false, whale: true });
async function tgSend(title, body, kind) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat || (kind && NOTIFY[kind] === false)) return;
  try { await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: title + "\n" + body }), signal: AbortSignal.timeout(10000) }); } catch {}
}
async function wacNotify(sig, kind) {
  if (!sig.notified) sig.notified = {};
  const key = kind === "NEAR_ZONE" || kind === "IN_ZONE" ? kind + ":" + (sig.remInZone || sig.remNear || 0) : kind;
  if (sig.notified[key]) return;
  sig.notified[key] = Date.now();
  const p = lastPrice(sig.coin);
  const extra = kind === "ENTRY_READY" ? WAC.entryTexts(sig, { regime: REGIME && REGIME.state, funding: E.funding.get(sig.coin) }) : {};
  const n = WAC.notifText(sig, kind, Object.assign({ when: whenText, srcText, price: p && p.p }, extra));
  await tgSend(n.title, n.body, "wac");
}
async function wacDetect(s) {
  const now = Date.now(), act = WAC.activeFor(WS, s.coin);
  if (act) {
    const lastLink = [...act.events].reverse().find(e => e.type === "link");
    if (!lastLink || now - lastLink.t > 30 * 60e3) WAC.addEvent(act, now, "link", act.status, `Sinyal lanjutan dari #${act.no}: ${srcText({ src: s })} di ${W.EX[s.mk]}`);
    return;
  }
  const [c4, c1] = await Promise.all([wacCandles(s.mk, s.coin, "4h", 120), wacCandles(s.mk, s.coin, "1h", 60)]);
  const reg = await wacRegime();
  const flow = (s.mk === "BF" || s.mk === "BS") ? E.takerFlow(s.mk, s.coin, s.t) : null;
  const open = WS.signals.filter(x => ["POSITION_OPEN", "TAKE_PROFIT_PARTIAL", "EXIT_WARNING"].includes(x.status));
  const ev = WAC.evalSpot({
    coin: s.coin, now, price: s.price, priceAt: s.t, chg24: s.chg24, vol24: E.vol24(s.coin), spreadPct: null,
    taker: flow ? { buy: flow.b, sell: flow.s } : null, dirUp: s.dir === "up" ? true : s.dir === "down" ? false : null, mult: s.mult,
    c4h: c4 && WAC.closed(c4, "4h", now), regime: reg, etf: etfFor(s.coin), openCount: open.length, openRisk: open.length * WAC.cfg().risk.riskPct
  });
  if (!WAC.PRE.includes(ev.status)) return;
  const sig = WAC.createSignal(WS, s, ev, now);
  log(`WAC #${sig.no} ${sig.coin} ${sig.status} skor ${sig.score}`);
  await wacNotify(sig, ev.status === "ENTRY_READY" ? "ENTRY_READY" : "WATCH");
}
let wacBusy = false;
async function wacTick() {
  if (wacBusy) return;
  wacBusy = true;
  try {
    while (wacQueue.length) { const s = wacQueue.shift(); try { await wacDetect(s); } catch (e) { log("wac detect", e.message); } }
    const now = Date.now(), reg = await wacRegime().catch(() => REGIME);
    for (const sig of WS.signals.filter(x => WAC.ACTIVE.includes(x.status))) {
      try {
        const lp = lastPrice(sig.coin);
        const [c1, c4] = await Promise.all([wacCandles(sig.mk, sig.coin, "1h", 60), wacCandles(sig.mk, sig.coin, "4h", 120)]);
        const c4c = c4 && WAC.closed(c4, "4h", now);
        const evs = WAC.step(sig, { now, price: lp && now - lp.t < 5 * 60e3 ? lp.p : null, c1h: c1 && WAC.closed(c1, "1h", now), t4: c4c && WAC.tech4h(c4c), regime: reg });
        for (const e of evs) await wacNotify(sig, e.status);
      } catch (e) { log("wac step", sig.no, e.message); }
    }
    // keep 30 days of signals
    const cut = now - 30 * 24 * 3600e3;
    WS.signals = WS.signals.filter(x => WAC.ACTIVE.includes(x.status) || x.t > cut).slice(-1500);
    WS.updated = now; WS.regime = REGIME;
  } finally { wacBusy = false; }
}
function pushWac() {
  writeJSON(WAC_FILE, WS);
  writeJSON(path.join(DATA, "flow-live.json"), FL.live([...recentItems, ...J.items]));
  if (HLR.S.updated) writeJSON(path.join(DATA, "hl.json"), HLR.snapshot());
  const br = process.env.GITHUB_REF_NAME;
  if (!process.env.GITHUB_ACTIONS || !br) return;
  const sh = c => execSync(c, { cwd: path.join(__dirname, ".."), stdio: "pipe" });
  try {
    sh("git add data/wac.json data/flow-live.json" + (HLR.S.updated ? " data/hl.json" : ""));
    try { sh("git diff --cached --quiet"); return; } catch {}
    sh(`git commit -q -m "WAC state ${new Date().toISOString().slice(11, 16)} UTC"`);
    sh(`git pull -q --rebase --autostash origin ${br}`);
    sh(`git push -q origin HEAD:${br}`);
    log("wac state pushed");
  } catch (e) { log("wac push failed", String(e.message).split("\n")[0]); try { sh("git rebase --abort"); } catch {} }
}

/* ---------- main ---------- */
if (require.main !== module) { module.exports = { fillOutcomes, buildIndex, loadDay, dayFile, writeJSON, applyJournal, J, WS, wacDetect, wacTick }; return; }
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
  setInterval(wacTick, 60000); setTimeout(wacTick, 20000);
  setInterval(pushWac, 5 * 60000);
  loadRecentForFlow();
  setInterval(() => FL.tick(flowStatus).catch(e => log("flow tick", e.message)), 60000);
  HLR.tick(); setInterval(() => HLR.tick(), HLR.C.pollSec * 1000);

  const end = () => {
    stopping = true;
    for (const ws of sockets) { try { ws.close(); } catch {} }
    okxPings.forEach(clearInterval);
  };
  process.on("SIGTERM", () => { end(); writeJournal(); process.exit(0); });
  await sleep(Math.max(0, RUN_MS - (Date.now() - START)));
  end();
  E.flushBursts();
  await wacTick().catch(() => {});
  await FL.tick(flowStatus).catch(() => {});
  writeJournal();
  await fillOutcomes(3 * 60000);
  writeJournal();
  log("done", JSON.stringify(stats));
  process.exit(0);
})();
