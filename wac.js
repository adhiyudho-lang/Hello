/* WAC (Whale Accumulation Confirmation) engine for Adhi Whale Terminal.
   Pure functions shared by the browser (app.js) and the 24/7 recorder (recorder/record.cjs):
   indicators, BTC regime, WAC score (two weight profiles, coverage, confidence), spot rules
   (chase filter, confirmation, pattern A/B, zone, SL/TP, R:R, sizing), futures sizing, the signal
   lifecycle and pullback reminders. All thresholds come from config/wac.json.
   Volume spikes and taker flow are PROXIES for aggressive CEX buying, never proof of whale buying. */
(function (root) {
"use strict";
let C = null;
const setConfig = cfg => { C = cfg; };
const cfg = () => { if (!C) throw new Error("WAC config not loaded"); return C; };

const H = 3600e3, TF = { "1h": H, "4h": 4 * H, "1d": 24 * H };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const last = a => a[a.length - 1];

/* ---------- indicators ---------- */
function ema(v, n) { const a = 2 / (n + 1); let e = v[0]; return v.map(x => (e = x * a + e * (1 - a))); }
function atr(cs, n = 14) {
  const tr = cs.map((c, i) => i ? Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c)) : c.h - c.l);
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / Math.min(n, tr.length);
  const out = tr.map((x, i) => (i < n ? a : (a = (a * (n - 1) + x) / n)));
  return out;
}
function rsi(c, n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
// drop the still-forming candle: only closed candles count (no look-ahead)
function closed(cs, tf, now) { const ms = TF[tf]; return (cs || []).filter(c => c.t + ms <= now); }
function tech4h(cs) {
  if (!cs || cs.length < 30) return null;
  const cl = cs.map(c => c.c), e20 = ema(cl, 20), e50 = ema(cl, 50), a = atr(cs, 14), i = cs.length - 1;
  const n = cfg().confirm.volLookback, prev = cs.slice(Math.max(0, i - n), i);
  const avgVol = prev.reduce((s, c) => s + c.v, 0) / (prev.length || 1);
  const lb = cfg().patternA.lookback, prior = cs.slice(Math.max(0, i - lb), i);
  return {
    close: cl[i], open: cs[i].o, high: cs[i].h, low: cs[i].l, t: cs[i].t,
    ema20: e20[i], ema50: e50[i], atr: a[i], rsi: rsi(cl), relVol: avgVol ? cs[i].v / avgVol : null,
    res: Math.max(...prior.map(c => c.h)), // resistance = highest high of the previous N candles
    bodyMid: (cs[i].o + cs[i].c) / 2
  };
}

/* ---------- BTC regime (1D trend + 4h risk) ---------- */
function regime(btc1d, btc4h, now) {
  const R = cfg().regime;
  if (!btc1d || btc1d.length < 60) return { state: null, detail: "Data BTC harian kurang" };
  const cl = btc1d.map(c => c.c), e50 = ema(cl, 50), e200 = btc1d.length >= 200 ? ema(cl, 200) : null, i = cl.length - 1;
  const p = cl[i], slopeUp = e50[i] > e50[Math.max(0, i - R.slopeBars)];
  // risk-off: daily ATR% far above its 30-day median, or a sharp 24h drawdown
  const a = atr(btc1d, 14), atrPct = a.map((x, k) => x / cl[k]);
  const med = atrPct.slice(-31, -1).slice().sort((x, y) => x - y)[15] || atrPct[i];
  let dd24 = 0;
  if (btc4h && btc4h.length >= 6) { const w = btc4h.slice(-6); dd24 = last(w).c / Math.max(...w.map(c => c.h)) - 1; }
  const info = { price: p, ema50: e50[i], ema200: e200 ? e200[i] : null, atrPct: atrPct[i], atrMed: med, dd24, at: now };
  if (atrPct[i] > R.riskOffAtrMult * med || dd24 < -R.riskOffDd24) return { state: "RISK-OFF", detail: atrPct[i] > R.riskOffAtrMult * med ? `Volatilitas BTC ${(atrPct[i] * 100).toFixed(1)}% > ${R.riskOffAtrMult}× median` : `BTC turun ${(dd24 * 100).toFixed(1)}% dalam 24 jam`, ...info };
  const above = p > e50[i] && (!e200 || p > e200[i]), below = p < e50[i] && (!e200 || p < e200[i]);
  if (above && slopeUp) return { state: "BULLISH", detail: "BTC di atas EMA50 & EMA200, EMA50 naik", ...info };
  if (below) return { state: "BEARISH", detail: "BTC di bawah EMA50 & EMA200", ...info };
  return { state: "NEUTRAL", detail: "BTC di antara EMA50/EMA200 atau EMA50 belum naik", ...info };
}

/* ---------- WAC score ---------- */
const CLASS_TONE = { "STRONG ACCUMULATION": "up", "ACCUMULATION": "up", "WATCH": "swing", "DISTRIBUTION RISK": "down", "DISTRIBUTION": "down" };
function classify(score) { for (const [min, name] of cfg().classes) if (score >= min) return name; return "DISTRIBUTION"; }
// in: { coin, taker:{buy,sell}|null, dirUp, mult, t4 (tech4h), regime, etf:{score,fresh}|null, stale, spreadKnown }
function score(inp) {
  const isEtf = cfg().etfAssets.includes(inp.coin);
  const W = isEtf ? cfg().weights.etf : cfg().weights.nonEtf;
  const comps = {};
  // whale flow (proxy): taker buy share + volume multiple
  if (inp.taker && inp.taker.buy + inp.taker.sell > 0) {
    const share = inp.taker.buy / (inp.taker.buy + inp.taker.sell);
    comps.whale = { score: Math.round(clamp(50 + (share - 0.5) * 160 + Math.min(20, ((inp.mult || 1) - 1) * 2), 0, 100)), status: "ok", proxy: true, note: `Taker beli ${Math.round(share * 100)}% (proxy, bukan bukti whale)` };
  } else if (inp.dirUp != null) {
    comps.whale = { score: inp.dirUp ? 60 : 30, status: "ok", proxy: true, weak: true, note: "Arah dari gerak harga 1 menit (proxy lemah)" };
  } else comps.whale = { status: "na", note: "Data arus tidak tersedia" };
  // technical (4h, closed candles)
  const t = inp.t4;
  if (t) {
    let s = 0; const k = cfg().confirm;
    if (t.close > t.ema20) s += 25;
    if (t.ema20 > t.ema50) s += 15;
    if (t.relVol != null && t.relVol >= k.volMult) s += 20;
    if (t.rsi != null && t.rsi >= k.rsiLow && t.rsi <= k.rsiHigh) s += 15;
    if (!chaseOf(inp.chg24, t).length) s += 15;
    if (t.close > t.res) s += 10;
    comps.tech = { score: s, status: "ok", note: `Close ${t.close > t.ema20 ? ">" : "<"} EMA20, vol ${t.relVol ? t.relVol.toFixed(1) : "-"}×, RSI ${t.rsi ? t.rsi.toFixed(0) : "-"}` };
  } else comps.tech = { status: "na", note: "Candle 4h tidak tersedia" };
  // BTC regime
  const rs = inp.regime && inp.regime.state;
  comps.regime = rs ? { score: { BULLISH: 100, NEUTRAL: 60, BEARISH: 20, "RISK-OFF": 0 }[rs], status: "ok", note: rs } : { status: "na", note: "Rezim BTC tidak tersedia" };
  // ETF flow: only for ETF assets; "tidak berlaku" for others (not N/A)
  if (isEtf) comps.etf = inp.etf && inp.etf.fresh && inp.etf.score != null ? { score: inp.etf.score, status: "ok", note: inp.etf.note || "Arus ETF/ETP" } : { status: "na", note: inp.etf ? "Data ETF stale" : "Data ETF tidak tersedia" };
  let wsum = 0, acc = 0;
  for (const k in W) { const c = comps[k]; if (c && c.status === "ok") { wsum += W[k]; acc += W[k] * c.score; } }
  const coverage = Math.round(wsum);
  const sc = wsum ? Math.round(acc / wsum) : 0;
  let cls = classify(sc);
  // never STRONG on proxy or stale whale data
  if (cls === "STRONG ACCUMULATION" && (comps.whale.proxy || inp.stale)) cls = "ACCUMULATION";
  let conf = coverage - (comps.whale.proxy ? 15 : 0) - (comps.whale.weak ? 10 : 0) - (inp.spreadKnown ? 0 : 5);
  if (inp.stale) conf = 0;
  conf = clamp(Math.round(conf), 0, 100);
  return { score: sc, cls, tone: CLASS_TONE[cls], coverage, confidence: conf, confLabel: conf >= 75 ? "Tinggi" : conf >= 50 ? "Sedang" : "Rendah", weights: W, comps, profile: isEtf ? "ETF" : "Non-ETF" };
}

/* ---------- spot rules ---------- */
function chaseOf(chg24, t) {
  const k = cfg().chase, out = [];
  if (chg24 != null && chg24 > k.max24h) out.push(`Naik ${(chg24 * 100).toFixed(0)}% dalam 24 jam (> ${(k.max24h * 100).toFixed(0)}%)`);
  if (t) {
    if (t.close > t.ema20 * (1 + k.emaExt)) out.push(`Close 4h ${((t.close / t.ema20 - 1) * 100).toFixed(0)}% di atas EMA20 (> ${(k.emaExt * 100).toFixed(0)}%)`);
    else if (t.close > t.ema20 + k.atrExt * t.atr) out.push(`Close 4h > EMA20 + ${k.atrExt}×ATR`);
    if (t.rsi != null && t.rsi > k.rsiMax) out.push(`RSI 4h ${t.rsi.toFixed(0)} > ${k.rsiMax}`);
  }
  return out;
}
function zoneOf(t) {
  const z = cfg().zone;
  const b = { lo: Math.min(t.bodyMid, t.ema20), hi: Math.max(t.bodyMid, t.ema20), basis: "Tengah body candle pemicu – EMA20(4h)" };
  if (t.close > t.res) {
    const a = { lo: t.res, hi: t.res + z.atrAbove * t.atr, basis: "Level breakout + 0,5×ATR" };
    return a.hi >= b.hi ? Object.assign(a, { pattern: "A" }) : Object.assign(b, { pattern: "B" });
  }
  return Object.assign(b, { pattern: "B" });
}
function plan(entry, atrV) {
  const r = cfg().risk;
  const slDist = Math.max(r.slAtr * atrV, r.slMinPct * entry);
  const sl = entry - slDist, slPct = slDist / entry;
  const tp1 = entry * (1 + r.tp1), tp2 = entry * (1 + r.tp2);
  const rr = (tp2 - entry) / slDist;
  return { entry, sl, slPct, tp1, tp2, rr, rejects: [...(slPct > r.slMaxPct ? [`SL terlalu jauh (${(slPct * 100).toFixed(1)}% > ${(r.slMaxPct * 100).toFixed(0)}%)`] : []), ...(rr < r.minRR ? [`R:R ${rr.toFixed(2)} < ${r.minRR}`] : [])] };
}
function sizing(p, opts) {
  const r = cfg().risk, eq = opts.equity || cfg().equityDefault;
  const riskPct = clamp(opts.riskPct || r.riskPct, r.riskMin, r.riskMax) / 100;
  const mult = opts.regime === "BEARISH" ? cfg().regime.bearSizeMult : 1;
  const risk = eq * riskPct * mult;
  let notional = risk / p.slPct;
  const cap = eq * r.maxPosPct / 100, capped = notional > cap;
  if (capped) notional = cap;
  return { equity: eq, riskPct: riskPct * 100 * mult, risk: capped ? notional * p.slPct : risk, notional, capped, bearHalf: mult < 1 };
}
// in: score inputs + { now, price, priceAt, chg24, vol24, spreadPct, c4h (closed), regime, equity, riskPct, openRisk, openCount }
function evalSpot(inp) {
  const now = inp.now, k = cfg(), filters = [], rejects = [];
  const f = (label, ok, detail, hard) => { filters.push({ label, ok: !!ok, detail }); if (!ok && hard) rejects.push(label + (detail ? ": " + detail : "")); };
  const t = inp.t4 || tech4h(inp.c4h);
  const stale = inp.priceAt != null && now - inp.priceAt > k.staleMinutes.price * 60e3;
  const sc = score(Object.assign({}, inp, { t4: t, stale }));
  const liquid = (inp.vol24 || 0) >= k.liquidity.minVol24;
  const buyDominant = inp.taker && inp.taker.buy + inp.taker.sell > 0 ? inp.taker.buy > inp.taker.sell : inp.dirUp === true;
  f("Likuid (volume 24j ≥ $" + (k.liquidity.minVol24 / 1e6) + " jt)", liquid, inp.vol24 ? "$" + (inp.vol24 / 1e6).toFixed(1) + " jt" : "N/A", true);
  f("Spread", inp.spreadPct == null || inp.spreadPct <= k.liquidity.maxSpreadPct, inp.spreadPct == null ? "N/A (tidak dicek)" : inp.spreadPct.toFixed(2) + "%", inp.spreadPct != null);
  f("Arus taker didominasi beli (proxy)", buyDominant, inp.taker ? `beli ${Math.round(inp.taker.buy / 1e3)} rb vs jual ${Math.round(inp.taker.sell / 1e3)} rb` : "dari gerak harga", false);
  const base = { score: sc, filters, rejects, t4: t, stale };
  if (!liquid || !buyDominant) return Object.assign(base, { status: "DETECTED", verdict: "HINDARI", why: !liquid ? "Coin kurang likuid untuk aturan WAC." : "Arus taker tidak didominasi beli." });
  if (!t) { rejects.push("Candle 4h tidak tersedia"); return Object.assign(base, { status: "DETECTED", verdict: "HINDARI", why: "Data teknikal 4h tidak tersedia." }); }
  const zone = zoneOf(t), entry = (zone.lo + zone.hi) / 2, p = plan(entry, t.atr);
  // a zone reaching below the invalidation is incoherent: keep its lower edge above the SL
  if (zone.lo <= p.sl) { zone.lo = p.sl + 0.25 * (entry - p.sl); zone.basis += " (batas bawah dipotong di atas invalidasi)"; }
  rejects.push(...p.rejects);
  const chase = chaseOf(inp.chg24, t);
  f("Tidak overextended (filter jangan kejar)", !chase.length, chase.join("; ") || "lolos", false);
  const rs = inp.regime && inp.regime.state;
  const thr = k.entryScore + (rs === "BEARISH" ? k.regime.bearScoreAdd : 0);
  const conf = [
    ["Close 4h > EMA20", t.close > t.ema20, `${t.close.toPrecision(5)} vs ${t.ema20.toPrecision(5)}`],
    [`Volume 4h > ${k.confirm.volMult}× rata-rata ${k.confirm.volLookback}`, t.relVol != null && t.relVol > k.confirm.volMult, t.relVol ? t.relVol.toFixed(2) + "×" : "N/A"],
    ["Rezim BTC bukan BEARISH/RISK-OFF", rs && rs !== "BEARISH" && rs !== "RISK-OFF", rs || "N/A"],
    ["Arus taker beli positif", buyDominant, ""]
  ];
  for (const [l, ok, d] of conf) f(l, ok, d, false);
  const confirmed = conf.every(c => c[1]);
  f(`Skor ≥ ${thr}${rs === "BEARISH" ? " (BEARISH +10)" : ""}`, sc.score >= thr, String(sc.score), false);
  f(`Coverage ≥ ${k.minCoverage}%`, sc.coverage >= k.minCoverage, sc.coverage + "%", true);
  if (stale) rejects.push("Data harga stale");
  if (rs === "RISK-OFF") rejects.push("Rezim RISK-OFF: tidak ada entry baru");
  const r = k.risk;
  if (inp.openCount != null && inp.openCount >= r.maxOpen) rejects.push(`Sudah ${inp.openCount} posisi terbuka (maks ${r.maxOpen})`);
  if (inp.openRisk != null && inp.openRisk + r.riskPct > r.portfolioRiskPct) rejects.push(`Risiko portofolio akan > ${r.portfolioRiskPct}%`);
  const out = Object.assign(base, { zone, pattern: zone.pattern, plan: p, chase, confirmed, threshold: thr, expiresAt: now + r.expiryH * H, inval: p.sl });
  out.sizing = sizing(p, { equity: inp.equity, riskPct: inp.riskPct, regime: rs });
  // structural rejects: not tradable at all -> stays DETECTED (unnumbered, no reminders)
  const fatal = rejects.find(x => /Likuid|Coverage|RISK-OFF|stale/.test(x));
  if (fatal) return Object.assign(out, { status: "DETECTED", verdict: "HINDARI", why: fatal });
  // volatility rejects (SL > 9%, R:R < 2) can clear later: watch the zone, but ENTRY_READY re-checks the plan
  const volRej = p.rejects[0];
  if (chase.length) return Object.assign(out, { status: "WATCH", verdict: "TUNGGU PULLBACK", why: "Harga sudah lari: " + chase[0] + ". Tunggu pullback ke zona." + (volRej ? ` Saat ini ${volRej}: entry ditolak sampai volatilitas turun.` : "") });
  if (volRej) return Object.assign(out, { status: "WATCH", verdict: "HINDARI", why: volRej + ". Dipantau; entry hanya jika volatilitas turun." });
  if (confirmed && sc.score >= thr && !rejects.length && sc.coverage >= k.minCoverage) {
    const inZone = inp.price != null && inp.price >= zone.lo && inp.price <= zone.hi * (1 + r.entryTolerance);
    if (zone.pattern === "A" && inZone) return Object.assign(out, { status: "ENTRY_READY", verdict: "BELI SPOT", why: "Breakout 4h terkonfirmasi dan harga di zona entry." });
    return Object.assign(out, { status: "CONFIRMED", verdict: "TUNGGU PULLBACK", why: zone.pattern === "A" ? "Breakout terkonfirmasi, tunggu harga kembali ke zona." : "Konfirmasi teknikal lolos, tunggu pullback ke zona lalu candle hijau." });
  }
  return Object.assign(out, { status: "WATCH", verdict: "TUNGGU PULLBACK", why: rejects[0] || "Konfirmasi teknikal 4h belum lengkap." });
}

/* ---------- futures (secondary) ---------- */
function futures(spot, opts) {
  const k = cfg().futures, eq = opts.equity || cfg().equityDefault, rp = clamp(opts.riskPct || cfg().risk.riskPct, cfg().risk.riskMin, cfg().risk.riskMax) / 100;
  const risk = eq * rp, mm = `Money management: risiko maks ${(rp * 100).toFixed(1).replace(".0", "")}% equity per posisi ($${risk.toFixed(0)}). Leverage hanya mengecilkan margin, tidak mengurangi risiko. Pasang SL di exchange sebelum entry.`;
  const funding = opts.funding == null ? "N/A" : (opts.funding * 100).toFixed(4) + "%";
  if (!spot || !spot.plan || (spot.status !== "ENTRY_READY" && spot.status !== "POSITION_OPEN")) {
    // SHORT only on DISTRIBUTION + non-bullish regime + bearish technical confirmation
    const t = spot && spot.t4, rs = opts.regime;
    if (spot && spot.score && spot.score.score < 35 && rs && rs !== "BULLISH" && t && t.close < t.ema20 && t.relVol > cfg().confirm.volMult && opts.takerSell) {
      const slDist = Math.max(cfg().risk.slAtr * t.atr, cfg().risk.slMinPct * t.close), slPct = slDist / t.close;
      return Object.assign(levPlan(slPct, risk, k), { verdict: "SHORT (risiko tinggi)", side: "SHORT", entry: t.close, sl: t.close + slDist, mm, funding });
    }
    return { verdict: "Jangan LONG", side: null, why: spot && spot.verdict === "HINDARI" ? "Spot HINDARI, futures ikut tidak." : "Futures LONG hanya saat spot ENTRY READY.", mm, funding };
  }
  return Object.assign(levPlan(spot.plan.slPct, risk, k), { verdict: "LONG", side: "LONG", entry: spot.plan.entry, sl: spot.plan.sl, mm, funding });
}
function levPlan(slPct, risk, k) {
  const maxLev = Math.max(1, Math.min(k.hardCapLev, Math.floor(k.lossAtSlOfMargin / slPct)));
  let lev = maxLev;
  // keep liquidation (~1/lev - mmr) at least liqBuffer × SL distance away
  while (lev > 1 && (1 / lev - k.mmr) < k.liqBuffer * slPct) lev--;
  const notional = risk / slPct, margin = notional / lev;
  return { maxLev, lev, notional, margin, risk, slPct, liqDist: 1 / lev - k.mmr };
}

/* ---------- lifecycle ---------- */
const ACTIVE = ["WATCH", "CONFIRMED", "ENTRY_READY", "POSITION_OPEN", "TAKE_PROFIT_PARTIAL", "EXIT_WARNING"];
const PRE = ["WATCH", "CONFIRMED", "ENTRY_READY"];
const STATUS_ID = { DETECTED: "Terdeteksi", WATCH: "Watch", CONFIRMED: "Terkonfirmasi", ENTRY_READY: "Entry ready", POSITION_OPEN: "Posisi (virtual)", TAKE_PROFIT_PARTIAL: "TP1 tercapai", EXIT_WARNING: "Peringatan exit", EXIT_CONFIRMED: "Selesai", ENTRY_INVALIDATED: "Batal", EXPIRED: "Kedaluwarsa" };
function wibDate(t) { return new Date(t + 7 * H).toISOString().slice(0, 10).replace(/-/g, ""); }

// create a stored signal from a WATCH+ evaluation; state = { seq, daily:{}, signals:[] }
function createSignal(state, det, ev, now) {
  const day = wibDate(det.t);
  state.seq = (state.seq || 0) + 1;
  const dn = (state.daily[day + det.coin] = (state.daily[day + det.coin] || 0) + 1);
  const sig = {
    no: state.seq, id: `WAC-${det.coin}-${day}-${String(dn).padStart(3, "0")}`, coin: det.coin, mk: det.mk, t: det.t,
    src: { kind: det.kind, value: det.value, mult: det.mult, how: det.how, price: det.price, chg24: det.chg24 },
    status: ev.status, verdict: ev.verdict, why: ev.why, pattern: ev.pattern, zone: { lo: ev.zone.lo, hi: ev.zone.hi, basis: ev.zone.basis },
    inval: ev.inval, plan: { entry: ev.plan.entry, sl: ev.plan.sl, slPct: ev.plan.slPct, tp1: ev.plan.tp1, tp2: ev.plan.tp2, rr: ev.plan.rr },
    atr: ev.t4.atr, score: ev.score.score, cls: ev.score.cls, coverage: ev.score.coverage, confidence: ev.score.confidence,
    regime: ev.score.comps.regime.note, expiresAt: ev.expiresAt, touched: false, events: [],
    // score breakdown at detection, so "Kenapa skor X?" can be answered later
    breakdown: {
      profile: ev.score.profile, weights: ev.score.weights, confLabel: ev.score.confLabel,
      comps: Object.fromEntries(Object.entries(ev.score.comps || {}).map(([k, c]) => [k, { score: c.score, status: c.status, note: c.note }])),
      filters: (ev.filters || []).map(f => ({ label: f.label, ok: f.ok, detail: f.detail }))
    }
  };
  addEvent(sig, now, "status", ev.status, `${STATUS_ID[ev.status]}: ${ev.why}`);
  state.signals.push(sig);
  return sig;
}
function addEvent(sig, t, type, status, text) { sig.events.push({ t, type, status, text }); if (sig.events.length > 60) sig.events.splice(1, 1); }
function setStatus(sig, t, status, text, extra) { if (sig.status === status) return false; sig.status = status; Object.assign(sig, extra || {}); addEvent(sig, t, "status", status, text); return true; }
function activeFor(state, coin) { return state.signals.find(s => s.coin === coin && ACTIVE.includes(s.status)); }

// one lifecycle step: obs = { now, price, c1h (closed), c4h (closed), regime }
// returns list of {type, text} events emitted (status changes + reminders)
function step(sig, obs) {
  const out = [], now = obs.now, r = cfg().risk, rm = cfg().reminders, p = obs.price;
  const emit = (type, status, text) => { out.push({ type, status, text }); if (type === "reminder") addEvent(sig, now, "reminder", status, text); };
  const ch = (status, text, extra) => { if (setStatus(sig, now, status, text, extra)) out.push({ type: "status", status, text }); };
  const rs = obs.regime && obs.regime.state;
  if (PRE.includes(sig.status)) {
    if (now > sig.expiresAt) { ch("EXPIRED", `Tidak ada konfirmasi dalam ${r.expiryH} jam`); return out; }
    const c1 = obs.c1h && last(obs.c1h);
    if (c1 && c1.c < sig.inval) { ch("ENTRY_INVALIDATED", `Candle 1h close ${c1.c.toPrecision(5)} di bawah invalidasi ${sig.inval.toPrecision(5)}`); return out; }
    if (rs === "BEARISH" || rs === "RISK-OFF") { ch("ENTRY_INVALIDATED", `Rezim BTC berubah menjadi ${rs}`); return out; }
    if (p != null) {
      const atr1h = obs.c1h && obs.c1h.length > 15 ? last(atr(obs.c1h, 14)) : sig.atr / 2;
      const near = p <= sig.zone.hi + rm.nearAtr1h * atr1h || p <= sig.zone.hi * (1 + rm.nearPct);
      const inZone = p >= sig.zone.lo && p <= sig.zone.hi;
      if (inZone) { sig.touched = true; if (!sig.remInZone) { sig.remInZone = now; emit("reminder", "IN_ZONE", "Harga masuk zona entry"); } }
      else if (near && !sig.remNear && !sig.touched && now - sig.events[0].t >= rm.cooldownMin * 60e3) { sig.remNear = now; emit("reminder", "NEAR_ZONE", "Harga mendekati zona entry"); }
      if (p > sig.zone.hi * 1.03) { sig.remNear = 0; sig.remInZone = 0; } // left the area: allow a fresh reminder next visit
    }
    // pattern B confirmation: price visited the zone, then a closed green 1h/4h candle back above zone low
    // with the latest red candle's volume below the one before it (selling dries up)
    if (sig.status !== "ENTRY_READY" && sig.touched && obs.c1h && obs.c1h.length > 3) {
      const cs = obs.c1h, c = last(cs);
      const reds = cs.slice(-8, -1).filter(x => x.c < x.o);
      const sellDown = reds.length < 2 || last(reds).v < reds[reds.length - 2].v;
      const pl = plan(c.c, obs.t4 ? obs.t4.atr : sig.atr);
      if (c.t > sig.t && c.c > c.o && c.c >= sig.zone.lo && sellDown && rs !== "BEARISH" && rs !== "RISK-OFF" && pl.rejects.length) {
        if (sig.lastRej !== c.t) { sig.lastRej = c.t; addEvent(sig, now, "note", sig.status, `Konfirmasi candle ada, tapi ${pl.rejects[0]}: entry ditolak`); }
      } else if (c.t > sig.t && c.c > c.o && c.c >= sig.zone.lo && sellDown && rs !== "BEARISH" && rs !== "RISK-OFF") {
        ch("ENTRY_READY", `Candle 1h close hijau ${c.c.toPrecision(5)} kembali di atas zona, volume jual menurun`, { plan: { entry: pl.entry, sl: pl.sl, slPct: pl.slPct, tp1: pl.tp1, tp2: pl.tp2, rr: pl.rr }, inval: Math.min(sig.inval, pl.sl), verdict: "BELI SPOT" });
      } else if (sig.status === "WATCH" && obs.t4 && obs.t4.close > obs.t4.ema20 && obs.t4.relVol > cfg().confirm.volMult) {
        ch("CONFIRMED", "Konfirmasi teknikal 4h lolos, menunggu candle hijau di zona");
      }
    }
    // virtual fill on the next observation after ENTRY_READY, only if price is still near the zone
    if (sig.status === "ENTRY_READY" && p != null && sig.readyAt !== now) {
      if (!sig.readyAt) { sig.readyAt = now; return out; }
      if (p <= sig.zone.hi * (1 + r.entryTolerance) && p >= sig.inval) {
        const slDist = Math.max(r.slAtr * sig.atr, r.slMinPct * p);
        ch("POSITION_OPEN", `Posisi virtual dibuka di ${p.toPrecision(5)}`, { pos: { entry: p, sl: p - slDist, tp1: p * (1 + r.tp1), tp2: p * (1 + r.tp2), openAt: now, half: false } });
      }
    }
    return out;
  }
  const pos = sig.pos;
  if (!pos || p == null) return out;
  const fee = cfg().fees.side * 2;
  const finish = (exitPx, text) => {
    const ret = pos.half ? 0.5 * (pos.tp1 / pos.entry - 1) + 0.5 * (exitPx / pos.entry - 1) : exitPx / pos.entry - 1;
    ch("EXIT_CONFIRMED", text, { result: { exit: exitPx, ret: ret - fee, at: now, regime: sig.regime } });
  };
  if (sig.status === "POSITION_OPEN" || sig.status === "EXIT_WARNING") {
    if (p <= pos.sl) return finish(pos.sl, "Stop loss tersentuh"), out;
    if (p >= pos.tp1) { pos.half = true; pos.sl = pos.entry; ch("TAKE_PROFIT_PARTIAL", `TP1 +${(r.tp1 * 100).toFixed(0)}% tercapai: jual 50%, SL pindah ke entry`); return out; }
    if (sig.status === "POSITION_OPEN" && now - pos.openAt > r.timeStopH * H) { ch("EXIT_WARNING", `${r.timeStopH} jam tanpa TP1: siapkan exit`); return out; }
    if (sig.status === "EXIT_WARNING" && now - pos.openAt > (r.timeStopH + r.exitGraceH) * H) finish(p, "Time stop: posisi ditutup");
    return out;
  }
  if (sig.status === "TAKE_PROFIT_PARTIAL") {
    if (p >= pos.tp2) finish(pos.tp2, `TP2 +${(r.tp2 * 100).toFixed(0)}% tercapai`);
    else if (p <= pos.sl) finish(pos.sl, "Sisa posisi kena SL di entry (break-even)");
    else if (now - pos.openAt > r.timeStopH * H) finish(p, "Time stop: sisa posisi ditutup");
  }
  return out;
}

/* ---------- ETF / ETP component (BTC, ETH, SOL) from data/etf.json daily flows ---------- */
// same model as the ETF Brief tab: 30d/7d net flow vs 60d average, bonus for inflow into falling price
function etfScore(days, now) {
  if (!days || days.length < 5) return null;
  const d = days, lastD = d[d.length - 1], t0 = Date.parse(lastD.date);
  const fresh = now - t0 <= cfg().staleMinutes.etfDays * 24 * H;
  const sum = n => d.filter(x => Date.parse(x.date) > t0 - n * 24 * H).reduce((s, x) => s + x.flow, 0);
  const priceAgo = n => { let p = d[0].price; for (const x of d) if (Date.parse(x.date) <= t0 - n * 24 * H) p = x.price; return p; };
  const f7 = sum(7), f30 = sum(30), p30 = lastD.price / priceAgo(30) - 1;
  const recent = d.slice(-60), avg = recent.reduce((s, x) => s + Math.abs(x.flow), 0) / recent.length || 1;
  let sc = 50 + 25 * clamp(f30 / (avg * 20), -1, 1) + 15 * clamp(f7 / (avg * 5), -1, 1);
  if (f30 > 0 && p30 <= 0) sc += 10;
  if (f30 < 0 && p30 >= 0) sc -= 10;
  if (p30 < -0.1) sc += 5;
  return { score: Math.round(clamp(sc, 1, 100)), fresh, note: `Arus ETF 30 hari ${f30 >= 0 ? "+" : "−"}$${Math.abs(f30 / 1e6).toFixed(0)} jt (s/d ${lastD.date})` };
}

/* ---------- notification text ---------- */
function fmtPx(v) { if (v == null || !isFinite(v)) return "--"; return "$" + (v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : v >= 1 ? v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00") : v.toPrecision(4)); }
function notifText(sig, kind, ctx) {
  const pair = `${sig.coin}/USDT`, tag = `Sinyal #${sig.no}`;
  const origin = `Sinyal asal: ${ctx.when(sig.t)} · ${ctx.srcText(sig)}`;
  const lines = {
    WATCH: [`👀 WATCH — ${tag} ${pair}`, origin, `Zona entry: ${fmtPx(sig.zone.lo)}–${fmtPx(sig.zone.hi)} · Invalidasi: ${fmtPx(sig.inval)}`, `Belum beli. ${sig.why}`],
    NEAR_ZONE: [`⏰ PULLBACK MENDEKATI ZONA — ${tag} ${pair}`, origin, `Harga sekarang: ${fmtPx(ctx.price)} · Zona entry: ${fmtPx(sig.zone.lo)}–${fmtPx(sig.zone.hi)} · Invalidasi: ${fmtPx(sig.inval)}`],
    IN_ZONE: [`⏰ PULLBACK — ${tag} ${pair}`, origin, `Harga sekarang: ${fmtPx(ctx.price)} · Zona entry: ${fmtPx(sig.zone.lo)}–${fmtPx(sig.zone.hi)} · Invalidasi: ${fmtPx(sig.inval)}`, `Belum ENTRY: tunggu candle 1h/4h close hijau di atas ${fmtPx(sig.zone.lo)}`],
    ENTRY_READY: [`✅ ENTRY READY — ${tag} ${pair}`, origin, `Entry ${fmtPx(sig.plan.entry)} · SL ${fmtPx(sig.plan.sl)} · TP1 ${fmtPx(sig.plan.tp1)} · TP2 ${fmtPx(sig.plan.tp2)} · R:R ${sig.plan.rr.toFixed(1)}`, ctx.sizeText || "", ctx.futText || ""],
    ENTRY_INVALIDATED: [`❌ BATAL — ${tag} ${pair}`, origin, (last(sig.events) || {}).text || "Invalidasi tersentuh"],
    EXPIRED: [`⌛ KEDALUWARSA — ${tag} ${pair}`, origin, `Tidak ada konfirmasi dalam ${cfg().risk.expiryH} jam.`],
    TAKE_PROFIT_PARTIAL: [`💰 TP1 — ${tag} ${pair}`, "Jual 50%, pindahkan SL ke entry."],
    EXIT_WARNING: [`⚠️ EXIT WARNING — ${tag} ${pair}`, `${cfg().risk.timeStopH} jam tanpa TP1. Siapkan exit.`],
    EXIT_CONFIRMED: [`🏁 SELESAI — ${tag} ${pair}`, (last(sig.events) || {}).text || ""]
  }[kind] || [`${tag} ${pair}: ${kind}`];
  return { title: lines[0], body: lines.slice(1).filter(Boolean).join("\n") };
}

// sizing + futures lines for the ENTRY READY notification
function entryTexts(sig, opts) {
  const pl = sig.plan, eq = opts.equity || cfg().equityDefault;
  const sz = sizing(pl, { equity: eq, riskPct: opts.riskPct, regime: opts.regime });
  const f = futures({ status: "ENTRY_READY", plan: pl }, { equity: eq, riskPct: opts.riskPct, funding: opts.funding });
  const usd = v => "$" + Math.round(v).toLocaleString("en-US");
  return {
    sizeText: `SPOT: beli bertahap 40/30/30, total ${usd(sz.notional)} (risiko ${usd(sz.risk)} = ${sz.riskPct.toFixed(1)}% equity ${usd(eq)}${opts.equity ? "" : ", equity contoh"})${sz.bearHalf ? " · rezim BEARISH: ukuran ½" : ""}`,
    futText: `FUTURES (sekunder): LONG maks ${f.lev}x · margin ${usd(f.margin)} · notional ${usd(f.notional)} · funding ${f.funding}\n⚠️ ${f.mm}`
  };
}

const api = { entryTexts, setConfig, cfg, etfScore, ema, atr, rsi, closed, tech4h, regime, score, classify, chaseOf, zoneOf, plan, sizing, evalSpot, futures, levPlan, createSignal, addEvent, setStatus, activeFor, step, notifText, fmtPx, ACTIVE, PRE, STATUS_ID, CLASS_TONE, TF };
if (typeof module === "object" && module.exports) module.exports = api;
else root.WAC = api;
})(typeof self !== "undefined" ? self : this);
