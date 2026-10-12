/* Signal Intelligence for the 24/7 recorder (spec Modul A + B).
   Builds 5-minute USD buckets per signal from public endpoints and runs flow.js on them:
   - OKX Futures (OF): rubik taker-volume (CONTRACTS, USD) + rubik open-interest-volume (USD) + 5m candles + funding
   - OKX Spot (OS):    rubik taker-volume (SPOT, base coin -> USD) + 5m candles (no OI)
   - Binance Spot (BS): klines 5m (taker buy quote volume = buy, rest = sell) (no OI)
   Binance Futures is blocked from GitHub's US runners; those signals are handled live in the browser.
   Results are written into the journal (J.flow[id] = { d, fl, trk }) and merged into the day files. */
"use strict";
const FLOW = require("../flow.js");
FLOW.setConfig(require("../config/flow.json"));

module.exports = function createFlow({ getJSON, sleep, log, E, J, dateWIB }) {
  const cache = new Map();
  const cached = async (key, ttl, fn) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { at: Date.now(), v });
    return v;
  };
  const okx = async url => { const j = await getJSON("https://www.okx.com" + url, 2); await sleep(450); if (j.code !== "0") throw new Error(j.msg || "okx"); return j.data; };

  async function series(mk, coin) {
    return cached(`${mk}:${coin}`, 55e3, async () => {
      if (mk === "BS") {
        const k = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=5m&limit=60`, 2);
        return k.map(x => ({ t: +x[0], buy: +x[10], sell: +x[7] - +x[10], oi: null, close: +x[4], high: +x[2] }));
      }
      const inst = mk === "OF" ? `${coin}-USDT-SWAP` : `${coin}-USDT`;
      const cs = await okx(`/api/v5/market/candles?instId=${inst}&bar=5m&limit=60`);
      const px = new Map(cs.map(x => [+x[0], { close: +x[4], high: +x[2] }]));
      const tk = await okx(`/api/v5/rubik/stat/taker-volume?ccy=${coin}&instType=${mk === "OF" ? "CONTRACTS" : "SPOT"}&period=5m`);
      const oi = mk === "OF" ? new Map((await okx(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${coin}&period=5m`)).map(x => [+x[0], +x[1]])) : null;
      const out = [];
      for (const x of tk) {
        const t = +x[0], p = px.get(t);
        if (!p) continue;
        const mult = mk === "OF" ? 1 : p.close;           // contracts are already USD, spot is in base coin
        out.push({ t, buy: +x[2] * mult, sell: +x[1] * mult, oi: oi ? (oi.has(t) ? oi.get(t) : null) : null, close: p.close, high: p.high });
      }
      // OI snapshot for the bucket that just opened (needed to measure the last closed bucket)
      if (oi) { const last = Math.max(...oi.keys()); if (!out.find(b => b.t === last)) out.push({ t: last, buy: 0, sell: 0, oi: oi.get(last), close: (px.get(last) || {}).close || null, high: null, open: true }); }
      return out.filter(b => b.close != null).sort((a, b) => a.t - b.t);
    });
  }
  const funding = coin => cached(`fund:${coin}`, 5 * 60e3, async () => { const d = await okx(`/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`); return d[0] ? +d[0].fundingRate : null; });
  const liqShort = (coin, b0) => E.liqWin.filter(x => x.coin === coin && x.pos === "SHORT" && x.t >= b0 && x.t < b0 + FLOW.M5).reduce((a, x) => a + x.v, 0);

  // signals to process: this run's + recent ones from day files that are not complete yet
  const queue = new Map();
  const add = (s, d) => {
    if (s.kind === "liq" || !["OF", "OS", "BS"].includes(s.mk) || queue.has(s.id)) return;
    if (Date.now() - s.t > 4 * 3600e3) return;
    const u = J.flow[s.id];
    const fl = (u && u.fl) || s.fl, trk = Object.assign({}, s.trk || {}, (u && u.trk) || {});
    if (fl && (fl.label === "NETRAL" || !FLOW.TRACKED.includes(fl.label) || FLOW.cfg().checkpoints.every(c => trk[c]))) return;
    queue.set(s.id, { s, d: d || dateWIB(s.t) });
  };
  let busy = false;
  async function tick(onStatus) {
    if (busy) return;
    busy = true;
    const now = Date.now();
    try {
      for (const [id, q] of queue) {
        const s = q.s;
        if (now - s.t > 4 * 3600e3) { queue.delete(id); continue; }
        const rec = J.flow[id] || (J.flow[id] = { d: q.d, fl: s.fl || null, trk: Object.assign({}, s.trk || {}) });
        try {
          if (!rec.fl) {
            if (now < FLOW.bucketOf(s.t) + FLOW.M5 + 45e3) continue;
            const ser = await series(s.mk, s.coin);
            const fl = FLOW.classifyAt(ser, s.t, { funding: s.mk === "OF" ? await funding(s.coin).catch(() => null) : null, liqShort: s.mk === "OF" ? liqShort(s.coin, FLOW.bucketOf(s.t)) : 0, spot: s.mk !== "OF" }, now);
            if (!fl) continue;
            rec.fl = fl;
            if (!FLOW.TRACKED.includes(fl.label)) { queue.delete(id); continue; }
          }
          for (const cp of FLOW.cfg().checkpoints) {
            if (rec.trk[cp]) continue;
            if (now < FLOW.bucketOf(s.t + cp * 60e3) + FLOW.M5 + 45e3) break;
            const r = FLOW.checkpoint(await series(s.mk, s.coin), s.t, rec.fl, cp, now);
            if (!r) break;
            const prev = FLOW.cfg().checkpoints.map(c => rec.trk[c]).filter(Boolean).pop();
            rec.trk[cp] = r;
            if (prev && prev.st !== r.st && onStatus) await onStatus(s, rec, cp, prev.st, r.st);
          }
          if (FLOW.cfg().checkpoints.every(c => rec.trk[c])) queue.delete(id);
        } catch (e) { log("flow", s.coin, e.message); }
      }
    } finally { busy = false; }
  }
  // compact view of the last 3 hours for the browser (OKX labels it cannot compute itself)
  function live(items) {
    const cut = Date.now() - 3 * 3600e3, out = [];
    for (const s of items) {
      if (s.t < cut || s.kind === "liq") continue;
      const u = J.flow[s.id];
      if (!u || !u.fl) continue;
      out.push({ id: s.id, coin: s.coin, mk: s.mk, t: s.t, dir: s.dir, price: s.price, fl: u.fl, trk: u.trk });
    }
    return { updated: Date.now(), items: out };
  }
  return { add, tick, live, queue };
};
