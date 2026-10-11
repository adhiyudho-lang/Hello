/* WAC backtest (Phase 2). Compares 7 strategies on 12 months of OKX spot candles (4h + 1h):
   random entries, buy & hold, CHASE, technical-only, WAC pattern A, WAC pattern B (pullback) and
   WAC + BTC regime. Same exits and costs for every trade strategy. Writes data/backtest.json.

   Rules: no look-ahead (signals on closed 4h candles, fills on the next 1h candle), one position per
   coin, SL counts first when SL and TP touch in one candle (counted as "ambiguous"), no TP on the fill
   candle, chronological train / validation / test split, test re-run with double costs.
   Parameters come from config/wac.json and are NOT tuned here.

   Run: node backtest/run.cjs            (cache: backtest/cache, ~4 min first run)
        MONTHS=12 COINS=BTC,ETH node backtest/run.cjs */
"use strict";
const fs = require("fs");
const path = require("path");
const WAC = require("../wac.js");
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/wac.json"), "utf8"));
WAC.setConfig(CFG);

const H = 3600e3, D = 24 * H;
const MONTHS = +process.env.MONTHS || 12, WARM_D = 60;
const COINS = (process.env.COINS || "BTC,ETH,SOL,LINK,NEAR,INJ,PENDLE,ONDO,DOGE,AVAX,ARB,SUI,OP,AAVE,UNI").split(",");
const FEE = CFG.fees.side, R = CFG.risk;
const CACHE = path.join(__dirname, "cache");
const OUT = path.join(__dirname, "../data/backtest.json");
const END = Math.floor(Date.now() / (4 * H)) * 4 * H;               // last closed 4h boundary
const START = END - Math.round(MONTHS * 30.4 * D);
const FETCH_FROM = START - (WARM_D + 210) * D;                        // EMA200 on BTC daily needs ~200 days
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- data (OKX history-candles, cached) ---------- */
async function okx(inst, bar, from) {
  const file = path.join(CACHE, `${inst}_${bar}.json`);
  let cs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const ms = bar === "1H" ? H : 4 * H;
  // extend forward (newest) and backward (oldest) only where the cache is missing
  const fetchRange = async (after) => {
    const out = [];
    for (let i = 0; i < 400; i++) {
      const url = `https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${bar}&limit=100${after ? "&after=" + after : ""}`;
      let j = null;
      for (let k = 0; k < 4 && !j; k++) { try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (r.status === 429) { await sleep(2000); continue; } j = await r.json(); } catch { await sleep(1000 * (k + 1)); } }
      if (!j || j.code !== "0") throw new Error(`${inst} ${bar}: ${j ? j.msg : "no response"}`);
      if (!j.data.length) break;
      const rows = j.data.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], q: +x[7], done: x[8] === "1" }));
      out.push(...rows);
      after = rows[rows.length - 1].t;
      if (after <= from || (cs.length && after <= cs[cs.length - 1].t)) break;
      await sleep(110);
    }
    return out;
  };
  const fresh = await fetchRange(null);
  let older = [];
  if (!cs.length || cs[0].t > from) older = await fetchRange(cs.length ? cs[0].t : (fresh.length ? fresh[fresh.length - 1].t : null));
  const map = new Map();
  for (const c of [...cs, ...fresh, ...older]) if (c.done !== false) map.set(c.t, c);
  cs = [...map.values()].filter(c => c.t >= from && c.t + ms <= END + 4 * H).sort((a, b) => a.t - b.t);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cs));
  return cs;
}
function daily(c4) {
  const m = new Map();
  for (const c of c4) {
    const d = Math.floor(c.t / D) * D, x = m.get(d);
    if (!x) m.set(d, { t: d, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: 1 });
    else { x.h = Math.max(x.h, c.h); x.l = Math.min(x.l, c.l); x.c = c.c; x.v += c.v; x.n++; }
  }
  return [...m.values()].filter(x => x.n === 6);
}

