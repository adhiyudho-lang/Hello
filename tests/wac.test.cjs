/* Deterministic WAC tests (no network). Run: node --test tests/wac.test.cjs */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../wac.js");
const CFG = require("../config/wac.json");
W.setConfig(JSON.parse(JSON.stringify(CFG)));
const H = 3600e3, T0 = Date.UTC(2026, 9, 11, 0, 0, 0);

// candle series helper: closes follow fn(i), volume vfn(i)
function series(n, tf, fn, vfn = () => 1000, t0 = T0 - n * tf) {
  return Array.from({ length: n }, (_, i) => { const c = fn(i), o = i ? fn(i - 1) : c; return { t: t0 + i * tf, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: vfn(i) }; });
}
const bull1d = series(220, 24 * H, i => 50000 + i * 150);          // steady uptrend -> BULLISH
const flat4h = series(60, 4 * H, i => 72000 + (i % 2) * 50);
const regimeBull = W.regime(bull1d, flat4h, T0);

test("BTC regime: steady uptrend is BULLISH, downtrend is BEARISH", () => {
  assert.equal(regimeBull.state, "BULLISH");
  const bear1d = series(220, 24 * H, i => 90000 - i * 150);
  assert.equal(W.regime(bear1d, series(60, 4 * H, i => 57000), T0).state, "BEARISH");
});

test("Jangan kejar: STRK +54% in 24h gives WATCH / TUNGGU PULLBACK, never BELI", () => {
  // strong run-up on 4h: last close far above EMA20 with a volume spike
  const c4h = series(80, 4 * H, i => (i < 70 ? 0.07 : 0.07 * Math.pow(1.045, i - 69)), i => (i === 79 ? 9000 : 1000));
  const ev = W.evalSpot({ coin: "STRK", now: T0, price: c4h[79].c, priceAt: T0, chg24: 0.54, vol24: 90e6, taker: { buy: 4e6, sell: 1e6 }, mult: 8, c4h, regime: regimeBull, equity: 10000 });
  assert.notEqual(ev.verdict, "BELI SPOT");
  assert.equal(ev.status, "WATCH");
  assert.equal(ev.verdict, "TUNGGU PULLBACK");
  assert.ok(ev.chase.length >= 1);
  assert.ok(ev.zone.hi < c4h[79].c, "zone sits below the current price (pullback)");
});

test("SL from ATR: min 5%, reject > 9%, reject R:R < 2", () => {
  const p1 = W.plan(100, 2);          // 1.5*2 = 3 < 5% -> 5%
  assert.equal(+p1.slPct.toFixed(4), 0.05);
  assert.equal(p1.rejects.length, 0);
  assert.ok(Math.abs(p1.rr - 18 / 5) < 1e-9);
  const p2 = W.plan(100, 7);          // 1.5*7 = 10.5% -> too far, and R:R 18/10.5 < 2
  assert.ok(p2.rejects.some(r => /SL terlalu jauh/.test(r)));
  assert.ok(p2.rejects.some(r => /R:R/.test(r)));
});

test("Spot sizing: 1% of $10k with SL 5% = $2,000 position, capped at 25% equity", () => {
  const s = W.sizing({ slPct: 0.05 }, { equity: 10000, riskPct: 1 });
  assert.equal(Math.round(s.risk), 100);
  assert.equal(Math.round(s.notional), 2000);
  const tight = W.sizing({ slPct: 0.02 }, { equity: 10000, riskPct: 1 });
  assert.equal(tight.notional, 2500);
  assert.ok(tight.capped);
  const bear = W.sizing({ slPct: 0.05 }, { equity: 10000, riskPct: 1, regime: "BEARISH" });
  assert.equal(Math.round(bear.notional), 1000);
});

test("Futures leverage: SL 5% -> 10x, notional $2,000, margin $200 (2% equity)", () => {
  const f = W.levPlan(0.05, 100, CFG.futures);
  assert.equal(f.maxLev, 10);
  assert.equal(Math.round(f.notional), 2000);
  // liquidation check may reduce leverage: 1/10 - 0.005 = 9.5% >= 1.5*5% = 7.5% -> stays 10x
  assert.equal(f.lev, 10);
  assert.equal(Math.round(f.margin), 200);
});

