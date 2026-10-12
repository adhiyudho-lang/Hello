/* Hyperliquid whale tracker: pure helpers shared by the browser (whale.js) and the recorder (recorder/hl.cjs).
   Hyperliquid is an on-chain perp exchange, so positions are public per wallet address. These helpers turn a
   clearinghouseState into positions and compare two snapshots into events (spec Modul C logic applied to HL:
   capital in = DEPOSIT, capital out = WITHDRAW, plus position OPEN / ADD / REDUCE / CLOSE / FLIP). */
(function (root) {
"use strict";
const API = "https://api.hyperliquid.xyz/info";
const num = v => (v == null || v === "" ? null : +v);

function positions(state) {
  const out = [];
  for (const p of (state && state.assetPositions) || []) {
    const q = p.position, szi = num(q.szi);
    if (!szi) continue;
    out.push({ coin: q.coin, side: szi > 0 ? "LONG" : "SHORT", szi, ntl: Math.abs(num(q.positionValue) || 0), entry: num(q.entryPx), lev: q.leverage ? num(q.leverage.value) : null, liq: num(q.liquidationPx), upnl: num(q.unrealizedPnl) });
  }
  return out.sort((a, b) => b.ntl - a.ntl);
}
function summary(state) {
  const m = (state && state.marginSummary) || {};
  return { perpValue: num(m.accountValue) || 0, ntl: num(m.totalNtlPos) || 0 };
}

// compare previous and current positions of one wallet; returns events above minUsd
function diff(prev, cur, minUsd, ctx) {
  const ev = [], P = new Map((prev || []).map(p => [p.coin, p])), N = new Map((cur || []).map(p => [p.coin, p]));
  const px = (p, q) => (q && q.ntl && q.szi ? q.ntl / Math.abs(q.szi) : p && p.ntl && p.szi ? p.ntl / Math.abs(p.szi) : null);
  for (const coin of new Set([...P.keys(), ...N.keys()])) {
    const a = P.get(coin), b = N.get(coin), sa = a ? a.szi : 0, sb = b ? b.szi : 0;
    if (sa === sb) continue;
    const price = px(a, b);
    const mk = (type, side, usd, extra) => ev.push(Object.assign({ t: ctx.t, addr: ctx.addr, coin, type, side, usd: Math.round(usd), price, lev: b ? b.lev : a.lev, liq: b ? b.liq : null, entry: b ? b.entry : a.entry, size: b ? b.ntl : 0 }, extra || {}));
    if (!sa && sb) { if (b.ntl >= minUsd) mk("OPEN", b.side, b.ntl); }
    else if (sa && !sb) { if (a.ntl >= minUsd) mk("CLOSE", a.side, a.ntl, { pnl: a.upnl }); }
    else if (Math.sign(sa) !== Math.sign(sb)) { if (Math.max(a.ntl, b.ntl) >= minUsd) mk("FLIP", b.side, b.ntl, { from: a.side }); }
    else {
      const d = Math.abs(Math.abs(sb) - Math.abs(sa)) * (price || 0);
      if (d >= minUsd) mk(Math.abs(sb) > Math.abs(sa) ? "ADD" : "REDUCE", b.side, d);
    }
  }
  return ev;
}
// deposits / withdrawals of USDC into the HL account (ledger updates)
function flows(updates, minUsd, addr) {
  const out = [];
  for (const u of updates || []) {
    const d = u.delta || {}, usd = num(d.usdc) || num(d.usdcValue) || 0;
    if (d.type === "deposit" && usd >= minUsd) out.push({ t: u.time, addr, type: "DEPOSIT", usd: Math.round(usd), hash: u.hash });
    if (d.type === "withdraw" && usd >= minUsd) out.push({ t: u.time, addr, type: "WITHDRAW", usd: Math.round(usd), hash: u.hash });
  }
  return out;
}
// long vs short notional per coin over a set of wallets
function coins(wallets) {
  const out = {};
  for (const w of wallets) for (const p of w.positions || []) {
    const c = (out[p.coin] = out[p.coin] || { long: 0, short: 0, nLong: 0, nShort: 0 });
    if (p.side === "LONG") { c.long += p.ntl; c.nLong++; } else { c.short += p.ntl; c.nShort++; }
  }
  return out;
}
const EVENT_TEXT = { OPEN: "buka", ADD: "tambah", REDUCE: "kurangi", CLOSE: "tutup", FLIP: "balik ke", DEPOSIT: "deposit USDC", WITHDRAW: "tarik USDC" };
const short = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";

const api = { API, positions, summary, diff, flows, coins, EVENT_TEXT, short };
if (typeof module === "object" && module.exports) module.exports = api;
else root.HL = api;
})(typeof self !== "undefined" ? self : this);