/* ---------- helpers ---------- */
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const lowerBound = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; } return lo; };
function planAt(entry, atr) { return WAC.plan(entry, atr); }

// exits on 1h candles: SL first if both touch, no TP on a fill-on-open candle, TP1 = sell half + SL to entry,
// TP2 for the rest, time stop 72h (+4h grace when TP1 was not reached)
function exitSim(c1, j0, entry, sl, tp1, tp2, fillOnOpen) {
  let half = false, stop = sl, amb = 0;
  const t0 = c1[j0].t;
  const done = (j, px, why) => {
    const gross = half ? 0.5 * (tp1 / entry - 1) + 0.5 * (px / entry - 1) : px / entry - 1;
    return { exitT: c1[j].t + H, exitPx: px, gross, why, amb };
  };
  for (let j = j0; j < c1.length; j++) {
    const c = c1[j], first = fillOnOpen && j === j0;
    const hitSl = c.l <= stop, hitTp = !first && c.h >= (half ? tp2 : tp1);
    if (hitSl && hitTp) { amb++; return done(j, stop, half ? "BE (ambigu)" : "SL (ambigu)"); }
    if (hitSl) return done(j, stop, half ? "BE" : "SL");
    if (hitTp) { if (half) return done(j, tp2, "TP2"); half = true; stop = entry; }
    const age = c.t + H - t0;
    if ((half && age >= R.timeStopH * H) || (!half && age >= (R.timeStopH + R.exitGraceH) * H)) return done(j, c.c, "Time stop");
  }
  return null; // still open at the end of data: not counted
}