test("Liquidation distance lowers leverage when too close", () => {
  const f = W.levPlan(0.012, 100, CFG.futures); // max 41x, 1/41 - .005 = 1.9% < 1.8%? -> needs >= 1.8%
  assert.ok(1 / f.lev - CFG.futures.mmr >= CFG.futures.liqBuffer * 0.012);
  assert.ok(f.lev <= f.maxLev);
});

test("Weight profiles: STRK 54/31/15 coverage 100% without ETF row; SOL 35/35/20/10", () => {
  const t4 = W.tech4h(series(60, 4 * H, i => 1 + i * 0.01, () => 1000));
  const strk = W.score({ coin: "STRK", taker: { buy: 3, sell: 1 }, mult: 5, t4, regime: regimeBull, chg24: 0.02 });
  assert.equal(strk.profile, "Non-ETF");
  assert.deepEqual(strk.weights, { whale: 54, tech: 31, regime: 15 });
  assert.equal(Object.values(strk.weights).reduce((a, b) => a + b, 0), 100);
  assert.equal(strk.coverage, 100);
  assert.equal(strk.comps.etf, undefined);
  const sol = W.score({ coin: "SOL", taker: { buy: 3, sell: 1 }, mult: 5, t4, regime: regimeBull, etf: { score: 70, fresh: true }, chg24: 0.02 });
  assert.deepEqual(sol.weights, { etf: 35, whale: 35, tech: 20, regime: 10 });
  assert.equal(sol.coverage, 100);
});

test("BTC with stale ETF: score normalised over 65%, coverage 65%", () => {
  const t4 = W.tech4h(series(60, 4 * H, i => 60000 + i * 50));
  const b = W.score({ coin: "BTC", taker: { buy: 3, sell: 1 }, mult: 3, t4, regime: regimeBull, etf: { score: 90, fresh: false } });
  assert.equal(b.coverage, 65);
  assert.equal(b.comps.etf.status, "na");
  const w = b.weights, c = b.comps;
  const manual = Math.round((w.whale * c.whale.score + w.tech * c.tech.score + w.regime * c.regime.score) / 65);
  assert.equal(b.score, manual);
});

test("Adding an asset to etfAssets moves it to the ETF profile", () => {
  const cfg = JSON.parse(JSON.stringify(CFG)); cfg.etfAssets.push("XRP"); W.setConfig(cfg);
  assert.equal(W.score({ coin: "XRP", dirUp: true }).profile, "ETF");
  W.setConfig(JSON.parse(JSON.stringify(CFG)));
  assert.equal(W.score({ coin: "XRP", dirUp: true }).profile, "Non-ETF");
});

test("Coverage < 50% blocks BELI; stale data blocks BELI; proxy whale never STRONG", () => {
  const s = W.score({ coin: "BTC", taker: { buy: 9, sell: 1 }, mult: 9 });
  assert.ok(s.coverage < 50);
  const st = W.score({ coin: "STRK", taker: { buy: 100, sell: 0 }, mult: 20, t4: W.tech4h(series(60, 4 * H, i => 1 + i * 0.02, i => (i === 59 ? 5000 : 1000))), regime: regimeBull });
  assert.notEqual(st.cls, "STRONG ACCUMULATION");
  const c4h = series(80, 4 * H, i => 1 + i * 0.002, i => (i === 79 ? 3000 : 1000));
  const ev = W.evalSpot({ coin: "LINK", now: T0, price: c4h[79].c, priceAt: T0 - 20 * 60e3, chg24: 0.01, vol24: 90e6, taker: { buy: 3e5, sell: 1e5 }, mult: 5, c4h, regime: regimeBull });
  assert.notEqual(ev.verdict, "BELI SPOT");
  assert.ok(ev.rejects.some(r => /stale/.test(r)));
});

