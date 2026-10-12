/* Signal Intelligence tests (no network). Run: node --test tests/flow.test.cjs */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../flow.js");
F.setConfig(JSON.parse(JSON.stringify(require("../config/flow.json"))));
const M5 = F.M5;

// ---- A2 matrix: one test per row ----
test("A2 row 1: buy dominant + OI up > 1% -> LONG_BARU (+2)", () => {
  const c = F.classify({ ratio: 1.8, oiPct: 0.024, funding: 0.0001, buy: 1e6 });
  assert.equal(c.label, "LONG_BARU"); assert.equal(c.weight, 2); assert.equal(c.side, 1);
});
test("A2 row 2: buy dominant + OI down < -1% -> SHORT_COVER (0)", () => {
  const c = F.classify({ ratio: 1.5, oiPct: -0.024, buy: 1e6 });
  assert.equal(c.label, "SHORT_COVER"); assert.equal(c.weight, 0);
});
test("A2 row 3: sell dominant + OI up -> SHORT_BARU (-2)", () => {
  const c = F.classify({ ratio: 0.6, oiPct: 0.015, buy: 1e6 });
  assert.equal(c.label, "SHORT_BARU"); assert.equal(c.weight, -2); assert.equal(c.side, -1);
});
test("A2 row 4: sell dominant + OI down -> LONG_EXIT (-1)", () => {
  const c = F.classify({ ratio: 0.5, oiPct: -0.02, buy: 1e6 });
  assert.equal(c.label, "LONG_EXIT"); assert.equal(c.weight, -1);
});
test("A2 row 5: anything else (OI within ±1% or ratio in between) -> NETRAL (0)", () => {
  assert.equal(F.classify({ ratio: 1.8, oiPct: 0.005, buy: 1e6 }).label, "NETRAL");
  assert.equal(F.classify({ ratio: 1.1, oiPct: 0.05, buy: 1e6 }).label, "NETRAL");
  assert.equal(F.classify({ ratio: 1.1, oiPct: 0.05, buy: 1e6 }).weight, 0);
});
test("Thresholds are configurable", () => {
  const k = F.cfg(), old = k.oiPct;
  k.oiPct = 0.003;
  assert.equal(F.classify({ ratio: 1.8, oiPct: 0.005, buy: 1e6 }).label, "LONG_BARU");
  k.oiPct = old;
});

// ---- A3 context filters ----
test("A3: funding > +0.05% lowers LONG_BARU weight (crowded long)", () => {
  const c = F.classify({ ratio: 1.8, oiPct: 0.03, funding: 0.0008, buy: 1e6 });
  assert.equal(c.label, "LONG_BARU"); assert.equal(c.weight, 1); assert.ok(c.tags.includes("CROWDED_LONG"));
});
test("A3: funding < -0.05% + SHORT_COVER -> SQUEEZE_POTENSIAL", () => {
  assert.ok(F.classify({ ratio: 1.6, oiPct: -0.02, funding: -0.0009, buy: 1e6 }).tags.includes("SQUEEZE_POTENSIAL"));
});
test("A3: buy signal after > 8% drop in 3h -> BOUNCE_ZONE (STRK case)", () => {
  assert.ok(F.classify({ ratio: 1.6, oiPct: -0.024, buy: 3.78e6, drop3h: -0.12 }).tags.includes("BOUNCE_ZONE"));
  assert.ok(!F.classify({ ratio: 1.6, oiPct: -0.024, buy: 3.78e6, drop3h: -0.03 }).tags.includes("BOUNCE_ZONE"));
});
test("A3: short liquidations > 30% of taker buy force SHORT_COVER", () => {
  const c = F.classify({ ratio: 1.8, oiPct: 0.03, buy: 1e6, liqShort: 410e3 });
  assert.equal(c.label, "SHORT_COVER"); assert.ok(c.tags.includes("LIQ_SHORT"));
});
test("Spot (no OI): SPOT_BELI / SPOT_JUAL / NETRAL", () => {
  assert.equal(F.classify({ ratio: 2, oiPct: null, buy: 1e5 }).label, "SPOT_BELI");
  assert.equal(F.classify({ ratio: 0.5, oiPct: null, buy: 1e5 }).label, "SPOT_JUAL");
  assert.equal(F.classify({ ratio: 1, oiPct: null, buy: 1e5 }).label, "NETRAL");
});