/* ---------- per-coin simulation ---------- */
function regimeAt(btc, T) {
  const d1 = btc.d1.filter(x => x.t + D <= T).slice(-250), h4 = btc.c4.slice(Math.max(0, lowerBound(btc.c4, T - 6 * 4 * H)), lowerBound(btc.c4, T - 4 * H + 1));
  return WAC.regime(d1, h4, T);
}
function simulateCoin(coin, c4, c1, regimeFn, randomP, seed) {
  const out = { chase: [], tech: [], wacA: [], wacB: [], wacR: [], random: [], triggers: 0 };
  const busy = { chase: 0, tech: 0, wacA: 0, wacB: 0, wacR: 0, random: 0 };
  const rand = rng(seed);
  const NEU = { state: "NEUTRAL", detail: "tetap (tanpa filter rezim)" };
  const bStates = [];                                              // active pattern-B lifecycles: { sig, regimeAware }
  const i0 = lowerBound(c4, START - 4 * H);
  const trade = (key, T, entry, j, atr, reg, mult, fillOnOpen, extra) => {
    const p = planAt(entry, atr);
    if (extra && extra.checkPlan && p.rejects.length) return;
    const ex = exitSim(c1, j, entry, p.sl, p.tp1, p.tp2, fillOnOpen);
    if (!ex) return;
    out[key].push({ coin, t: T, entryT: c1[j].t, entry, slPct: p.slPct, size: mult || 1, regime: reg ? reg.state : "N/A", ...ex });
    busy[key] = ex.exitT;
  };
  for (let i = Math.max(i0, 130); i < c4.length; i++) {
    const T = c4[i].t + 4 * H;                                     // this 4h candle is closed at T
    if (T > END) break;
    const win = c4.slice(i - 119, i + 1), t4 = WAC.tech4h(win), k = win.length - 1;
    const j = lowerBound(c1, T);                                   // next 1h candle (fill on open)
    // advance pattern-B lifecycles over the 1h candles that closed during this 4h bar
    for (const b of bStates.slice()) {
      for (let jj = lowerBound(c1, T - 4 * H + H) - 1; jj < c1.length && c1[jj].t + H <= T; jj++) {
        if (jj < 0 || c1[jj].t + H <= b.lastT) continue;
        const now = c1[jj].t + H; b.lastT = now;
        const reg = b.regimeAware ? regimeFn(now) : NEU;
        const t4b = WAC.tech4h(c4.slice(Math.max(0, i - 120), i));
        WAC.step(b.sig, { now, price: c1[jj].c, c1h: c1.slice(Math.max(0, jj - 59), jj + 1), t4: t4b, regime: reg });
        if (b.sig.status === "POSITION_OPEN") {
          const key = b.key, p = b.sig.pos;
          if (busy[key] <= now && jj + 1 < c1.length) {
            const pl = planAt(p.entry, b.sig.atr);
            const ex = exitSim(c1, jj + 1, p.entry, pl.sl, pl.tp1, pl.tp2, false);
            if (ex) { out[key].push({ coin, t: b.sig.t, entryT: now, entry: p.entry, slPct: pl.slPct, size: b.size, regime: reg.state || "N/A", ...ex }); busy[key] = ex.exitT; }
          }
          bStates.splice(bStates.indexOf(b), 1); break;
        }
        if (!WAC.PRE.includes(b.sig.status)) { bStates.splice(bStates.indexOf(b), 1); break; }
      }
    }
    if (j >= c1.length) continue;
    const entryPx = c1[j].o;
    const vol24 = win.slice(-6).reduce((s, x) => s + (x.q || x.v * x.c), 0);
    const avgV = win.slice(k - 20, k).reduce((s, x) => s + x.v, 0) / 20;
    const mult = avgV ? win[k].v / avgV : 0, green = win[k].c > win[k].o;
    const chg24 = win[k].c / win[k - 6].c - 1;
    // random benchmark: same exits, random timing
    if (busy.random <= T && rand() < randomP) trade("random", T, entryPx, j, t4.atr, null, 1, true);
    // technical-only: indicators without the whale trigger, chase filter or regime
    if (busy.tech <= T && t4.close > t4.ema20 && t4.ema20 > t4.ema50 && t4.relVol > CFG.confirm.volMult && t4.rsi >= CFG.confirm.rsiLow && t4.rsi <= CFG.confirm.rsiHigh)
      trade("tech", T, entryPx, j, t4.atr, null, 1, true, { checkPlan: true });
    // trigger = proxy for "unusual volume with buy-side taker dominance": 4h volume >= 3x avg20 and green
    const trig = mult >= 3 && green && vol24 >= CFG.liquidity.minVol24;
    if (!trig) continue;
    out.triggers++;
    if (busy.chase <= T) trade("chase", T, entryPx, j, t4.atr, null, 1, true);
    for (const [key, regimeAware] of [["wacA", false], ["wacB", false], ["wacR", true]]) {
      if (busy[key] > T || bStates.some(b => b.key === key)) continue;
      const reg = regimeAware ? regimeFn(T) : NEU;
      const ev = WAC.evalSpot({ coin, now: T, price: win[k].c, priceAt: T, chg24, vol24, spreadPct: null, taker: null, dirUp: true, mult, t4, regime: reg, etf: null, equity: 10000 });
      const size = regimeAware && reg.state === "BEARISH" ? CFG.regime.bearSizeMult : 1;
      if (ev.status === "ENTRY_READY" && key !== "wacB") { trade(key, T, entryPx, j, t4.atr, reg, size, true, { checkPlan: true }); continue; }
      if (key === "wacA" || !WAC.PRE.includes(ev.status) || ev.status === "ENTRY_READY") continue;
      const st = { seq: 0, daily: {}, signals: [] };
      const sig = WAC.createSignal(st, { coin, mk: "OS", t: T, kind: "volume", value: vol24 / 6, mult, price: win[k].c, chg24 }, ev, T);
      bStates.push({ key, sig, regimeAware, size, lastT: T });
    }
  }
  return out;
}