test("Lifecycle numbering, linking and pullback reminders without duplicates", () => {
  const state = { seq: 127, daily: {}, signals: [] };
  const c4h = series(80, 4 * H, i => 1 + i * 0.002, i => (i === 79 ? 3000 : 1000));
  const t4 = W.tech4h(c4h);
  const ev = { status: "WATCH", verdict: "TUNGGU PULLBACK", why: "test", pattern: "B", zone: { lo: 1.10, hi: 1.12, basis: "x" }, inval: 1.04, plan: W.plan(1.11, t4.atr), t4, score: W.score({ coin: "STRK", dirUp: true, t4, regime: regimeBull }), expiresAt: T0 + 72 * H };
  const sig = W.createSignal(state, { coin: "STRK", mk: "OF", t: T0, kind: "volume", value: 5.22e6, mult: 8, price: 1.2 }, ev, T0);
  assert.equal(sig.no, 128);
  assert.equal(sig.id, "WAC-STRK-20261011-001");
  assert.equal(W.activeFor(state, "STRK"), sig);
  const obs = (now, price, c1h) => ({ now, price, c1h, regime: regimeBull, t4 });
  const flat1h = series(30, H, () => 1.2, () => 100, T0 - 30 * H);
  let ev1 = W.step(sig, obs(T0 + H, 1.13, flat1h));
  assert.ok(ev1.some(e => e.status === "NEAR_ZONE"));
  assert.ok(!W.step(sig, obs(T0 + H + 60e3, 1.13, flat1h)).some(e => e.status === "NEAR_ZONE"), "no duplicate near-zone reminder");
  ev1 = W.step(sig, obs(T0 + 2 * H, 1.11, flat1h));
  assert.ok(ev1.some(e => e.status === "IN_ZONE"));
  assert.ok(!W.step(sig, obs(T0 + 2 * H + 60e3, 1.11, flat1h)).some(e => e.status === "IN_ZONE"));
  // green 1h close above zone low after the touch, shrinking red volume -> ENTRY_READY
  const conf1h = series(30, H, i => (i === 29 ? 1.115 : i === 28 ? 1.105 : 1.2 - i * 0.003), i => (i === 28 ? 40 : i >= 26 ? 50 : 100), T0 - 27 * H);
  conf1h[29].o = 1.105; conf1h[29].c = 1.115;
  const e2 = W.step(sig, obs(T0 + 3 * H, 1.115, conf1h));
  assert.ok(e2.some(e => e.status === "ENTRY_READY"));
  // next observation opens the virtual position
  W.step(sig, obs(T0 + 3 * H + 60e3, 1.115, conf1h));
  const e3 = W.step(sig, obs(T0 + 3 * H + 120e3, 1.115, conf1h));
  assert.equal(sig.status, "POSITION_OPEN", JSON.stringify(e3));
  // TP1 -> partial, then back to entry -> break-even exit
  W.step(sig, obs(T0 + 5 * H, sig.pos.tp1 * 1.001, conf1h));
  assert.equal(sig.status, "TAKE_PROFIT_PARTIAL");
  W.step(sig, obs(T0 + 6 * H, sig.pos.entry * 0.999, conf1h));
  assert.equal(sig.status, "EXIT_CONFIRMED");
  assert.ok(sig.result.ret > 0.03);
});

test("Invalidation and expiry", () => {
  const state = { seq: 0, daily: {}, signals: [] };
  const t4 = W.tech4h(series(60, 4 * H, i => 1 + i * 0.002));
  const mk = () => W.createSignal(state, { coin: "ABC", mk: "BS", t: T0, kind: "volume", price: 1.2 }, { status: "WATCH", verdict: "TUNGGU PULLBACK", why: "x", pattern: "B", zone: { lo: 1.1, hi: 1.12 }, inval: 1.04, plan: W.plan(1.11, 0.01), t4, score: W.score({ coin: "ABC", dirUp: true, t4 }), expiresAt: T0 + 72 * H }, T0);
  const a = mk();
  const low1h = series(5, H, () => 1.0, () => 100, T0);
  assert.ok(W.step(a, { now: T0 + 5 * H, price: 1.0, c1h: low1h, regime: regimeBull }).some(e => e.status === "ENTRY_INVALIDATED"));
  const b = mk();
  assert.ok(W.step(b, { now: T0 + 73 * H, price: 1.2, c1h: [], regime: regimeBull }).some(e => e.status === "EXPIRED"));
  const c = mk();
  assert.ok(W.step(c, { now: T0 + H, price: 1.2, c1h: [], regime: { state: "RISK-OFF" } }).some(e => e.status === "ENTRY_INVALIDATED"));
});

