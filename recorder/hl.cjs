/* Hyperliquid whale tracker for the 24/7 recorder.
   - Every hour: leaderboard (stats-data.hyperliquid.xyz) -> top N by account value and top N by 30-day PnL,
     counting only wallets that actually hold perp positions (many of the largest accounts only hold spot).
   - Every pollSec: positions of watched wallets (top lists + config/hl-watch/*.json) -> events
     (OPEN / ADD / REDUCE / CLOSE / FLIP) above minEventUsd, deposits / withdrawals above minFlowUsd.
   - Writes data/hl.json (wallets, per-coin long/short, events) for the dashboard; Telegram for events. */
"use strict";
const fs = require("fs");
const path = require("path");
const HL = require("../hl.js");

module.exports = function createHL({ sleep, log, tgSend, usd, wib, DATA }) {
  const C = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/hl.json"), "utf8"));
  const FILE = path.join(DATA, "hl.json");
  const S = (() => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { top: { size: [], pnl: [] }, wallets: {}, events: [], coins: {} }; } })();
  S.events = S.events || [];
  let topAt = S.topAt || 0, flowAt = {};

  async function info(body) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(HL.API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
        if (r.ok) return await r.json();
      } catch {}
      await sleep(800);
    }
    return null;
  }
  function custom() {
    const dir = path.join(__dirname, "../config/hl-watch"), out = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); const a = String(j.address || f.replace(".json", "")).toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(a)) out.push({ addr: a, name: String(j.name || "").slice(0, 40) }); } catch {}
      }
    } catch {}
    return out;
  }
  async function refreshTop() {
    if (Date.now() - topAt < C.topRefreshMin * 60e3 && S.top.size.length) return;
    const r = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { signal: AbortSignal.timeout(60000) }).then(x => x.json()).catch(() => null);
    if (!r || !r.leaderboardRows) { log("hl leaderboard gagal"); return; }
    const rows = r.leaderboardRows.map(x => ({ addr: x.ethAddress.toLowerCase(), accountValue: +x.accountValue, name: x.displayName || null, perf: Object.fromEntries(x.windowPerformances.map(([k, v]) => [k, { pnl: +v.pnl, roi: +v.roi, vlm: +v.vlm }])) }));
    const pick = async (sorted, n) => {
      const out = [];
      for (const x of sorted.slice(0, C.scanMax)) {
        if (out.length >= n) break;
        const st = await info({ type: "clearinghouseState", user: x.addr });
        await sleep(250);
        if (!st) continue;
        const pos = HL.positions(st);
        if (!pos.length) continue;
        out.push(x.addr);
        store(x, st, pos);
      }
      return out;
    };
    const size = await pick(rows.slice().sort((a, b) => b.accountValue - a.accountValue), C.topSize);
    const pnl = await pick(rows.slice().sort((a, b) => (b.perf[C.pnlWindow] || {}).pnl - (a.perf[C.pnlWindow] || {}).pnl), C.topPnl);
    for (const x of rows) if (S.wallets[x.addr]) Object.assign(S.wallets[x.addr], { accountValue: x.accountValue, perf: x.perf, lbName: x.name });
    S.top = { size, pnl }; topAt = S.topAt = Date.now();
    log(`hl top: ${size.length} ukuran akun, ${pnl.length} pnl 30 hari`);
  }
  function store(lb, st, pos) {
    const w = (S.wallets[lb.addr] = S.wallets[lb.addr] || { addr: lb.addr });
    if (lb.accountValue != null) Object.assign(w, { accountValue: lb.accountValue, perf: lb.perf, lbName: lb.name });
    Object.assign(w, HL.summary(st), { positions: pos, at: Date.now() });
    return w;
  }
  async function poll() {
    const watch = new Map();
    for (const a of [...S.top.size, ...S.top.pnl]) watch.set(a, null);
    for (const c of custom()) watch.set(c.addr, c.name);
    S.custom = [...watch].filter(([, n]) => n != null).map(([addr, name]) => ({ addr, name }));
    const now = Date.now();
    for (const [addr, name] of watch) {
      const st = await info({ type: "clearinghouseState", user: addr });
      await sleep(200);
      if (!st) continue;
      const prev = S.wallets[addr] && S.wallets[addr].positions, had = !!(S.wallets[addr] && S.wallets[addr].at);
      const w = store({ addr }, st, HL.positions(st));
      if (name) w.name = name;
      if (had) for (const e of HL.diff(prev, w.positions, C.minEventUsd, { t: now, addr })) await event(e);
      // capital in / out every 10 minutes per wallet
      if (now - (flowAt[addr] || 0) > 10 * 60e3) {
        const since = flowAt[addr] || now - 2 * 3600e3;
        flowAt[addr] = now;
        const up = await info({ type: "userNonFundingLedgerUpdates", user: addr, startTime: since });
        await sleep(200);
        for (const e of HL.flows(up, C.minFlowUsd, addr)) if (!S.events.some(x => x.hash && x.hash === e.hash)) await event(e);
      }
    }
    const ws = [...watch.keys()].map(a => S.wallets[a]).filter(Boolean);
    S.coins = HL.coins(ws);
    S.updated = now;
    const cut = now - C.keepEventsDays * 86400e3;
    S.events = S.events.filter(e => e.t > cut).slice(-C.maxEvents);
    // drop wallets no longer watched
    for (const a of Object.keys(S.wallets)) if (!watch.has(a)) delete S.wallets[a];
  }
  function label(addr) {
    const w = S.wallets[addr] || {}, c = (S.custom || []).find(x => x.addr === addr);
    if (c && c.name) return c.name;
    const i = S.top.size.indexOf(addr), j = S.top.pnl.indexOf(addr);
    return i >= 0 ? `Top akun #${i + 1}` : j >= 0 ? `Top PnL #${j + 1}` : HL.short(addr);
  }
  async function event(e) {
    e.who = label(e.addr);
    S.events.push(e);
    const txt = e.type === "DEPOSIT" || e.type === "WITHDRAW"
      ? `${e.who} ${HL.EVENT_TEXT[e.type]} ${usd(e.usd)} ke/dari Hyperliquid`
      : `${e.who} ${HL.EVENT_TEXT[e.type]} ${e.side} ${e.coin} ${usd(e.usd)}${e.lev ? ` · ${e.lev}x` : ""}${e.liq ? ` · likuidasi ${e.liq}` : ""}`;
    log("hl", txt);
    const flow = e.type === "DEPOSIT" || e.type === "WITHDRAW";
    if (e.usd >= (flow ? C.tgMinFlowUsd : C.tgMinEventUsd)) await tgSend(`🐋 Hyperliquid: ${txt}`, `${HL.short(e.addr)} · ${wib(e.t)} · https://app.hyperliquid.xyz/explorer/address/${e.addr}`, "whale");
  }
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try { await refreshTop(); await poll(); } catch (e) { log("hl", e.message); } finally { busy = false; }
  }
  const snapshot = () => ({ updated: S.updated, topAt: S.topAt, cfg: { minEventUsd: C.minEventUsd, pnlWindow: C.pnlWindow }, top: S.top, custom: S.custom || [], wallets: S.wallets, coins: S.coins, events: S.events });
  return { tick, snapshot, S, C };
};