/* ---------- portfolio + metrics ---------- */
function portfolio(trades, from, to, feeMult) {
  const ts = trades.filter(x => x.entryT >= from && x.entryT < to).sort((a, b) => a.entryT - b.entryT);
  let eq = 1, peak = 1, dd = 0;
  const open = [], taken = [];
  const closeUntil = t => { open.sort((a, b) => a.exitT - b.exitT); while (open.length && open[0].exitT <= t) { const x = open.shift(); eq += x.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); } };
  for (const x of ts) {
    closeUntil(x.entryT);
    if (open.length >= R.maxOpen || open.some(o => o.coin === x.coin)) continue;
    const risk = R.riskPct / 100 * x.size;
    const w = Math.min(risk / x.slPct, R.maxPosPct / 100);
    const net = x.gross - 2 * FEE * feeMult;
    const y = { ...x, net, w, pnl: eq * w * net, fee: eq * w * 2 * FEE * feeMult, grossPnl: eq * w * x.gross };
    open.push(y); taken.push(y);
  }
  closeUntil(Infinity);
  return { taken, ret: eq - 1, maxDD: dd };
}
function metrics(trades, from, to, feeMult = 1) {
  const pf = portfolio(trades, from, to, feeMult), xs = pf.taken;
  const n = xs.length;
  if (!n) return { trades: 0, ret: 0, maxDD: 0, win: 0, pf: null, exp: null, sharpe: null, t: null, feeShare: null, amb: 0 };
  const r = xs.map(x => x.net), mean = r.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const gp = xs.filter(x => x.pnl > 0).reduce((a, x) => a + x.pnl, 0), gl = -xs.filter(x => x.pnl < 0).reduce((a, x) => a + x.pnl, 0);
  const grossProfit = xs.filter(x => x.grossPnl > 0).reduce((a, x) => a + x.grossPnl, 0), fees = xs.reduce((a, x) => a + x.fee, 0);
  const years = (to - from) / (365 * D), wr = xs.map(x => x.pnl);
  const wm = wr.reduce((a, b) => a + b, 0) / n, wsd = Math.sqrt(wr.reduce((a, b) => a + (b - wm) ** 2, 0) / Math.max(1, n - 1));
  return {
    trades: n, ret: pf.ret, maxDD: pf.maxDD, win: r.filter(x => x > 0).length / n, pf: gl ? gp / gl : null, exp: mean,
    sharpe: wsd ? (wm / wsd) * Math.sqrt(n / years) : null, t: sd ? mean / (sd / Math.sqrt(n)) : null,
    feeShare: grossProfit ? fees / grossProfit : null, amb: xs.reduce((a, x) => a + x.amb, 0), taken: xs
  };
}
function buyHold(data, from, to, feeMult = 1) {
  const curves = [];
  for (const { c4 } of data) {
    const a = lowerBound(c4, from), b = lowerBound(c4, to) - 1;
    if (a >= c4.length || b <= a) continue;
    const p0 = c4[a].o;
    curves.push(c4.slice(a, b + 1).filter((_, k) => k % 6 === 5).map(c => c.c / p0));
  }
  if (!curves.length) return null;
  const len = Math.min(...curves.map(c => c.length));
  let peak = 1, dd = 0, last = 1;
  for (let k = 0; k < len; k++) { last = curves.reduce((s, c) => s + c[k], 0) / curves.length; peak = Math.max(peak, last); dd = Math.max(dd, 1 - last / peak); }
  const rets = curves.map(c => c[c.length - 1] - 1 - 2 * FEE * feeMult);
  return { trades: curves.length, ret: last - 1 - 2 * FEE * feeMult, maxDD: dd, win: rets.filter(x => x > 0).length / rets.length, pf: null, exp: rets.reduce((a, b) => a + b, 0) / rets.length, sharpe: null, t: null };
}
const strip = m => { if (!m) return m; const { taken, ...rest } = m; return rest; };