test("WIB conversion for signal ids", () => {
  const state = { seq: 0, daily: {}, signals: [] };
  const t = Date.UTC(2026, 9, 10, 18, 0); // 01:00 WIB on 11 Oct
  const t4 = W.tech4h(series(60, 4 * H, i => 1 + i * 0.002));
  const s = W.createSignal(state, { coin: "X", mk: "BS", t, kind: "volume", price: 1 }, { status: "WATCH", verdict: "TUNGGU PULLBACK", why: "x", pattern: "B", zone: { lo: 1, hi: 1 }, inval: 0.9, plan: W.plan(1, 0.01), t4, score: W.score({ coin: "X", dirUp: true, t4 }), expiresAt: t + 72 * H }, t);
  assert.equal(s.id, "WAC-X-20261011-001");
});

test("Illiquid coin stays DETECTED (no number); volatile SL > 9% is WATCH but never ENTRY_READY", () => {
  const c4h = series(80, 4 * H, i => 1 + Math.sin(i / 3) * 0.01, () => 1000);
  const thin = W.evalSpot({ coin: "THIN", now: T0, price: 1, priceAt: T0, chg24: 0.02, vol24: 5e6, taker: { buy: 3, sell: 1 }, c4h, regime: regimeBull });
  assert.equal(thin.status, "DETECTED");
  assert.ok(!W.PRE.includes(thin.status));
  // very volatile coin: ATR ~ 10% -> SL 15% -> rejected, but the zone is still watched
  const wild = series(80, 4 * H, i => 1 + (i % 2 ? 0.1 : -0.1) + i * 0.002, i => (i === 79 ? 5000 : 1000));
  const ev = W.evalSpot({ coin: "WILD", now: T0, price: wild[79].c, priceAt: T0, chg24: 0.05, vol24: 50e6, taker: { buy: 3, sell: 1 }, c4h: wild, regime: regimeBull });
  assert.equal(ev.status, "WATCH");
  assert.ok(/SL terlalu jauh/.test(ev.why));
  assert.ok(ev.zone.lo > ev.plan.sl, "zone lower edge stays above the invalidation");
  const st = { seq: 0, daily: {}, signals: [] };
  const sig = W.createSignal(st, { coin: "WILD", mk: "BS", t: T0, kind: "volume", value: 1e6, mult: 5, price: wild[79].c }, ev, T0);
  // price dips into the zone and a green 1h candle closes back above it: still no ENTRY_READY
  const mid = (sig.zone.lo + sig.zone.hi) / 2;
  W.step(sig, { now: T0 + H, price: mid, regime: regimeBull });
  const c1 = series(20, H, i => mid * (i === 19 ? 1.01 : 1 - (i % 2) * 0.001), i => 200 - i * 5, T0 + H - 19 * H);
  W.step(sig, { now: T0 + 2 * H, price: mid * 1.01, c1h: c1, t4: W.tech4h(wild), regime: regimeBull });
  assert.notEqual(sig.status, "ENTRY_READY");
  assert.ok(sig.events.some(e => /entry ditolak/.test(e.text)));
});

test("ENTRY READY notification carries spot sizing and the fixed money-management text", () => {
  const sig = { no: 128, coin: "STRK", t: T0, src: { kind: "volume", value: 1e6, mult: 9 }, zone: { lo: 0.95, hi: 1 }, inval: 0.95, plan: { entry: 1, sl: 0.95, slPct: 0.05, tp1: 1.09, tp2: 1.18, rr: 3.6 }, events: [] };
  const n = W.notifText(sig, "ENTRY_READY", Object.assign({ when: () => "10:15 WIB", srcText: () => "x", price: 1 }, W.entryTexts(sig, { equity: 10000, riskPct: 1 })));
  assert.match(n.title, /Sinyal #128/);
  assert.match(n.body, /total \$2,000/);
  assert.match(n.body, /Money management: risiko maks 1% equity per posisi \(\$100\)\. Leverage hanya mengecilkan margin, tidak mengurangi risiko\. Pasang SL di exchange sebelum entry\./);
  assert.match(n.body, /funding N\/A/);
});