// ---- bucket pipeline ----
const T0 = Date.UTC(2026, 9, 12, 3, 0, 0);
function series(spec) {
  // spec: array of [buy, sell, oi, close] starting 40 buckets before the signal bucket
  return spec.map((x, i) => ({ t: T0 + (i - 40) * M5, buy: x[0], sell: x[1], oi: x[2], close: x[3], high: x[3] }));
}
const flat = Array.from({ length: 40 }, () => [100e3, 100e3, 10e6, 1]);
test("classifyAt waits for the signal bucket to close, then classifies it vs the next OI snapshot", () => {
  const s = series([...flat, [600e3, 200e3, 10e6, 1.01], [100e3, 100e3, 10.3e6, 1.01]]);
  assert.equal(F.classifyAt(s, T0 + 60e3, {}, T0 + 2 * 60e3), null);
  const c = F.classifyAt(s, T0 + 60e3, { funding: 0.0001 }, T0 + M5 + 60e3);
  assert.equal(F.classifyAt(series([...flat, [600e3, 200e3, 10e6, 1.01]]), T0 + 60e3, {}, T0 + M5 + 60e3), null, "futures waits for the next OI snapshot");
  assert.equal(c.label, "LONG_BARU");
  assert.equal(c.ratio, 3);
  assert.equal(c.base.oiUp, 0.3e6);
});

// ---- B3 statuses ----
function track(after) {
  const s = series([...flat, [600e3, 200e3, 10e6, 1.0], ...after]);
  const cl = F.classifyAt(s, T0 + 60e3, {}, T0 + 2 * M5);
  return { s, cl, cp: n => F.checkpoint(s, T0 + 60e3, cl, n, T0 + 20 * M5) };
}
test("B3: OI holds, CVD positive, price above signal -> MASIH_DI_DALAM", () => {
  const { cp } = track([[100e3, 100e3, 10.3e6, 1.0], [300e3, 100e3, 10.35e6, 1.004], [200e3, 100e3, 10.35e6, 1.004], [200e3, 100e3, 10.35e6, 1.005]]);
  assert.equal(cp(15).st, "MASIH_DI_DALAM");
});
test("B3: price and OI keep rising -> FOLLOW_THROUGH", () => {
  const { cp } = track([[100e3, 100e3, 10.3e6, 1.0], [400e3, 100e3, 10.5e6, 1.02], [300e3, 100e3, 10.6e6, 1.03], [300e3, 100e3, 10.7e6, 1.03]]);
  assert.equal(cp(15).st, "FOLLOW_THROUGH");
});
test("B3: sell burst >= 50% of the initial buy -> SUDAH_KELUAR", () => {
  const { cp } = track([[100e3, 100e3, 10.3e6, 1.0], [100e3, 350e3, 10.3e6, 0.99], [100e3, 100e3, 10.3e6, 0.99]]);
  const r = cp(15);
  assert.equal(r.st, "SUDAH_KELUAR"); assert.match(r.why, /burst/);
});
test("B3: OI gives back > 50% of the initial increase -> SUDAH_KELUAR", () => {
  const { cp } = track([[100e3, 100e3, 10.3e6, 1.0], [150e3, 100e3, 10.1e6, 1.0], [150e3, 100e3, 10.1e6, 1.0]]);
  assert.equal(cp(5).st, "SUDAH_KELUAR");
});
test("B3: price, OI and CVD flat -> TIDAK_ADA_FT", () => {
  const { cp } = track([[100e3, 100e3, 10.3e6, 1.0], [100e3, 100e3, 10.3e6, 1.0], [100e3, 100e3, 10.3e6, 1.0]]);
  assert.equal(cp(5).st, "TIDAK_ADA_FT");
});
test("B3: seller-side signals are tracked in the sell direction", () => {
  const base = { buy: 200e3, sell: 600e3 };
  assert.equal(F.statusOf({ dp: -0.012, doi: 0.01, cvd: -300e3, maxBurst: 50e3 }, base, -1).st, "FOLLOW_THROUGH");
  assert.equal(F.statusOf({ dp: -0.001, doi: 0.0, cvd: -50e3, maxBurst: 400e3 }, base, -1).st, "SUDAH_KELUAR");
});

// ---- Modul C (adapter, pure part) ----
test("Modul C: exchange -> private = WITHDRAW (+1), private -> exchange = DEPOSIT (-1)", () => {
  const { classifyTransfer } = require("../recorder/adapters.cjs");
  const w = { Binance: ["0xAAA"] };
  assert.equal(classifyTransfer("0xaaa", "0xbbb", w).type, "WITHDRAW");
  assert.equal(classifyTransfer("0xbbb", "0xAAA", w).weight, -1);
  assert.equal(classifyTransfer("0xccc", "0xbbb", w).type, "PRIVATE");
});