/* ---------- main ---------- */
(async () => {
  log(`backtest ${MONTHS} bulan · ${COINS.length} coin · ${new Date(START).toISOString().slice(0, 10)} → ${new Date(END).toISOString().slice(0, 10)}`);
  const data = [];
  for (const coin of COINS) {
    try {
      const [c4, c1] = [await okx(`${coin}-USDT`, "4H", FETCH_FROM), await okx(`${coin}-USDT`, "1H", START - 5 * D)];
      if (c4.length < 400 || c1.length < 1000) { log(coin, "data kurang, dilewati"); continue; }
      data.push({ coin, c4, c1 }); log(coin, `4h ${c4.length} · 1h ${c1.length}`);
    } catch (e) { log(coin, "gagal:", e.message); }
  }
  const btc = data.find(d => d.coin === "BTC");
  if (!btc) throw new Error("BTC wajib untuk rezim");
  btc.d1 = daily(btc.c4);
  const regCache = new Map();
  const regimeFn = T => { const k = Math.floor(T / (4 * H)); if (!regCache.has(k)) regCache.set(k, regimeAt(btc, k * 4 * H)); return regCache.get(k); };

  // pass 1 without random (to calibrate the random entry rate to the WAC trade rate)
  const all = { chase: [], tech: [], wacA: [], wacB: [], wacR: [], random: [] };
  let bars = 0, wacN = 0;
  for (const d of data) bars += d.c4.filter(c => c.t >= START).length;
  const runs = data.map((d, n) => { const r = simulateCoin(d.coin, d.c4, d.c1, regimeFn, 0, 1000 + n); wacN += r.wacR.length + r.wacA.length + r.wacB.length; return r; });
  const randomP = Math.max(0.002, wacN / 3 / Math.max(1, bars));
  data.forEach((d, n) => { const r = simulateCoin(d.coin, d.c4, d.c1, regimeFn, randomP, 42 + n); runs[n].random = r.random; });
  for (const r of runs) for (const k in all) all[k].push(...r[k]);
  const triggers = runs.reduce((s, r) => s + r.triggers, 0);

  const span = END - START, tTrain = START + span * 0.5, tVal = START + span * 0.75;
  const splits = { train: [START, tTrain], validation: [tTrain, tVal], test: [tVal, END] };
  const iso = t => new Date(t + 7 * H).toISOString().slice(0, 10);
  const NAMES = { random: "Acak (exit sama)", hold: "Buy & hold (equal weight)", chase: "CHASE (beli saat lonjakan volume)", tech: "Teknikal saja", wacA: "WAC Pola A (breakout)", wacB: "WAC Pola B (pullback)", wacR: "WAC + filter rezim BTC" };
  const strategies = [];
  for (const key of ["random", "hold", "chase", "tech", "wacA", "wacB", "wacR"]) {
    const s = { key, name: NAMES[key] };
    for (const [sp, [a, b]] of Object.entries(splits)) s[sp] = key === "hold" ? buyHold(data, a, b) : strip(metrics(all[key], a, b));
    s.test2x = key === "hold" ? buyHold(data, ...splits.test, 2) : strip(metrics(all[key], ...splits.test, 2));
    if (key !== "hold") {
      const m = metrics(all[key], ...splits.test);
      const per = (f) => { const o = {}; for (const x of m.taken || []) { const g = (o[f(x)] = o[f(x)] || { n: 0, sum: 0, win: 0 }); g.n++; g.sum += x.net; if (x.net > 0) g.win++; } return o; };
      s.perCoin = per(x => x.coin); s.perRegime = per(x => { const r = regimeFn(x.entryT); return r.state || "N/A"; });
      s.exits = per(x => x.why);
    }
    strategies.push(s);
  }

  // pass criteria on the main strategy (WAC + regime), test split only
  const main = strategies.find(s => s.key === "wacR"), mt = metrics(all.wacR, ...splits.test);
  const sum = xs => xs.reduce((a, x) => a + x.net, 0);
  const byCoin = {}; for (const x of mt.taken || []) byCoin[x.coin] = (byCoin[x.coin] || 0) + x.net;
  const bestCoin = Object.entries(byCoin).sort((a, b) => b[1] - a[1])[0];
  const best = (mt.taken || []).slice().sort((a, b) => b.net - a.net)[0];
  const exCoin = bestCoin ? sum((mt.taken || []).filter(x => x.coin !== bestCoin[0])) : 0;
  const exBest = best ? sum((mt.taken || []).filter(x => x !== best)) : 0;
  const checks = [
    { label: `t-stat test ≥ 2 (sekarang ${main.test.t == null ? "--" : main.test.t.toFixed(2)})`, ok: main.test.t != null && main.test.t >= 2 },
    { label: `Return test tetap positif dengan biaya 2× (${(main.test2x.ret * 100).toFixed(1)}%)`, ok: main.test2x.ret > 0 },
    { label: `Tanpa coin terbaik (${bestCoin ? bestCoin[0] : "-"}) jumlah return trade tetap positif (${(exCoin * 100).toFixed(1)}%)`, ok: exCoin > 0 },
    { label: `Tanpa trade terbaik jumlah return trade tetap positif (${(exBest * 100).toFixed(1)}%)`, ok: exBest > 0 },
    { label: `Sampel test cukup (≥ 30 trade, sekarang ${main.test.trades})`, ok: main.test.trades >= 30 },
    { label: `Mengalahkan benchmark acak di test (${(main.test.ret * 100).toFixed(1)}% vs ${(strategies[0].test.ret * 100).toFixed(1)}%)`, ok: main.test.ret > strategies[0].test.ret }
  ];
  const pass = checks.every(c => c.ok);
  const out = {
    generated: Date.now(), coins: data.map(d => d.coin), period: { from: iso(START), to: iso(END) }, fees: FEE, triggers,
    splits: Object.fromEntries(Object.entries(splits).map(([k, [a, b]]) => [k, { from: iso(a), to: iso(b) }])),
    strategies, randomRate: randomP,
    verdict: { pass, checks, text: pass ? "WAC + rezim lolos semua kriteria di periode test. Lanjut paper trading dulu, bukan uang besar." : "BELUM TERBUKTI: WAC + rezim tidak lolos semua kriteria di periode test out-of-sample. Saran tetap untuk dipantau/paper trading, bukan bukti edge." },
    limits: [
      "Arus whale/taker historis tidak tersedia gratis: pemicu memakai proxy candle 4h volume ≥ 3× rata-rata 20 dan close hijau",
      "Data ETF dan on-chain tidak dipakai (komponen N/A, coverage turun)",
      "Spread dan slippage di luar biaya 0,15%/sisi tidak dimodelkan",
      "Entry Pola B diisi di close candle 1h pengamatan berikutnya setelah ENTRY READY",
      "Entry bertahap 40/30/30 disederhanakan menjadi satu entry penuh",
      `SL & TP dalam satu candle dihitung SL dulu (${main.test.amb || 0} kasus ambigu di test)`,
      "Coin yang sudah delisting tidak ikut (bias survivorship)",
      "Parameter tidak dioptimasi; semua dari config/wac.json"
    ]
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  log("ditulis", path.relative(process.cwd(), OUT));
  for (const s of strategies) log(s.name.padEnd(36), ["train", "validation", "test", "test2x"].map(k => s[k] ? `${k} n=${s[k].trades} ret=${(s[k].ret * 100).toFixed(1)}% t=${s[k].t == null ? "-" : s[k].t.toFixed(2)}` : "").join(" | "));
  log(pass ? "LOLOS" : "BELUM TERBUKTI", checks.map(c => (c.ok ? "✓ " : "✗ ") + c.label).join("; "));
})().catch(e => { console.error(e); process.exit(1); });
