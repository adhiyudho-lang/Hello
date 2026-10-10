/* Adhi Whale Terminal: shared signal engine.
   Used by index.html (browser, live) and recorder/record.cjs (GitHub Actions, 24/7),
   so both detect signals and score recommendations with the same rules. */
(function (root) {
"use strict";
const DEFAULTS = {
  bigMajor: 1000000, bigFut: 150000, bigSpot: 100000,
  volMin: 200000, volMult: 8,
  pumpPct: 4, pumpWin: 5,
  liqMin: 30000, liqCluster: 500000, minVol24: 1000000, alertBig: 1000000
};
const EX = { BF: "Binance-Futures", BS: "Binance-Spot", OF: "OKX-Futures", OS: "OKX-Spot" };
const STABLE = new Set(["USDC","FDUSD","TUSD","DAI","USDP","BUSD","EUR","USDE","PYUSD","USD1","XUSD","AEUR","EURI","BFUSD","RLUSD","USDS"]);
const MAJORS = new Set(["BTC","ETH"]);

const tf = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const df = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short" });
const wib = t => tf.format(new Date(t)).replace(/:/g, ".") + " WIB";
function usd(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + " miliar";
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + " juta";
  if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + " ribu";
  return "$" + v.toFixed(0);
}
function px(p) {
  if (!isFinite(p)) return "--";
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 100) return "$" + p.toFixed(2);
  // drop trailing zeros but keep at least 2 decimals ($1.50, $0.5195)
  const d = p >= 1 ? 4 : Math.min(10, Math.max(4, 3 - Math.floor(Math.log10(p)) + 2));
  return "$" + p.toFixed(d).replace(/(\.\d\d\d*?)0+$/, "$1");
}
const pct = (v, d = 2) => (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function create(opts) {
  const CFG = opts.cfg;
  const M = { BF: new Map(), BS: new Map(), OF: new Map(), OS: new Map() };
  const funding = new Map();      // coin -> last funding rate (Binance futures)
  const taker = { BF: new Map(), BS: new Map() }; // sym -> [{t, side, v}]
  const recent = [];              // recent signals for confluence: {coin, dir, t, kind, mk}
  const liqWin = [];              // {t, pos, v}
  const cooldown = new Map();


  function rec(mk, coin) {
    let r = M[mk].get(coin);
    if (!r) { r = { p: 0, o: 0, q: 0, hist: [], vol: [] }; M[mk].set(coin, r); }
    return r;
  }
  function coolOk(key, ms) {
    const now = Date.now(), last = cooldown.get(key) || 0;
    if (now - last < ms) return false;
    cooldown.set(key, now); return true;
  }
  function vol24(coin) {
    return Math.max(rec("BF", coin).q || 0, rec("BS", coin).q || 0, rec("OF", coin).q || 0, rec("OS", coin).q || 0);
  }

  /* ingest one ticker update */
  function onTick(mk, coin, price, open, qv, t) {
    if (!coin || STABLE.has(coin) || !(price > 0)) return;
    const r = rec(mk, coin);
    r.p = price; r.o = open; r.q = qv;
    const last = r.hist[r.hist.length - 1];
    if (!last || t - last[0] >= 1000) r.hist.push([t, price]);
    if (!r.vol.length || t - r.vol[r.vol.length - 1][0] >= 1000) r.vol.push([t, qv]);
    const keep = t - (CFG.pumpWin * 60000 + 60000);
    while (r.hist.length && r.hist[0][0] < keep) r.hist.shift();
    while (r.vol.length && r.vol[0][0] < t - 130000) r.vol.shift();
    if (qv < CFG.minVol24) return;
    detectPump(mk, coin, r, t);
    detectVolume(mk, coin, r, t);
  }

  function windowRange(r, ms, now) {
    let lo = Infinity, hi = -Infinity;
    for (const [t, p] of r.hist) if (t >= now - ms) { if (p < lo) lo = p; if (p > hi) hi = p; }
    return { lo, hi };
  }

  function detectPump(mk, coin, r, now) {
    if (r.hist.length < 2 || now - r.hist[0][0] < 60000) return;
    const { lo, hi } = windowRange(r, CFG.pumpWin * 60000, now);
    const thr = CFG.pumpPct / 100, p = r.p;
    const up = p / lo - 1, down = p / hi - 1;
    let dir = null, chg = 0;
    if (up >= thr && p >= hi * 0.995) { dir = "up"; chg = up; }
    else if (down <= -thr && p <= lo * 1.005) { dir = "down"; chg = down; }
    if (!dir) return;
    if (!coolOk(`pump:${mk}:${coin}:${dir}`, 15 * 60000)) return;
    emit("signal", {
      kind: "pump", mk, coin, dir, chg, win: CFG.pumpWin, price: p, t: now,
      chg24: r.o ? p / r.o - 1 : 0, range: (hi - lo) / p
    });
  }

  function takerFlow(mk, coin, now) {
    const arr = taker[mk] && taker[mk].get(coin);
    if (!arr) return null;
    let b = 0, s = 0;
    for (const x of arr) if (x.t >= now - 60000) { if (x.side === "buy") b += x.v; else s += x.v; }
    return b + s > 0 ? { b, s } : null;
  }

  function detectVolume(mk, coin, r, now) {
    if (!r.vol.length || now - r.vol[0][0] < 55000) return;
    let base = r.vol[0];
    for (const v of r.vol) { if (v[0] <= now - 60000) base = v; else break; }
    const vol1m = r.q - base[1];
    const avg1m = r.q / 1440;
    if (!(vol1m >= CFG.volMin && vol1m >= CFG.volMult * avg1m)) return;
    if (!coolOk(`vol:${mk}:${coin}`, 10 * 60000)) return;
    // direction: taker flow if we stream trades for it, otherwise price move during the minute
    let dir = "flat", how = "";
    const flow = takerFlow(mk, coin, now);
    if (flow && Math.abs(flow.b - flow.s) / (flow.b + flow.s) > 0.2) { dir = flow.b > flow.s ? "up" : "down"; how = `taker beli ${usd(flow.b)} vs jual ${usd(flow.s)}`; }
    else {
      let p0 = r.hist[0][1];
      for (const h of r.hist) { if (h[0] <= now - 60000) p0 = h[1]; else break; }
      const m = r.p / p0 - 1;
      dir = m > 0.003 ? "up" : m < -0.003 ? "down" : "flat";
      how = `harga ${pct(m)} dalam 1 menit`;
    }
    const { lo, hi } = windowRange(r, CFG.pumpWin * 60000, now);
    emit("whale", {
      kind: "volume", mk, coin, dir, value: vol1m, mult: vol1m / avg1m, how, price: r.p, t: now,
      chg24: r.o ? r.p / r.o - 1 : 0, range: (hi - lo) / r.p
    });
  }

  /* big single (or same-millisecond burst) trades from aggTrade */
  const bursts = new Map();
  function onTrade(mk, coin, price, qty, buyerMaker, t) {
    const v = price * qty, side = buyerMaker ? "sell" : "buy";
    let arr = taker[mk].get(coin);
    if (!arr) { arr = []; taker[mk].set(coin, arr); }
    arr.push({ t, side, v });
    while (arr.length && arr[0].t < t - 65000) arr.shift();
    const key = mk + ":" + coin;
    const b = bursts.get(key);
    if (b && b.side === side && t - b.last <= 100) { b.v += v; b.last = t; b.p = price; return; }
    if (b) flushBurst(key, b);
    bursts.set(key, { mk, coin, side, v, first: t, last: t, p0: price, p: price });
  }
  function flushBurst(key, b) {
    bursts.delete(key);
    const thr = MAJORS.has(b.coin) ? CFG.bigMajor : (b.mk === "BF" ? CFG.bigFut : CFG.bigSpot);
    if (b.v < thr) return;
    if (!coolOk(`big:${b.mk}:${b.coin}:${b.side}`, 20000)) return;
    const r = rec(b.mk, b.coin);
    if (r.q && r.q < CFG.minVol24) return;
    const { lo, hi } = windowRange(r, CFG.pumpWin * 60000, Date.now());
    emit("whale", {
      kind: "trade", mk: b.mk, coin: b.coin, dir: b.side === "buy" ? "up" : "down", value: b.v,
      price: b.p, t: b.first, chg24: r.o ? b.p / r.o - 1 : 0, range: isFinite(lo) ? (hi - lo) / b.p : 0
    });
  }
  function flushBursts() { const now = Date.now(); for (const [k, b] of bursts) if (now - b.last > 250) flushBurst(k, b); }

  /* liquidations */
  function onLiq(mk, coin, pos, price, value, t) {
    if (!coin || !(value > 0)) return;
    liqWin.push({ t, pos, v: value });
    if (opts.onLiqRaw) opts.onLiqRaw(mk, coin, pos, value, t);
    const now = Date.now();
    while (liqWin.length && liqWin[0].t < now - 3600000) liqWin.shift();
    if (value < CFG.liqMin) return;
    const dir = pos === "LONG" ? "down" : "up"; // pressure on price
    let cluster = 0;
    for (const x of recent) if (x.kind === "liq" && x.coin === coin && x.pos === pos && x.t >= now - 300000) cluster += x.value;
    cluster += value;
    const r = rec(mk, coin);
    const { lo, hi } = windowRange(r, CFG.pumpWin * 60000, now);
    emit("liq", { kind: "liq", mk, coin, pos, dir, price, value, cluster, t, chg24: r.o ? r.p / r.o - 1 : 0, range: isFinite(lo) && r.p ? (hi - lo) / r.p : 0 });
  }

  /* ============ recommendation engine (konservatif) ============ */
  function assess(s) {
    const FNG = opts.getFng ? opts.getFng() : null, BTC_TREND = (opts.getBtc && opts.getBtc()) || { dir: "flat", note: "tidak ada data" };
    const coin = s.coin, now = s.t;
    let score = 50;
    const plus = [], minus = [];
    const add = (n, why) => { score += n; (n >= 0 ? plus : minus).push([Math.abs(n), why]); };

    if (s.dir === "flat") {
      return { score: 40, verdict: "INFO", fut: "Arah belum jelas (beli dan jual seimbang). Tidak ada aksi.", spot: "Pantau saja.", reasons: ["Volume melonjak tapi tanpa arah dominan"] };
    }
    const long = s.dir === "up";
    const v24 = vol24(coin);

    // confluence across signals & exchanges in the last 15 minutes
    let same = 0, opp = 0;
    for (const x of recent) {
      if (x.coin !== coin || x.t < now - 900000 || x.id === s.id) continue;
      if (x.dir === s.dir) same++; else if (x.dir !== "flat") opp++;
    }
    if (same) add(Math.min(20, same * 10), `${same} sinyal lain searah dalam 15 menit`);
    if (opp) add(-Math.min(20, opp * 10), `${opp} sinyal berlawanan dalam 15 menit`);

    // liquidity
    if (v24 < 2e6) add(-30, `Likuiditas tipis (volume 24j ${usd(v24)}), rawan manipulasi`);
    else if (v24 < 10e6) add(-10, `Volume 24j hanya ${usd(v24)}`);
    else if (v24 > 50e6) add(5, `Likuid (volume 24j ${usd(v24)})`);

    // chasing
    if (long && s.chg24 > 0.25) add(-20, `Sudah naik ${pct(s.chg24, 1)} dalam 24j, risiko beli di pucuk`);
    if (!long && s.chg24 < -0.25) add(-20, `Sudah turun ${pct(s.chg24, 1)} dalam 24j, rawan pantulan`);
    if (s.kind === "pump" && Math.abs(s.chg) > 0.10) add(-10, `Lonjakan ${pct(s.chg, 1)} terlalu cepat, sering retrace`);

    // BTC regime
    if (BTC_TREND.dir === s.dir) add(10, `Searah tren BTC (${BTC_TREND.note})`);
    else if (BTC_TREND.dir !== "flat") add(-15, `Melawan tren BTC (${BTC_TREND.note})`);

    // sentiment
    if (FNG) {
      const f = FNG.value;
      if (long && f >= 75) add(-10, `Fear & Greed ${f} (keserakahan ekstrem), pasar rawan koreksi`);
      if (!long && f <= 25) add(-10, `Fear & Greed ${f} (ketakutan ekstrem), rawan pantulan`);
      if (long && f <= 25) add(5, `Fear & Greed ${f}: zona akumulasi kontrarian`);
    }

    // funding (Binance perp)
    const fr = funding.get(coin);
    if (fr != null) {
      if (long && fr > 0.0005) add(-10, `Funding ${(fr * 100).toFixed(3)}%: terlalu banyak yang LONG`);
      if (long && fr < 0) add(5, `Funding negatif ${(fr * 100).toFixed(3)}%: bahan bakar short squeeze`);
      if (!long && fr < -0.0005) add(-10, `Funding ${(fr * 100).toFixed(3)}%: terlalu banyak yang SHORT`);
      if (!long && fr > 0.0003) add(5, `Funding ${(fr * 100).toFixed(3)}%: LONG berlebihan, rawan turun`);
    }

    // size
    if (s.kind === "trade") {
      const thr = MAJORS.has(coin) ? CFG.bigMajor : (s.mk === "BF" ? CFG.bigFut : CFG.bigSpot);
      if (s.value >= thr * 5) add(5, `Order sangat besar (${usd(s.value)})`);
    }
    if (s.kind === "liq") add(-10, "Masuk setelah likuidasi = mengejar, tunggu harga stabil");

    score = clamp(Math.round(score), 0, 100);
    let verdict = score >= 75 ? "IKUT" : score >= 55 ? "TUNGGU" : "HINDARI";
    if (s.kind === "liq") {
      const big = MAJORS.has(coin) ? CFG.liqCluster * 10 : CFG.liqCluster;
      if (s.cluster < big) verdict = "INFO";
    }

    // trade plan
    const p = s.price;
    const slPct = clamp((s.range || 0.02) * 0.6, MAJORS.has(coin) ? 0.008 : 0.015, 0.05);
    const lev = MAJORS.has(coin) ? 3 : v24 < 10e6 ? 2 : 3;
    const sl = long ? p * (1 - slPct) : p * (1 + slPct);
    const tp1 = long ? p * (1 + slPct * 1.5) : p * (1 - slPct * 1.5);
    const tp2 = long ? p * (1 + slPct * 2.5) : p * (1 - slPct * 2.5);
    const pb = long ? p * (1 - slPct * 0.5) : p * (1 + slPct * 0.5);
    const side = long ? "LONG" : "SHORT";
    let fut, spot;

    if (s.kind === "liq") {
      if (verdict === "INFO") {
        fut = "Likuidasi tunggal, belum kaskade. Tidak ada aksi.";
        spot = "Tidak ada aksi.";
      } else if (s.pos === "LONG") {
        fut = "Kaskade LONG: jangan kejar SHORT di bawah. Tunggu harga stabil 15–30 menit, peluang pantulan baru diambil setelah candle 15m hijau.";
        spot = FNG && FNG.value <= 30 && BTC_TREND.dir !== "down"
          ? `Boleh cicil beli kecil di sekitar ${px(p)} kalau fundamental coin bagus. Stop di bawah ${px(p * (1 - slPct))}.`
          : "Tunggu harga stabil, jangan tangkap pisau jatuh.";
      } else {
        fut = verdict === "IKUT"
          ? `Short squeeze searah tren. LONG kecil ~${px(p)}, SL ${px(sl)}, TP1 ${px(tp1)}, maks ${lev}x.`
          : "Short squeeze: harga sering lanjut naik sebentar lalu koreksi. Jangan SHORT melawan, jangan kejar LONG.";
        spot = "Jangan kejar. Tunggu koreksi sebelum beli.";
      }
    } else if (verdict === "IKUT") {
      fut = `${side} ~${px(p)} · SL ${px(sl)} (${(slPct * 100).toFixed(1)}%) · TP1 ${px(tp1)} · TP2 ${px(tp2)} · maks ${lev}x`;
      spot = long ? `BELI BERTAHAP 3x (40/30/30%). Batal kalau tutup di bawah ${px(sl)}.` : "Jangan beli. Kalau pegang coin ini, kurangi atau pasang stop.";
    } else if (verdict === "TUNGGU") {
      fut = long ? `Belum masuk. Tunggu pullback ke ~${px(pb)} dan tertahan, baru LONG.` : `Belum masuk. Tunggu pantulan ke ~${px(pb)} yang gagal tembus, baru SHORT.`;
      spot = long ? `Tunggu koreksi ke ~${px(pb)} sebelum cicil beli.` : "Jangan beli dulu, whale sedang menjual.";
    } else {
      fut = `Jangan ${side}. ${minus.length ? minus.sort((a, b) => b[0] - a[0])[0][1] : "Sinyal lemah"}.`;
      spot = long ? "Jangan beli sekarang." : "Jangan beli, tunggu harga stabil.";
    }

    const reasons = [...minus, ...plus].sort((a, b) => b[0] - a[0]).slice(0, 3).map(x => (plus.some(y => y[1] === x[1]) ? "＋ " : "－ ") + x[1]);
    const r5 = v => +v.toPrecision(6);
    const plan = { side, entry: r5(p), sl: r5(sl), tp1: r5(tp1), tp2: r5(tp2), slPct: +slPct.toFixed(4), lev };
    return { score, verdict, fut, spot, reasons, plan };
  }

  let seq = 0;
  function emit(feed, s) {
    s.id = Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 5);
    s.f = feed;
    if (s.kind === "liq") recent.push({ id: s.id, coin: s.coin, dir: s.dir, t: s.t, kind: "liq", pos: s.pos, value: s.value });
    else recent.push({ id: s.id, coin: s.coin, dir: s.dir, t: s.t, kind: s.kind });
    while (recent.length && recent[0].t < Date.now() - 900000) recent.shift();
    s.reco = assess(s);
    delete s.range;
    opts.emit(feed, s);
  }

  return { M, funding, taker, liqWin, recent, onTick, onTrade, onLiq, flushBursts, assess, vol24 };
}

const api = { create, DEFAULTS, EX, STABLE, MAJORS, wib, usd, px, pct, esc, clamp, tf, df };
if (typeof module === "object" && module.exports) module.exports = api;
else root.WhaleEngine = api;
})(typeof self !== "undefined" ? self : this);
