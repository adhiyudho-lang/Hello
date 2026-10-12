/* Signal Intelligence (spec Modul A + B) for Adhi Whale Terminal. Pure functions shared by the browser
   (app.js) and the 24/7 recorder (recorder/flow.cjs):
   - classify(): who is moving? taker ratio x open-interest change -> LONG_BARU / SHORT_COVER / SHORT_BARU /
     LONG_EXIT / NETRAL (spot: SPOT_BELI / SPOT_JUAL), plus context tags (funding, bounce zone, short liqs).
   - checkpoint(): still in? price, OI and CVD at T+5/15/60 -> MASIH_DI_DALAM / SUDAH_KELUAR /
     TIDAK_ADA_FT / FOLLOW_THROUGH.
   Inputs are 5-minute buckets normalised to USD by the caller: { t (bucket start), buy, sell, oi?, close, high }.
   Taker flow and OI are market-wide aggregates: they describe who traded, never who a single wallet is. */
(function (root) {
"use strict";
let C = null;
const setConfig = c => { C = c; };
const cfg = () => { if (!C) throw new Error("FLOW config not loaded"); return C; };
const M5 = 5 * 60e3;
const bucketOf = t => Math.floor(t / M5) * M5;

const LABELS = {
  LONG_BARU: { icon: "🟢", tone: "buy", text: "Long baru", desc: "Posisi long baru dibuka (taker beli + OI naik): akumulasi agresif" },
  SHORT_COVER: { icon: "🟡", tone: "neu", text: "Short cover", desc: "Short ditutup/dilikuidasi (taker beli + OI turun): bounce, bukan akumulasi" },
  SHORT_BARU: { icon: "🔴", tone: "sell", text: "Short baru", desc: "Short baru dibuka (taker jual + OI naik): tekanan turun" },
  LONG_EXIT: { icon: "🟠", tone: "warn", text: "Long keluar", desc: "Long keluar/terlikuidasi (taker jual + OI turun): distribusi" },
  NETRAL: { icon: "⚪", tone: "dim", text: "Netral", desc: "Arus atau perubahan OI tidak cukup jelas" },
  SPOT_BELI: { icon: "🟢", tone: "buy", text: "Spot: taker beli", desc: "Spot: taker beli dominan (tanpa OI)" },
  SPOT_JUAL: { icon: "🔴", tone: "sell", text: "Spot: taker jual", desc: "Spot: taker jual dominan (tanpa OI)" }
};
const STATUS = {
  MASIH_DI_DALAM: { icon: "✅", tone: "buy", text: "Masih di dalam" },
  SUDAH_KELUAR: { icon: "❌", tone: "sell", text: "Sudah keluar" },
  TIDAK_ADA_FT: { icon: "⏸️", tone: "dim", text: "Tidak ada follow-through" },
  FOLLOW_THROUGH: { icon: "🚀", tone: "buy", text: "Follow-through" }
};
const TAGS = {
  CROWDED_LONG: "Funding tinggi: long ramai, bobot diturunkan",
  SQUEEZE_POTENSIAL: "Funding negatif + short cover: potensi short squeeze",
  BOUNCE_ZONE: "Muncul setelah turun tajam: kemungkinan pantulan",
  LIQ_SHORT: "Likuidasi short besar: dipaksa jadi short cover"
};

/* ---------- Modul A: classification of the signal window ---------- */
// in: { ratio (buy/sell), oiPct (fraction, null for spot), funding (fraction|null), liqShort (USD), buy (USD), drop3h (fraction, <=0) }
function classify(x) {
  const k = cfg(), tags = [];
  const buyDom = x.ratio != null && x.ratio > k.buyRatio, sellDom = x.ratio != null && x.ratio < k.sellRatio;
  let label;
  if (x.oiPct == null) label = buyDom ? "SPOT_BELI" : sellDom ? "SPOT_JUAL" : "NETRAL";
  else if (buyDom && x.oiPct > k.oiPct) label = "LONG_BARU";
  else if (buyDom && x.oiPct < -k.oiPct) label = "SHORT_COVER";
  else if (sellDom && x.oiPct > k.oiPct) label = "SHORT_BARU";
  else if (sellDom && x.oiPct < -k.oiPct) label = "LONG_EXIT";
  else label = "NETRAL";
  // A3: short liquidations > 30% of taker buy in the same window -> it is a short cover
  if (x.oiPct != null && x.liqShort > 0 && x.buy > 0 && x.liqShort > k.liqShortShare * x.buy && label !== "SHORT_COVER") { label = "SHORT_COVER"; tags.push("LIQ_SHORT"); }
  let weight = k.weights[label] || 0;
  if (label === "LONG_BARU" && x.funding != null && x.funding > k.fundingHigh) { weight = Math.max(0, weight - 1); tags.push("CROWDED_LONG"); }
  if (label === "SHORT_COVER" && x.funding != null && x.funding < k.fundingLow) tags.push("SQUEEZE_POTENSIAL");
  if ((buyDom || ["LONG_BARU", "SHORT_COVER", "SPOT_BELI"].includes(label)) && x.drop3h != null && x.drop3h < -k.bounceDrop) tags.push("BOUNCE_ZONE");
  return { label, weight, tags, side: ["LONG_BARU", "SHORT_COVER", "SPOT_BELI"].includes(label) ? 1 : ["SHORT_BARU", "LONG_EXIT", "SPOT_JUAL"].includes(label) ? -1 : (x.ratio >= 1 ? 1 : -1) };
}

// classify from 5m buckets: the bucket containing the signal vs the one before it
// series: sorted array of buckets; returns null while the signal bucket is still open
function classifyAt(series, t, extra, now) {
  const b0 = bucketOf(t);
  if (now < b0 + M5 + 30e3) return null;
  const at = ts => series.find(b => b.t === ts);
  const cur = at(b0), next = at(b0 + M5), prev = at(b0 - M5);
  if (!cur) return null;
  // OI snapshot at bucket start: change across the signal bucket = OI(next start) vs OI(this start)
  const oiA = cur.oi, oiB = next && next.oi != null ? next.oi : null;
  const oiPct = oiA != null && oiB != null && oiA > 0 ? oiB / oiA - 1 : null;
  const ratio = cur.sell > 0 ? cur.buy / cur.sell : cur.buy > 0 ? 9.99 : null;
  const look = series.filter(b => b.t <= b0 && b.t > b0 - cfg().bounceHours * 3600e3);
  // normal taker volume per bucket (6 buckets before the signal) so bursts are measured above normal
  const before = series.filter(b => b.t < b0 && b.t >= b0 - 6 * M5);
  const norm = { buy: before.length ? before.reduce((a, b) => a + b.buy, 0) / before.length : 0, sell: before.length ? before.reduce((a, b) => a + b.sell, 0) / before.length : 0 };
  const hi = look.length ? Math.max(...look.map(b => b.high || b.close)) : null;
  const drop3h = hi ? cur.close / hi - 1 : null;
  const dPrice = prev && prev.close ? cur.close / prev.close - 1 : null;
  const isSpot = !!extra.spot;
  // futures: wait for the next OI snapshot; after 20 minutes without OI the window is NETRAL (OI N/A)
  if (!isSpot && oiPct == null && now < b0 + 20 * 60e3) return null;
  const c = classify({ ratio, oiPct: isSpot ? null : oiPct == null ? 0 : oiPct, funding: extra.funding, liqShort: extra.liqShort || 0, buy: cur.buy, drop3h });
  if (!isSpot && oiPct == null) c.oiNA = true;
  return Object.assign(c, {
    at: now, ratio: ratio == null ? null : +ratio.toFixed(2), oiPct: oiPct == null ? null : +oiPct.toFixed(5), dPrice: dPrice == null ? null : +dPrice.toFixed(5),
    funding: extra.funding == null ? null : extra.funding, liqShort: Math.round(extra.liqShort || 0), buy: Math.round(cur.buy), sell: Math.round(cur.sell),
    drop3h: drop3h == null ? null : +drop3h.toFixed(4), spot: !!isSpot,
    base: { price: cur.close, oi: oiB, oiUp: oiA != null && oiB != null ? oiB - oiA : null, buy: cur.buy, sell: cur.sell, b0, avgBuy: norm.buy, avgSell: norm.sell }
  });
}

/* ---------- Modul B: post-signal checkpoints ---------- */
// m: { dp (price change, signed), doi (OI change since baseline, null for spot), cvd (USD, since signal), maxBurst (USD, biggest
// opposite-side bucket), oiGiveBack (fraction of the initial OI increase given back) }; side: +1 buyers, -1 sellers
function statusOf(m, base, side) {
  const k = cfg(), s = side || 1, dp = m.dp * s, cvd = m.cvd * s;
  // initial aggressive size above normal flow (falls back to the raw size without a baseline)
  const raw = s > 0 ? base.buy : base.sell, norm = s > 0 ? base.avgBuy : base.avgSell;
  const size = norm != null ? Math.max(raw - norm, 0.2 * raw) : raw;
  const exit = size > 0 && m.maxBurst >= k.exitBurstShare * size;
  const oiOut = m.oiGiveBack != null && m.oiGiveBack > k.oiGiveBack;
  if (exit || oiOut) return { st: "SUDAH_KELUAR", why: exit ? `burst ${s > 0 ? "jual" : "beli"} di atas normal ≥ ${Math.round(k.exitBurstShare * 100)}% ukuran awal` : `OI kembali ${Math.round(m.oiGiveBack * 100)}% dari kenaikan awal` };
  if (dp >= k.ftPrice && (m.doi == null ? cvd > 0 : m.doi >= k.ftOi)) return { st: "FOLLOW_THROUGH", why: "harga & posisi terus bertambah searah" };
  if ((m.doi == null || m.doi >= -k.flatOi) && cvd > 0 && dp >= 0) return { st: "MASIH_DI_DALAM", why: "OI bertahan, CVD searah, harga di atas titik sinyal" };
  return { st: "TIDAK_ADA_FT", why: Math.abs(dp) < k.flatPrice ? "harga, OI dan CVD diam" : "tidak ada lanjutan searah" };
}
// compute checkpoint `cp` minutes after the signal from the bucket series; null until the bucket has closed
function checkpoint(series, t, cl, cp, now) {
  if (!cl || !cl.base) return null;
  const T = t + cp * 60e3, bc = bucketOf(T);
  if (now < bc + M5 + 30e3) return null;
  const after = series.filter(b => b.t > cl.base.b0 && b.t <= bc);
  const last = series.find(b => b.t === bc) || after[after.length - 1];
  if (!last || !after.length) return null;
  const cvd = after.reduce((a, b) => a + b.buy - b.sell, 0);
  const side = cl.side || 1;
  // opposite-side burst above that side's normal flow
  const normOpp = side > 0 ? cl.base.avgSell : cl.base.avgBuy;
  const maxBurst = Math.max(0, ...after.map(b => (side > 0 ? b.sell : b.buy) - (normOpp || 0)));
  const oiNow = (series.find(b => b.t === bc + M5) || {}).oi != null ? series.find(b => b.t === bc + M5).oi : last.oi;
  const doi = cl.base.oi != null && oiNow != null ? oiNow / cl.base.oi - 1 : null;
  const oiGiveBack = cl.base.oiUp > 0 && oiNow != null ? (cl.base.oi - oiNow) / cl.base.oiUp : null;
  const m = { dp: last.close / cl.base.price - 1, doi, cvd, maxBurst, oiGiveBack };
  const s = statusOf(m, cl.base, side);
  return { st: s.st, why: s.why, at: now, dp: +m.dp.toFixed(5), doi: doi == null ? null : +doi.toFixed(5), cvd: Math.round(cvd), burst: Math.round(maxBurst) };
}
const TRACKED = ["LONG_BARU", "SHORT_COVER", "SHORT_BARU", "LONG_EXIT", "SPOT_BELI", "SPOT_JUAL"];

const api = { setConfig, cfg, bucketOf, classify, classifyAt, statusOf, checkpoint, LABELS, STATUS, TAGS, TRACKED, M5 };
if (typeof module === "object" && module.exports) module.exports = api;
else root.FLOW = api;
})(typeof self !== "undefined" ? self : this);
