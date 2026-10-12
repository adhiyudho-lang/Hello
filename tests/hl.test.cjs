/* Hyperliquid whale tracker tests (no network). Run: node --test tests/hl.test.cjs */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const HL = require("../hl.js");
const P = (coin, szi, ntl, extra) => Object.assign({ coin, side: szi > 0 ? "LONG" : "SHORT", szi, ntl, entry: ntl / Math.abs(szi), lev: 10, liq: 1, upnl: 0 }, extra || {});
const ctx = { t: 1, addr: "0xabc" };

test("positions() reads a clearinghouseState and drops empty positions", () => {
  const st = { assetPositions: [{ position: { coin: "BTC", szi: "-2", positionValue: "160000", entryPx: "81000", leverage: { value: 5 }, liquidationPx: "95000", unrealizedPnl: "2000" } }, { position: { coin: "ETH", szi: "0", positionValue: "0" } }] };
  const p = HL.positions(st);
  assert.equal(p.length, 1); assert.equal(p[0].side, "SHORT"); assert.equal(p[0].ntl, 160000); assert.equal(p[0].liq, 95000);
});
test("diff: OPEN / ADD / REDUCE / CLOSE / FLIP above the minimum, nothing below it", () => {
  assert.equal(HL.diff([], [P("BTC", 10, 800e3)], 250e3, ctx)[0].type, "OPEN");
  assert.equal(HL.diff([], [P("BTC", 1, 80e3)], 250e3, ctx).length, 0);
  assert.equal(HL.diff([P("BTC", 10, 800e3)], [P("BTC", 15, 1200e3)], 250e3, ctx)[0].type, "ADD");
  assert.equal(HL.diff([P("BTC", 10, 800e3)], [P("BTC", 5, 400e3)], 250e3, ctx)[0].type, "REDUCE");
  assert.equal(HL.diff([P("BTC", 10, 800e3)], [P("BTC", 10.5, 840e3)], 250e3, ctx).length, 0);
  const c = HL.diff([P("BTC", 10, 800e3, { upnl: 5000 })], [], 250e3, ctx)[0];
  assert.equal(c.type, "CLOSE"); assert.equal(c.pnl, 5000);
  const f = HL.diff([P("ETH", 100, 300e3)], [P("ETH", -100, 300e3)], 250e3, ctx)[0];
  assert.equal(f.type, "FLIP"); assert.equal(f.side, "SHORT"); assert.equal(f.from, "LONG");
});
test("flows (Modul C logic): deposit = capital in, withdraw = capital out, above minimum only", () => {
  const up = [{ time: 1, hash: "a", delta: { type: "deposit", usdc: "500000" } }, { time: 2, hash: "b", delta: { type: "withdraw", usdc: "2000000" } }, { time: 3, hash: "c", delta: { type: "deposit", usdc: "100" } }, { time: 4, hash: "d", delta: { type: "spotTransfer", usdcValue: "9e6" } }];
  const f = HL.flows(up, 100e3, "0xabc");
  assert.deepEqual(f.map(x => x.type), ["DEPOSIT", "WITHDRAW"]);
});
test("coins(): long vs short notional per coin", () => {
  const c = HL.coins([{ positions: [P("BTC", 1, 100), P("ETH", -1, 50)] }, { positions: [P("BTC", -1, 30)] }]);
  assert.deepEqual(c.BTC, { long: 100, short: 30, nLong: 1, nShort: 1 });
  assert.equal(c.ETH.short, 50);
});
