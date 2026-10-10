/* Adhi Whale Terminal: browser app (live data, views, charts). Signal rules live in engine.js. */
"use strict";
const { DEFAULTS, EX, STABLE, MAJORS, wib, usd, px, pct, esc, clamp, df } = WhaleEngine;
const TOP_FUT = 40, TOP_SPOT = 30, MAX_ITEMS = 150;
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const CFG = Object.assign({}, DEFAULTS, store.get("awt.cfg", {}));
const UI = Object.assign({ sound: false, notif: false, ex: { BF: true, BS: true, OF: true, OS: true }, side: "all", min: "", ikut: false, feed: "whale" }, store.get("awt.ui", {}));
let FNG = null, BTC_TREND = { dir: "flat", note: "memuat" };
let VIEW = "home";
const okxCtVal = new Map();
const E = WhaleEngine.create({ cfg: CFG, emit: onSignal, getFng: () => FNG, getBtc: () => BTC_TREND });
const { M, funding, liqWin, onTick, onTrade, onLiq, vol24 } = E;
setInterval(E.flushBursts, 300);
const isFut = mk => mk === "BF" || mk === "OF";

/* ============ small visual helpers ============ */
const LOGO_COLORS = ["#f7931a", "#627eea", "#14f195", "#e84142", "#2a5ada", "#c2a633", "#ff007a", "#00d1ff", "#8247e5", "#f0b90b"];
function logo(coin, size = "") {
  const c = String(coin).replace(/^1000+/, "").replace(/[^A-Za-z0-9]/g, "");
  const okx = `https://static.okx.com/cdn/oksupport/asset/currency/icon/${c.toLowerCase()}.png`;
  const bnb = `https://bin.bnbstatic.com/static/assets/logos/${c.toUpperCase()}.png`;
  return `<img class="logo ${size}" src="${okx}" data-alt="${bnb}" data-sym="${esc(c)}" alt="" loading="lazy" decoding="async">`;
}
function letterLogo(img) {
  const sym = img.dataset.sym || "?";
  let h = 0; for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const span = document.createElement("span");
  span.className = img.className;
  span.style.background = LOGO_COLORS[h % LOGO_COLORS.length];
  span.textContent = sym.slice(0, img.classList.contains("sm") ? 2 : 3);
  img.replaceWith(span);
}
// image errors don't bubble; catch them on the way down
document.addEventListener("error", e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("logo")) return;
  if (img.dataset.alt) { const a = img.dataset.alt; img.removeAttribute("data-alt"); img.src = a; }
  else letterLogo(img);
}, true);

function ring(score, size = 34, color) {
  const r = 14, c = 2 * Math.PI * r, col = color || (score >= 75 ? "var(--buy)" : score >= 55 ? "var(--warn)" : "var(--sell)");
  return `<svg class="ring" viewBox="0 0 34 34" width="${size}" height="${size}" aria-label="Skor ${score}"><circle cx="17" cy="17" r="${r}" fill="none" stroke="#1b2945" stroke-width="3.5"/><circle cx="17" cy="17" r="${r}" fill="none" stroke="${col}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${(score / 100 * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 17 17)"/><text x="17" y="21" text-anchor="middle" font-size="10" font-weight="700" fill="#e7eef8" font-family="IBM Plex Mono, monospace">${score}</text></svg>`;
}
function pctRing(a, label) {
  const p = a && a.n ? a.w / a.n : null, r = 26, c = 2 * Math.PI * r;
  const col = p == null ? "#56688a" : p >= .55 ? "#16c784" : p >= .45 ? "#f3ba2f" : "#ea3943";
  return `<div><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="${r}" fill="none" stroke="#1b2945" stroke-width="6"/>${p == null ? "" : `<circle cx="32" cy="32" r="${r}" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(p * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/>`}<text x="32" y="37" text-anchor="middle" font-size="15" font-weight="700" fill="#e7eef8" font-family="IBM Plex Mono, monospace">${p == null ? "--" : Math.round(p * 100) + "%"}</text></svg><small>${label}${a && a.n ? ` · ${a.n}` : ""}</small></div>`;
}
const fngColor = v => v < 25 ? "#ea3943" : v < 45 ? "#f0883d" : v < 55 ? "#f3ba2f" : v < 75 ? "#93d14f" : "#16c784";
function bestRec(coin) {
  for (const mk of ["BF", "BS", "OF", "OS"]) { const r = M[mk].get(coin); if (r && r.p) return { mk, r }; }
  return null;
}

/* ============ feeds ============ */
const FEEDS = {
  whale: { el: "feedWhale", n: "nWhale", h: "hWhale", col: "colWhale", items: [] },
  liq: { el: "feedLiq", n: "nLiq", h: "hLiq", col: "colLiq", items: [] },
  signal: { el: "feedSig", n: "nSig", h: "hSig", col: "colSig", items: [] }
};
let dirtyHome = true, dirtySave = true;

function onSignal(feed, s) {
  const f = FEEDS[feed];
  f.items.unshift(s);
  if (f.items.length > MAX_ITEMS) f.items.length = MAX_ITEMS;
  if (pass(s)) {
    const box = $(f.el);
    const empty = box.querySelector(".empty"); if (empty) empty.remove();
    box.insertAdjacentHTML("afterbegin", cardHTML(s, true));
    observeSparks(box.firstElementChild);
    while (box.children.length > MAX_ITEMS) box.lastElementChild.remove();
  }
  updateCount(feed);
  alertFor(s);
  if (s.reco.verdict === "IKUT") setTimeout(ikutLoop, 500);
  dirtyHome = dirtySave = true;
}

function sideOf(s) {
  return s.kind === "liq" ? (s.pos === "LONG" ? "buy" : "sell") : (s.dir === "up" ? "buy" : s.dir === "down" ? "sell" : "flat");
}
function pass(s) {
  if (!UI.ex[s.mk]) return false;
  const q = (UI.search || "").trim().toUpperCase();
  if (q && !s.coin.includes(q)) return false;
  if (UI.side !== "all" && sideOf(s) !== UI.side) return false;
  if (UI.min && s.kind !== "pump" && (s.value || 0) < +UI.min) return false;
  if (UI.ikut && s.reco.verdict !== "IKUT") return false;
  return true;
}

function describe(s) {
  const c = esc(s.coin), ex = EX[s.mk];
  if (s.kind === "liq") {
    return {
      tone: s.pos === "LONG" ? "buy" : "sell", chip: `${s.pos} LIQ`,
      title: `Likuidasi ${s.pos} · ${usd(s.value)}`,
      desc: `Posisi <b>${s.pos}</b> dipaksa tutup di <b>${px(s.price)}</b>${s.cluster > s.value ? ` · total 5 menit <b>${usd(s.cluster)}</b>` : ""}`,
      kv: [["Harga", px(s.price)], ["Nilai", usd(s.value)], ["24 jam", s.chg24 ? pct(s.chg24) : "--"], ["Posisi", s.pos]]
    };
  }
  if (s.kind === "pump") {
    const w = s.dir === "up" ? "PUMP" : "DUMP";
    return {
      tone: s.dir === "up" ? "buy" : "sell", chip: (s.dir === "up" ? "▲ " : "▼ ") + w,
      title: `${w} ${pct(s.chg)} dalam ${s.win || CFG.pumpWin} menit`,
      desc: `<b>${c}</b> ${s.dir === "up" ? "lonjakan beli tajam" : "tekanan jual tajam"} di ${ex}`,
      kv: [["Harga", px(s.price)], ["Perubahan", pct(s.chg)], ["24 jam", pct(s.chg24 || 0)], ["Sinyal", w]]
    };
  }
  const act = s.dir === "up" ? "BELI" : s.dir === "down" ? "JUAL" : "CAMPURAN";
  const tone = s.dir === "up" ? "buy" : s.dir === "down" ? "sell" : "neu";
  if (s.kind === "trade") {
    return {
      tone, chip: (s.dir === "up" ? "▲ " : "▼ ") + act,
      title: `Whale ${s.dir === "up" ? "beli" : "jual"} ${usd(s.value)}`,
      desc: `Market order besar sekaligus di ${ex}`,
      kv: [["Harga", px(s.price)], ["Nilai", usd(s.value)], ["24 jam", pct(s.chg24 || 0)], ["Arah", act]]
    };
  }
  return {
    tone, chip: (s.dir === "up" ? "▲ " : s.dir === "down" ? "▼ " : "") + act,
    title: `Volume tak biasa ${usd(s.value)}/menit`,
    desc: `${(s.mult || 0).toFixed(0)}× rata-rata · ${esc(s.how || "")}`,
    kv: [["Harga", px(s.price)], ["Nilai 1m", usd(s.value)], ["24 jam", pct(s.chg24 || 0)], ["Arah", act]]
  };
}

function planHTML(s) {
  const p = s.reco.plan;
  if (!p || s.reco.verdict !== "IKUT") return "";
  const fr = funding.get(s.coin);
  return `<div class="plan">
    <div class="e"><small>Entry</small><span>${px(p.entry)}</span></div>
    <div class="s"><small>Stop loss</small><span>${px(p.sl)}</span></div>
    <div class="t"><small>TP 1</small><span>${px(p.tp1)}</span></div>
    <div class="t"><small>TP 2</small><span>${px(p.tp2)}</span></div>
    <div><small>Leverage</small><span>maks ${p.lev}x</span></div>
    <div><small>Margin</small><span>Isolated</span></div>
    <div><small>Funding</small><span>${fr == null ? "--" : (fr * 100).toFixed(3) + "%"}</span></div>
    <div><small>Risiko</small><span>1% modal</span></div>
  </div>`;
}

function cardHTML(s, fresh, withOutcome) {
  const d = describe(s), r = s.reco;
  return `<article class="sc ${d.tone === "neu" ? "" : d.tone}${r.verdict === "IKUT" ? " ikut" : ""}${fresh ? " fresh" : ""}" data-id="${s.id}">
  <div class="sc-top">${logo(s.coin)}
    <div class="id"><b>${esc(s.coin)}</b><span class="chip dim">${isFut(s.mk) ? "PERP" : "SPOT"}</span><small>${EX[s.mk]} · ${wib(s.t)}${s.hist ? " · riwayat" : ""}</small></div>
    <span class="chip ${d.tone}">${d.chip}</span>
  </div>
  <div><div class="sc-title ${d.tone}">${d.title}</div><div class="sc-desc">${d.desc}</div></div>
  <div class="sc-mid">
    <svg class="spark" data-spark="${s.mk}|${esc(s.coin)}|${s.t}" viewBox="0 0 120 54" preserveAspectRatio="none" aria-hidden="true"></svg>
    <div class="kv">${d.kv.map(([k, v]) => `<div><small>${k}</small><span>${v}</span></div>`).join("")}</div>
  </div>
  <div class="reco">
    <div class="reco-h">${ring(r.score)}<span class="pill ${r.verdict}">${r.verdict}</span><span class="who">Saran untuk Adhi</span></div>
    ${planHTML(s)}
    <div class="rl"><em>Futures</em><span>${esc(r.fut)}</span></div>
    <div class="rl"><em>Spot</em><span>${esc(r.spot)}</span></div>
    ${r.reasons && r.reasons.length ? `<details class="why"><summary>Kenapa skor ${r.score}?</summary><ul>${r.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
  </div>
  ${withOutcome ? outcomeHTML(s) : ""}
  <div class="acts"><button type="button" class="pri" data-chart="${s.id}">Lihat chart</button><button type="button" data-ask="${s.id}">Tanya Claude</button></div>
</article>`;
}

function emptyHTML(feed) {
  const n = M.BF.size + M.BS.size + M.OF.size + M.OS.size;
  const what = { whale: "transaksi besar atau volume tak biasa", liq: "likuidasi di atas " + usd(CFG.liqMin), signal: `pergerakan ≥ ${CFG.pumpPct}% dalam ${CFG.pumpWin} menit` }[feed];
  return `<div class="empty">Menunggu ${what}…<br><span class="num">${n}</span> pasar sedang dipantau. Cek filter kalau lama kosong.</div>`;
}
function rerender(feed) {
  const f = FEEDS[feed], box = $(f.el);
  const list = f.items.filter(pass);
  box.innerHTML = list.length ? list.map(s => cardHTML(s, false)).join("") : emptyHTML(feed);
  observeSparks(box);
  updateCount(feed);
}
function rerenderAll() { for (const k in FEEDS) rerender(k); }
function updateCount(feed) {
  const f = FEEDS[feed], n = f.items.filter(pass).length;
  $(f.n).textContent = n; $(f.h).textContent = n + " sinyal";
}
function findSignal(id) {
  for (const k in FEEDS) { const s = FEEDS[k].items.find(x => x.id === id); if (s) return s; }
  return HIST.items.find(x => x.id === id) || null;
}

/* ============ candles (shared by sparklines, IKUT checks and the chart sheet) ============ */
const CANDLES = new Map();
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}
async function candles(mk, coin, tf, limit = 210) {
  const key = `${mk}:${coin}:${tf}:${limit}`, ttl = tf === "1m" ? 60000 : tf === "15m" ? 25000 : tf === "1d" ? 900000 : 240000;
  const hit = CANDLES.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.cs;
  const okxBar = { "1m": "1m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" }[tf];
  const bin = base => getJSON(`${base}?symbol=${coin}USDT&interval=${tf}&limit=${limit}`).then(k => k.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[7] })));
  const okx = inst => getJSON(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${okxBar}&limit=${Math.min(limit, 300)}`).then(j => j.data.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[7] })).reverse());
  const spot = () => bin("https://data-api.binance.vision/api/v3/klines");
  const order = mk === "BF" ? [() => bin("https://fapi.binance.com/fapi/v1/klines"), spot, () => okx(`${coin}-USDT-SWAP`)]
    : mk === "BS" ? [spot, () => okx(`${coin}-USDT`)]
    : mk === "OF" ? [() => okx(`${coin}-USDT-SWAP`), spot]
    : [() => okx(`${coin}-USDT`), spot];
  for (const f of order) {
    try { const cs = await f(); if (cs.length >= Math.min(30, limit)) { CANDLES.set(key, { at: Date.now(), cs }); return cs; } } catch {}
  }
  return hit ? hit.cs : null;
}

/* sparklines: last hour of 1m candles, drawn when the card scrolls into view */
const sparkQ = [];
let sparkBusy = 0, sparkSeq = 0;
const sparkObs = "IntersectionObserver" in window ? new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { sparkObs.unobserve(e.target); sparkQ.push(e.target); }
  pumpSparks();
}, { rootMargin: "200px" }) : null;
function observeSparks(root) {
  if (!root) return;
  const els = root.matches && root.matches("svg.spark") ? [root] : root.querySelectorAll("svg.spark:not([data-done])");
  for (const el of els) { el.setAttribute("data-done", "1"); if (sparkObs) sparkObs.observe(el); else sparkQ.push(el); }
  if (!sparkObs) pumpSparks();
}
async function pumpSparks() {
  while (sparkBusy < 3 && sparkQ.length) {
    const el = sparkQ.shift();
    sparkBusy++;
    drawSpark(el).finally(() => { sparkBusy--; pumpSparks(); });
  }
}
async function drawSpark(el) {
  const [mk, coin, t] = el.dataset.spark.split("|");
  const old = Date.now() - +t > 50 * 60000;
  let cs = null;
  try { cs = old ? null : await candles(mk, coin, "1m", 60); } catch {}
  if (!cs || cs.length < 5) {
    try { cs = await candles(mk, coin, "15m", 48); } catch {}
  }
  if (!cs || cs.length < 5) return;
  const W = 120, H = 54, P = 4;
  const lo = Math.min(...cs.map(c => c.l)), hi = Math.max(...cs.map(c => c.h)), span = hi - lo || 1;
  const xs = i => P + (W - 2 * P) * i / (cs.length - 1), ys = v => H - P - (H - 2 * P) * (v - lo) / span;
  const up = cs[cs.length - 1].c >= cs[0].o, col = up ? "#16c784" : "#ea3943";
  const line = cs.map((c, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)} ${ys(c.c).toFixed(1)}`).join(" ");
  let mark = "";
  const ti = cs.findIndex(c => c.t >= +t - 60000);
  if (ti >= 0) mark = `<line x1="${xs(ti)}" x2="${xs(ti)}" y1="2" y2="${H - 2}" stroke="#22d3ee" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>`;
  const gid = "sg" + (++sparkSeq);
  el.innerHTML = `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${line} L${xs(cs.length - 1)} ${H} L${xs(0)} ${H} Z" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>${mark}`;
}

/* ============ Tanya Claude & chart buttons ============ */
document.addEventListener("click", e => {
  const ask = e.target.closest("[data-ask]");
  if (ask) return askClaude(findSignal(ask.dataset.ask));
  const ch = e.target.closest("[data-chart]");
  if (ch) { const s = findSignal(ch.dataset.chart); if (s) openChart({ mk: s.mk, coin: s.coin, sig: s }); return; }
  const ikc = e.target.closest("[data-ikchart]");
  if (ikc) { const x = IK.setups.get(ikc.dataset.ikchart); if (x) openChart({ mk: x.sig.mk, coin: x.sig.coin, sig: x.sig, setup: x }); return; }
  const ht = e.target.closest("[data-heat]");
  if (ht) { const [mk, coin] = ht.dataset.heat.split("|"); openChart({ mk, coin }); return; }
  const go = e.target.closest("[data-go]");
  if (go) showView(go.dataset.go);
});
function askClaude(s) {
  if (!s) return;
  const what = s.kind === "liq" ? `Likuidasi ${s.pos} ${usd(s.value)} di ${px(s.price)} (total ${s.pos} 5 menit ${usd(s.cluster)})`
    : s.kind === "pump" ? `${s.dir === "up" ? "PUMP" : "DUMP"} ${pct(s.chg)} dalam ${s.win || CFG.pumpWin} menit, harga ${px(s.price)}`
    : s.kind === "trade" ? `Transaksi ${s.dir === "up" ? "BELI" : "JUAL"} besar ${usd(s.value)} di ${px(s.price)}`
    : `Volume tak biasa ${usd(s.value)} dalam 1 menit (${(s.mult || 0).toFixed(0)}x rata-rata), ${s.how}`;
  const prompt = `Saya Adhi, trader konservatif (futures maks 3x dan spot). Analisis sinyal whale ini dan beri saran: ikut atau tidak, entry, stop loss, take profit, untuk futures dan spot.

Coin: ${s.coin} (${EX[s.mk]})
Sinyal: ${what}
Waktu: ${wib(s.t)}
Perubahan 24 jam: ${pct(s.chg24 || 0)}
Volume 24 jam: ${usd(vol24(s.coin))}
Funding rate: ${funding.has(s.coin) ? (funding.get(s.coin) * 100).toFixed(4) + "%" : "tidak ada"}
Fear & Greed: ${FNG ? FNG.value + " (" + FNG.label + ")" : "tidak ada"}
Tren BTC 1 jam: ${BTC_TREND.note}
Skor dashboard: ${s.reco.score}/100 → ${s.reco.verdict}
Alasan: ${(s.reco.reasons || []).join("; ")}

Jawab dalam Bahasa Indonesia, ringkas, dan sebutkan risikonya.`;
  try { navigator.clipboard.writeText(prompt).catch(() => {}); } catch {}
  window.open("https://claude.ai/new?q=" + encodeURIComponent(prompt), "_blank", "noopener");
  toast("Prompt dibuka di Claude (juga disalin)");
}

/* ============ chart sheet ============ */
let CH = null;
function openChart(ctx) {
  CH = Object.assign({ tf: "15m" }, ctx);
  $("chLogo").innerHTML = logo(ctx.coin, "lg");
  $("chTitle").textContent = `${ctx.coin}/USDT`;
  $("chSub").textContent = `${EX[ctx.mk]} · ${isFut(ctx.mk) ? "Perpetual" : "Spot"}${ctx.setup ? ` · setup ${ctx.setup.side}` : ctx.sig ? ` · sinyal ${wib(ctx.sig.t)}` : ""}`;
  $("chTv").href = `https://www.tradingview.com/chart/?symbol=${ctx.mk[0] === "B" ? "BINANCE" : "OKX"}:${encodeURIComponent(ctx.coin)}USDT${isFut(ctx.mk) ? ".P" : ""}`;
  for (const b of $("chTf").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.tf === CH.tf);
  $("chartSheet").hidden = false;
  document.body.style.overflow = "hidden";
  drawChart();
}
function closeChart() {
  $("chartSheet").hidden = true; document.body.style.overflow = "";
  if (CH && CH.chart) { CH.chart.remove(); CH.chart = null; }
  CH = null;
}
$("chClose").addEventListener("click", closeChart);
$("chartSheet").addEventListener("click", e => { if (e.target.id === "chartSheet") closeChart(); });
$("chTf").addEventListener("click", e => {
  const b = e.target.closest("button[data-tf]"); if (!b || !CH) return;
  CH.tf = b.dataset.tf;
  for (const x of $("chTf").querySelectorAll("button")) x.setAttribute("aria-pressed", x === b);
  drawChart();
});
async function drawChart() {
  const box = $("chartBox"), ctx = CH;
  if (CH.chart) { CH.chart.remove(); CH.chart = null; }
  box.innerHTML = `<div class="empty">Memuat candle ${ctx.tf}…</div>`;
  const cs = await candles(ctx.mk, ctx.coin, ctx.tf, 200);
  if (CH !== ctx) return;
  if (!cs) { box.innerHTML = `<div class="empty">Candle ${esc(ctx.coin)} belum bisa diambil dari exchange.</div>`; return; }
  box.innerHTML = "";
  if (!window.LightweightCharts) { box.innerHTML = `<div class="empty">Library chart gagal dimuat. Cek koneksi lalu buka lagi.</div>`; return; }
  const chart = LightweightCharts.createChart(box, {
    autoSize: true,
    layout: { background: { color: "#0c1526" }, textColor: "#8a9bb8", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
    grid: { vertLines: { color: "#132039" }, horzLines: { color: "#132039" } },
    rightPriceScale: { borderColor: "#1b2945" },
    timeScale: { borderColor: "#1b2945", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t, type) => type < 3 ? df.format(new Date(t * 1000)) : wib(t * 1000).slice(0, 5) },
    crosshair: { mode: 0 },
    localization: { locale: "id-ID", timeFormatter: t => wib(t * 1000).replace(" WIB", "") }
  });
  CH.chart = chart;
  const prec = cs[cs.length - 1].c >= 100 ? 2 : cs[cs.length - 1].c >= 1 ? 4 : 6;
  const series = chart.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", borderVisible: false, wickUpColor: "#16c784", wickDownColor: "#ea3943", priceFormat: { type: "price", precision: prec, minMove: Math.pow(10, -prec) } });
  series.setData(cs.map(c => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c })));
  const closes = cs.map(c => c.c);
  const addEma = (n, color) => {
    const e = emaArr(closes, n), s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s.setData(cs.map((c, i) => ({ time: Math.floor(c.t / 1000), value: e[i] })).slice(n));
  };
  addEma(20, "#f3ba2f"); addEma(50, "#a78bfa");
  const lines = [], add = (price, color, title, style = 0) => { if (price > 0) { series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }); lines.push([color, title]); } };
  const x = ctx.setup;
  const plan = x && x.at ? { entry: x.entry, sl: x.sl, tp1: x.tp1, tp2: x.tp2 } : ctx.sig && ctx.sig.reco && ctx.sig.reco.plan;
  if (plan) { add(plan.entry, "#22d3ee", "Entry"); add(plan.sl, "#ea3943", "SL"); add(plan.tp1, "#16c784", "TP1"); add(plan.tp2, "#16c784", "TP2"); }
  else if (ctx.sig) add(ctx.sig.price, "#22d3ee", "Sinyal");
  const lv = levels(cs.slice(-150), closes[closes.length - 1]);
  lv.sup.forEach((v, i) => add(v, "#4f8cff", "S" + (i + 1), 2));
  lv.res.forEach((v, i) => add(v, "#f0883d", "R" + (i + 1), 2));
  if (ctx.sig) series.setMarkers([{ time: Math.floor(ctx.sig.t / 1000 / (tfSec(ctx.tf))) * tfSec(ctx.tf), position: ctx.sig.dir === "down" ? "aboveBar" : "belowBar", color: "#22d3ee", shape: ctx.sig.dir === "down" ? "arrowDown" : "arrowUp", text: "sinyal" }].filter(m => m.time >= cs[0].t / 1000));
  // show the most recent ~90 candles; older ones are a swipe away
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cs.length - 90), to: cs.length + 3 });
  $("chLegend").innerHTML = [["#f3ba2f", "EMA20"], ["#a78bfa", "EMA50"], ...lines].filter((v, i, a) => a.findIndex(y => y[1] === v[1]) === i)
    .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("");
}
const tfSec = tf => ({ "15m": 900, "1h": 3600, "4h": 14400 }[tf] || 900);

/* ============ alerts ============ */
let actx = null;
function beep(up) {
  if (!UI.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = up ? 880 : 440; o.type = "sine";
    g.gain.setValueAtTime(0.15, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.35);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.36);
  } catch {}
}
function notify(title, body, tag) {
  if (UI.notif && "Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body, tag, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23060b16'/%3E%3Cpath d='M10 36c6-12 22-16 34-10 4-6 8-8 12-8-2 4-3 8-2 12-6 14-28 20-44 6z' fill='%2322d3ee'/%3E%3C/svg%3E" }); } catch {}
  }
}
function alertFor(s) {
  if (s.hist) return;
  const important = s.reco.verdict === "IKUT" || (s.value || 0) >= CFG.alertBig;
  if (!important || !pass(s)) return;
  beep(s.dir === "up");
  const title = s.kind === "liq" ? `Likuidasi ${s.pos} ${s.coin} ${usd(s.value)}` : s.kind === "pump" ? `${s.coin} ${s.dir === "up" ? "PUMP" : "DUMP"} ${pct(s.chg)}` : `${s.coin} whale ${s.dir === "up" ? "BELI" : "JUAL"} ${usd(s.value)}`;
  notify(title, `${s.reco.verdict} (skor ${s.reco.score}) · ${s.reco.fut}`, s.id);
}

/* ============ connections ============ */
const status = { bf: 0, bs: 0, okx: 0 };
function setStatus(k, ok) {
  status[k] = ok;
  const d = document.querySelector(`#srcDots [data-src="${k}"]`);
  if (d) { d.classList.toggle("ok", ok === 1); d.classList.toggle("err", ok === -1); }
  $("liveDot").classList.toggle("off", !Object.values(status).some(v => v === 1));
}
function wsConnect(name, urls, onOpen, onMsg) {
  let i = 0, delay = 1000, ws;
  const go = () => {
    const url = urls[i % urls.length];
    try { ws = new WebSocket(url); } catch { i++; return setTimeout(go, delay); }
    let opened = false;
    ws.onopen = () => { opened = true; delay = 1000; setStatus(name, 1); onOpen(ws); };
    ws.onmessage = e => { try { onMsg(e.data, ws); } catch (err) { console.warn(name, err); } };
    ws.onclose = () => { setStatus(name, -1); if (!opened) i++; delay = Math.min(delay * 2, 30000); setTimeout(go, delay); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  go();
}
const coinOf = sym => sym.endsWith("USDT") ? sym.slice(0, -4) : null;
const pickTop = (mk, n) => [...M[mk].entries()].filter(([c]) => !STABLE.has(c)).sort((a, b) => b[1].q - a[1].q).slice(0, n).map(([c]) => c);

wsConnect("bf", ["wss://fstream.binance.com/stream?streams=!forceOrder@arr/!miniTicker@arr"], ws => { ws._sub = false; }, (raw, ws) => {
  const m = JSON.parse(raw); if (!m.data) return;
  const d = m.data, st = m.stream || "";
  if (st.startsWith("!miniTicker")) {
    const t = Date.now();
    for (const x of d) { const c = coinOf(x.s); if (c) onTick("BF", c, +x.c, +x.o, +x.q, t); }
    if (!ws._sub && M.BF.size > 50) { ws._sub = true; ws.send(JSON.stringify({ method: "SUBSCRIBE", params: pickTop("BF", TOP_FUT).map(c => c.toLowerCase() + "usdt@aggTrade"), id: 1 })); }
  } else if (d.e === "forceOrder") {
    const o = d.o, c = coinOf(o.s); if (!c) return;
    const price = +o.ap || +o.p, qty = +o.z || +o.q;
    onLiq("BF", c, o.S === "SELL" ? "LONG" : "SHORT", price, price * qty, +o.T || d.E);
  } else if (d.e === "aggTrade") { const c = coinOf(d.s); if (c) onTrade("BF", c, +d.p, +d.q, d.m, +d.T); }
});
wsConnect("bs", ["wss://stream.binance.com:9443/stream?streams=!miniTicker@arr", "wss://data-stream.binance.vision/stream?streams=!miniTicker@arr"], ws => { ws._sub = false; }, (raw, ws) => {
  const m = JSON.parse(raw); if (!m.data) return;
  const d = m.data;
  if (Array.isArray(d)) {
    const t = Date.now();
    for (const x of d) { const c = coinOf(x.s); if (c) onTick("BS", c, +x.c, +x.o, +x.q, t); }
    if (!ws._sub && M.BS.size > 50) { ws._sub = true; ws.send(JSON.stringify({ method: "SUBSCRIBE", params: pickTop("BS", TOP_SPOT).map(c => c.toLowerCase() + "usdt@aggTrade"), id: 2 })); }
  } else if (d.e === "aggTrade") { const c = coinOf(d.s); if (c) onTrade("BS", c, +d.p, +d.q, d.m, +d.T); }
});
let okxPing = null;
wsConnect("okx", ["wss://ws.okx.com:8443/ws/v5/public", "wss://wsaws.okx.com:8443/ws/v5/public"], ws => {
  ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }));
  clearInterval(okxPing); okxPing = setInterval(() => { try { ws.send("ping"); } catch {} }, 25000);
}, raw => {
  if (raw === "pong") return;
  const m = JSON.parse(raw);
  if (!m.data || !m.arg || m.arg.channel !== "liquidation-orders") return;
  for (const it of m.data) {
    if (!/-USDT-SWAP$/.test(it.instId)) continue;
    const c = it.instId.split("-")[0], ct = okxCtVal.get(it.instId);
    if (!ct) continue;
    for (const dt of it.details || []) {
      const price = +dt.bkPx, value = +dt.sz * ct * price;
      const pos = dt.posSide === "long" ? "LONG" : dt.posSide === "short" ? "SHORT" : (dt.side === "sell" ? "LONG" : "SHORT");
      onLiq("OF", c, pos, price, value, +dt.ts);
    }
  }
});
async function okxInstruments() {
  try {
    const j = await getJSON("https://www.okx.com/api/v5/public/instruments?instType=SWAP");
    for (const x of j.data) if (x.ctType === "linear") okxCtVal.set(x.instId, +x.ctVal * (+x.ctMult || 1));
  } catch (e) { console.warn(e); setTimeout(okxInstruments, 30000); }
}
async function okxTickers() {
  try {
    const [sp, sw] = await Promise.all([getJSON("https://www.okx.com/api/v5/market/tickers?instType=SPOT"), getJSON("https://www.okx.com/api/v5/market/tickers?instType=SWAP")]);
    const t = Date.now();
    for (const x of sp.data) if (/-USDT$/.test(x.instId)) onTick("OS", x.instId.split("-")[0], +x.last, +x.open24h, +x.volCcy24h, t);
    for (const x of sw.data) if (/-USDT-SWAP$/.test(x.instId)) onTick("OF", x.instId.split("-")[0], +x.last, +x.open24h, +x.volCcy24h * +x.last, t);
    if (status.okx !== 1) setStatus("okx", 1);
  } catch (e) { console.warn(e); }
}
async function loadFunding() {
  try { const j = await getJSON("https://fapi.binance.com/fapi/v1/premiumIndex"); for (const x of j) { const c = coinOf(x.symbol); if (c) funding.set(c, +x.lastFundingRate); } } catch {}
}
async function loadBtcTrend() {
  for (const u of ["https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=60", "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=60"]) {
    try {
      const closes = (await getJSON(u)).map(x => +x[4]);
      const emas = emaArr(closes, 20);
      const p = closes[closes.length - 1], e = emas[emas.length - 1], ePrev = emas[emas.length - 4];
      const dir = p > e * 1.002 && e > ePrev ? "up" : p < e * 0.998 && e < ePrev ? "down" : "flat";
      BTC_TREND = { dir, note: dir === "up" ? "naik, di atas EMA20" : dir === "down" ? "turun, di bawah EMA20" : "sideways" };
      return;
    } catch {}
  }
}

/* ============ Fear & Greed hero ============ */
const FNG_ID = { "Extreme Fear": "Ketakutan Ekstrem", "Fear": "Ketakutan", "Neutral": "Netral", "Greed": "Keserakahan", "Extreme Greed": "Keserakahan Ekstrem" };
async function loadFng() {
  try {
    const j = await getJSON("https://api.alternative.me/fng/?limit=31");
    const d = j.data.map(x => ({ v: +x.value, label: FNG_ID[x.value_classification] || x.value_classification, t: +x.timestamp * 1000, next: +x.time_until_update || 0 }));
    FNG = { value: d[0].v, label: d[0].label, hist: d, next: d[0].next };
    renderFng();
  } catch (e) {
    if (!FNG) $("fngHero").innerHTML = `<div class="empty">Tidak bisa memuat Fear &amp; Greed dari alternative.me. Mencoba lagi dalam 1 menit.</div>`;
    setTimeout(loadFng, 60000);
  }
}
function fngAdvice(v) {
  if (v < 25) return "<b>Ketakutan ekstrem.</b> Banyak yang panik jual. Spot: zona cicil beli coin berkualitas. Futures: hindari SHORT baru, pantulan tajam sering terjadi.";
  if (v < 45) return "<b>Ketakutan.</b> Pasar hati-hati. Cicil spot bertahap boleh, futures pakai leverage kecil dan tunggu konfirmasi tren.";
  if (v < 55) return "<b>Netral.</b> Sentimen tidak memberi keunggulan. Ikuti sinyal yang searah tren BTC saja.";
  if (v < 75) return "<b>Keserakahan.</b> Tren cenderung naik tapi mulai ramai. LONG searah tren boleh dengan stop ketat; jangan kejar coin yang sudah pump besar.";
  return "<b>Keserakahan ekstrem.</b> Euforia, risiko koreksi tinggi. Ambil sebagian profit, kurangi leverage, jangan buka LONG baru di coin yang sudah naik banyak.";
}
function renderFng() {
  const f = FNG, v = f.value, h = f.hist, col = fngColor(v);
  const cx = 110, cy = 104, R = 86;
  const pt = (val, r) => { const a = Math.PI * (1 - val / 100); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const arc = (a, b, color) => { const [x1, y1] = pt(a, R), [x2, y2] = pt(b, R); return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${color}" stroke-width="14" fill="none" stroke-linecap="butt"/>`; };
  const [nx, ny] = pt(v, R - 22);
  const [kx, ky] = pt(v, R);
  const at = i => (h[i] ? h[i].v : null);
  const cmp = (lbl, x) => `<span>${lbl} <b style="color:${x == null ? "var(--muted)" : fngColor(x)}">${x == null ? "--" : x}</b></span>`;
  const pts = h.slice().reverse(), W = 300, H = 56;
  const xs = i => 2 + (W - 4) * i / Math.max(1, pts.length - 1), ys = val => H - 4 - (H - 8) * val / 100;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)} ${ys(p.v).toFixed(1)}`).join(" ");
  $("fngHero").innerHTML = `
  <div class="k">Fear &amp; Greed Index · sentimen pasar</div>
  <div class="hero-row" style="margin-top:6px">
    <svg class="gauge" viewBox="0 0 220 122" role="img" aria-label="Fear and Greed ${v}">
      <defs><filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter></defs>
      ${arc(0, 25, "#ea3943")}${arc(25, 45, "#f0883d")}${arc(45, 55, "#f3ba2f")}${arc(55, 75, "#93d14f")}${arc(75, 100, "#16c784")}
      <circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="9" fill="${col}" filter="url(#gl)" opacity=".9"/>
      <circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="6" fill="#fff"/>
      <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#e7eef8" stroke-width="3" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="6" fill="#e7eef8"/>
      <text x="18" y="120" fill="#8a9bb8" font-size="10">Takut</text><text x="202" y="120" fill="#8a9bb8" font-size="10" text-anchor="end">Serakah</text>
    </svg>
    <div>
      <div class="fng-v" style="color:${col};text-shadow:0 0 24px ${col}66">${v}</div>
      <div class="fng-l" style="color:${col}">${f.label}</div>
      <div class="fng-cmp">${cmp("Kemarin", at(1))}${cmp("7h", at(7))}${cmp("30h", at(30))}</div>
    </div>
  </div>
  <svg class="spark30" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Riwayat 30 hari">
    <line x1="0" x2="${W}" y1="${ys(50)}" y2="${ys(50)}" stroke="#1b2945" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
    <path d="${line} L${xs(pts.length - 1)} ${H} L${xs(0)} ${H} Z" fill="${col}" fill-opacity=".12"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="foot" style="display:flex;justify-content:space-between"><span>${df.format(new Date(pts[0].t))}</span><span>30 hari · alternative.me</span><span>${df.format(new Date(pts[pts.length - 1].t))}</span></div>
  <div class="fng-note">${fngAdvice(v)}</div>`;
}

/* ============ header, ticker, home ============ */
function topCoins(n) {
  const best = new Map();
  for (const mk of ["BF", "BS", "OF", "OS"]) for (const [c, r] of M[mk]) {
    if (STABLE.has(c) || !r.p || !r.o) continue;
    const b = best.get(c);
    if (!b || r.q > b.r.q) best.set(c, { mk, coin: c, r });
  }
  return [...best.values()].sort((a, b) => b.r.q - a.r.q).slice(0, n);
}
// coins Adhi follows; XAU = gold perpetual (Binance Futures), OKX XAUT as fallback
const FOCUS = ["BTC", "ETH", "SOL", "HYPE", "LINK", "TAO", "ONDO", "INJ", "PENDLE", "NEAR", "XAU"];
function focusCoins() {
  const out = [];
  for (const c of FOCUS) {
    let b = bestRec(c);
    if (!b && c === "XAU") { const r = M.OS.get("XAUT") || M.OF.get("XAUT"); if (r && r.p) b = { mk: M.OS.get("XAUT") ? "OS" : "OF", r }; }
    if (b && b.r.o) out.push({ mk: b.mk, coin: c, r: b.r });
  }
  return out;
}
let tickerKey = "";
function renderTicker() {
  const top = focusCoins();
  if (!top.length) return;
  const label = c => c === "XAU" ? "XAU/USDT" : c;
  const items = top.map(x => { const ch = x.r.p / x.r.o - 1; return `<button class="tk" data-heat="${x.mk}|${esc(x.coin === "XAU" && x.mk[0] === "O" ? "XAUT" : x.coin)}">${logo(x.coin === "XAU" ? "XAUT" : x.coin, "sm")}<b>${label(x.coin)}</b><span class="num">${px(x.r.p)}</span><span class="num ${ch >= 0 ? "up" : "down"}">${pct(ch)}</span></button>`; }).join("");
  const key = top.map(x => x.coin).join();
  const track = $("ticker");
  if (key !== tickerKey) { track.innerHTML = items + items; tickerKey = key; return; }
  // update numbers in place so the marquee keeps scrolling smoothly
  const btns = track.querySelectorAll(".tk");
  top.forEach((x, i) => {
    const ch = x.r.p / x.r.o - 1;
    for (const b of [btns[i], btns[i + top.length]]) {
      if (!b) continue;
      const n = b.querySelectorAll(".num");
      n[0].textContent = px(x.r.p); n[1].textContent = pct(ch); n[1].className = "num " + (ch >= 0 ? "up" : "down");
    }
  });
}
function renderStats() {
  const set = (c, idv, ids) => {
    const b = bestRec(c);
    if (!b) return;
    const ch = b.r.o ? b.r.p / b.r.o - 1 : 0;
    $(idv).textContent = px(b.r.p);
    $(ids).innerHTML = `<span class="${ch >= 0 ? "up" : "down"}">${pct(ch)}</span> · ${EX[b.mk]}`;
  };
  set("BTC", "msBtc", "msBtcS"); set("ETH", "msEth", "msEthS");
  const tr = BTC_TREND;
  $("msTrend").innerHTML = `<span class="${tr.dir === "up" ? "up" : tr.dir === "down" ? "down" : "flat"}">${tr.dir === "up" ? "▲ Naik" : tr.dir === "down" ? "▼ Turun" : "■ Sideways"}</span>`;
  const n = M.BF.size + M.BS.size + M.OF.size + M.OS.size;
  $("msMarkets").textContent = n;
  $("msMarketsS").textContent = `BF ${M.BF.size} · BS ${M.BS.size} · OKX ${M.OF.size + M.OS.size}`;
  const now = Date.now(); let L = 0, S = 0;
  for (const x of liqWin) if (x.t >= now - 3600000) { if (x.pos === "LONG") L += x.v; else S += x.v; }
  $("msLiq").innerHTML = `<span class="up">${usd(L)}</span> <span style="color:var(--faint)">/</span> <span class="down">${usd(S)}</span>`;
  const t = L + S || 1;
  $("msLiqL").style.width = (L / t * 100) + "%"; $("msLiqS").style.width = (S / t * 100) + "%";
}
let heatAt = 0;
function renderHeat() {
  if (Date.now() - heatAt < 5000) return;
  heatAt = Date.now();
  const top = topCoins(22);
  if (!top.length) return;
  $("heat").innerHTML = top.map((x, i) => {
    const ch = x.r.p / x.r.o - 1, a = clamp(Math.abs(ch) / 0.08, 0.12, 0.85);
    const bg = ch >= 0 ? `rgba(22,199,132,${a})` : `rgba(234,57,67,${a})`;
    return `<button class="ht${i < 2 ? " big" : ""}" style="background:linear-gradient(160deg, ${bg}, rgba(12,21,38,.6))" data-heat="${x.mk}|${esc(x.coin)}">
      <span class="t">${logo(x.coin, "sm")}${esc(x.coin)}</span><span class="c">${pct(ch)}</span><span class="p">${px(x.r.p)}</span></button>`;
  }).join("");
}
function renderLatest() {
  const all = [];
  for (const k in FEEDS) for (const s of FEEDS[k].items.slice(0, 10)) all.push(s);
  all.sort((a, b) => b.t - a.t);
  const list = all.slice(0, 8);
  if (!list.length) return;
  $("latest").innerHTML = list.map(s => {
    const d = describe(s);
    return `<button class="rw" data-chart="${s.id}">${logo(s.coin)}<span class="m"><b>${esc(s.coin)} <span class="chip ${d.tone}">${d.chip}</span></b><small>${d.title} · ${EX[s.mk]}</small></span><span class="r"><span class="pill ${s.reco.verdict}">${s.reco.verdict}</span><small class="num" style="color:var(--muted);font-size:11px">${wib(s.t).replace(" WIB", "")}</small></span></button>`;
  }).join("");
}
function renderHomeIk() {
  const list = ikSorted().filter(x => x.st !== "cancel");
  $("homeIkN").textContent = list.length ? `${list.filter(x => x.st === "go").length} bisa diikuti · ${list.length} total` : "";
  if (!list.length) { $("homeIk").innerHTML = `<article class="panel"><div class="empty" style="padding:12px 4px">Belum ada saran IKUT dalam 60 menit terakhir. Profil konservatif membuat IKUT jarang muncul.</div></article>`; return; }
  $("homeIk").innerHTML = list.slice(0, 8).map(x => {
    const s = x.sig;
    return `<article class="panel mini-ik${x.st === "go" ? " glow" : ""}">
      <div class="row">${logo(s.coin)}<div style="flex:1;min-width:0"><b>${esc(s.coin)}</b> <span class="chip ${x.side === "LONG" ? "buy" : "sell"}">${x.side}</span><div class="foot">${EX[s.mk]} · ${Math.floor((Date.now() - s.t) / 60000)} mnt lalu</div></div>${ring(s.reco.score)}</div>
      <span class="st ${x.st || "wait"}" style="padding:6px 9px;font-size:11.5px">${esc(x.why || "Menghitung indikator…")}</span>
      ${x.at ? `<div class="lv3"><div><small class="k">Entry</small><span style="color:var(--glow)">${px(x.entry)}</span></div><div><small class="k">SL</small><span class="down">${px(x.sl)}</span></div><div><small class="k">TP1</small><span class="up">${px(x.tp1)}</span></div></div>` : ""}
      <div class="acts"><button class="pri" data-ikchart="${esc(x.key)}">Chart + level</button><button data-go="ikut">Detail</button></div>
    </article>`;
  }).join("");
}

/* ============ saved feed across reloads ============ */
let lastSave = 0;
function saveHistory() {
  if (Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  const out = {};
  for (const k in FEEDS) out[k] = FEEDS[k].items.slice(0, 60);
  store.set("awt.hist", out);
}
function loadHistory() {
  const h = store.get("awt.hist", null);
  if (!h) return;
  const cut = Date.now() - 12 * 3600000;
  for (const k in FEEDS) if (Array.isArray(h[k])) FEEDS[k].items = h[k].filter(s => s && s.t > cut && s.reco).map(s => (s.hist = true, s));
}

/* ============ controls ============ */
function saveUI() { store.set("awt.ui", { sound: UI.sound, notif: UI.notif, ex: UI.ex, side: UI.side, min: UI.min, ikut: UI.ikut, feed: UI.feed }); }
$("fSearch").addEventListener("input", e => { UI.search = e.target.value; rerenderAll(); });
document.querySelectorAll(".fc[data-ex]").forEach(b => {
  b.setAttribute("aria-pressed", UI.ex[b.dataset.ex] ? "true" : "false");
  b.addEventListener("click", () => { UI.ex[b.dataset.ex] = !UI.ex[b.dataset.ex]; b.setAttribute("aria-pressed", UI.ex[b.dataset.ex]); saveUI(); rerenderAll(); });
});
$("fSide").value = UI.side; $("fSide").addEventListener("change", e => { UI.side = e.target.value; saveUI(); rerenderAll(); });
$("fMin").value = UI.min; $("fMin").addEventListener("input", e => { UI.min = e.target.value; saveUI(); rerenderAll(); });
$("fIkut").setAttribute("aria-pressed", UI.ikut); $("fIkut").addEventListener("click", () => { UI.ikut = !UI.ikut; $("fIkut").setAttribute("aria-pressed", UI.ikut); saveUI(); rerenderAll(); });
function setFeed(f) {
  UI.feed = f; saveUI();
  for (const b of $("sigSeg").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.feed === f);
  for (const k in FEEDS) $(FEEDS[k].col).hidden = k !== f;
}
$("sigSeg").addEventListener("click", e => { const b = e.target.closest("button[data-feed]"); if (b) setFeed(b.dataset.feed); });

function syncToggles() { $("btnSound").setAttribute("aria-pressed", UI.sound); $("btnNotif").setAttribute("aria-pressed", UI.notif); }
$("btnSound").addEventListener("click", () => { UI.sound = !UI.sound; if (UI.sound) beep(true); syncToggles(); saveUI(); toast(UI.sound ? "Bunyi aktif untuk sinyal IKUT & nilai besar" : "Bunyi dimatikan"); });
$("btnNotif").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("Browser ini tidak mendukung notifikasi. Di iPhone, buka dari ikon Home Screen.");
  if (!UI.notif) {
    const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (p !== "granted") return toast("Izin notifikasi ditolak. Aktifkan dari pengaturan browser.");
    UI.notif = true; toast("Notifikasi aktif untuk IKUT & nilai besar");
  } else { UI.notif = false; toast("Notifikasi dimatikan"); }
  syncToggles(); saveUI();
});
syncToggles();

const KEYS = Object.keys(DEFAULTS);
const fillForm = c => { for (const k of KEYS) $("s_" + k).value = c[k]; };
const closeSet = () => { $("setSheet").hidden = true; document.body.style.overflow = ""; };
$("btnSettings").addEventListener("click", () => { fillForm(CFG); $("setSheet").hidden = false; document.body.style.overflow = "hidden"; });
$("setClose").addEventListener("click", closeSet);
$("setReset").addEventListener("click", () => fillForm(DEFAULTS));
$("setSheet").addEventListener("click", e => { if (e.target.id === "setSheet") closeSet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeSet(); if (CH) closeChart(); } });
$("setForm").addEventListener("submit", e => {
  e.preventDefault();
  for (const k of KEYS) { const v = parseFloat($("s_" + k).value); if (isFinite(v) && v >= 0) CFG[k] = v; }
  store.set("awt.cfg", CFG);
  closeSet(); rerenderAll(); toast("Threshold disimpan");
});
let toastT = null;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 3000);
}

/* ============ IKUT setups: technical check for up to 60 minutes ============ */
const IK = { setups: new Map(), notified: new Set(), busy: false };
const IK_WINDOW = 60 * 60000;
function emaArr(v, n) { const a = 2 / (n + 1); let e = v[0]; return v.map(x => (e = x * a + e * (1 - a))); }
function rsiLast(c, n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function macdOf(c) {
  const e12 = emaArr(c, 12), e26 = emaArr(c, 26);
  const m = c.map((_, i) => e12[i] - e26[i]), sig = emaArr(m, 9), k = c.length - 1;
  return { macd: m[k], signal: sig[k], hist: m[k] - sig[k], prevHist: m[k - 1] - sig[k - 1] };
}
function levels(cs, price) {
  const piv = [];
  for (let i = 3; i < cs.length - 3; i++) {
    let hi = true, lo = true;
    for (let j = i - 3; j <= i + 3; j++) { if (cs[j].h > cs[i].h) hi = false; if (cs[j].l < cs[i].l) lo = false; }
    if (hi) piv.push(cs[i].h); if (lo) piv.push(cs[i].l);
  }
  piv.sort((a, b) => a - b);
  const zones = [];
  for (const p of piv) { const z = zones[zones.length - 1]; if (z && p / z.avg - 1 < 0.004) { z.sum += p; z.n++; z.avg = z.sum / z.n; } else zones.push({ sum: p, n: 1, avg: p }); }
  const lv = zones.map(z => z.avg);
  return { sup: lv.filter(x => x < price * 0.999).reverse().slice(0, 2), res: lv.filter(x => x > price * 1.001).slice(0, 2) };
}
function collectIkut() {
  const now = Date.now(), seen = new Map();
  for (const k in FEEDS) for (const s of FEEDS[k].items) {
    if (!s.reco || s.reco.verdict !== "IKUT" || now - s.t > IK_WINDOW + 15 * 60000) continue;
    if (s.dir !== "up" && s.dir !== "down") continue;
    const key = s.coin + ":" + (s.dir === "up" ? "LONG" : "SHORT");
    const g = seen.get(key) || { latest: s, ids: new Set() };
    g.ids.add(s.id); if (s.t > g.latest.t) g.latest = s;
    seen.set(key, g);
  }
  for (const [key, g] of seen) {
    const cur = IK.setups.get(key);
    if (cur && cur.sig.id === g.latest.id) { cur.count = g.ids.size; continue; }
    IK.setups.set(key, { key, side: key.endsWith("LONG") ? "LONG" : "SHORT", sig: g.latest, count: g.ids.size });
  }
  for (const k of [...IK.setups.keys()]) if (!seen.has(k)) IK.setups.delete(k);
}
async function evalSetup(x) {
  const s = x.sig, long = x.side === "LONG";
  const [c15, c1h] = await Promise.all([candles(s.mk, s.coin, "15m"), candles(s.mk, s.coin, "1h")]);
  if (!c15 || c15.length < 60) { x.err = "Data candle belum bisa diambil"; return; }
  x.err = null;
  const cl = c15.map(c => c.c), price = cl[cl.length - 1];
  const e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), rsi = rsiLast(cl), md = macdOf(cl);
  let h1 = null;
  if (c1h && c1h.length > 60) {
    const c = c1h.map(k => k.c), a20 = emaArr(c, 20), a50 = emaArr(c, 50), a200 = c.length >= 200 ? emaArr(c, 200) : null, p = c[c.length - 1], i = c.length - 1;
    const trend = p > a50[i] && a20[i] > a50[i] ? "Bullish" : p < a50[i] && a20[i] < a50[i] ? "Bearish" : "Netral";
    h1 = { trend, e20: a20[i], e50: a50[i], e200: a200 ? a200[i] : null, rsi: rsiLast(c), price: p };
  }
  const lv = levels(c15.slice(-150), price);
  const pl = s.reco.plan || {};
  const entry = pl.entry || s.price;
  let sl = pl.sl || (long ? entry * 0.98 : entry * 1.02);
  const near = long ? lv.sup.find(v => v < entry) : lv.res.find(v => v > entry);
  if (near) { const d = Math.abs(entry / near - 1); if (d >= 0.005 && d <= 0.05) sl = long ? near * 0.997 : near * 1.003; }
  const R = Math.abs(entry - sl);
  const tp1 = long ? entry + 1.5 * R : entry - 1.5 * R, tp2 = long ? entry + 2.5 * R : entry - 2.5 * R;
  const zLo = entry - 0.3 * R, zHi = entry + 0.3 * R;
  const wall = long ? lv.res[0] : lv.sup[0];
  const checks = long ? [
    [!h1 || h1.trend !== "Bearish", `Tren 1 jam ${h1 ? h1.trend : "belum ada data"} (tidak bearish)`],
    [price > e20[e20.length - 1], "Harga di atas EMA20 (15m)"],
    [md.hist > 0, `MACD 15m positif${md.hist > 0 && md.prevHist <= 0 ? " (baru cross naik)" : ""}`],
    [rsi != null && rsi >= 45 && rsi <= 70, `RSI 15m ${rsi == null ? "--" : rsi.toFixed(0)} di 45–70 (kuat, belum jenuh beli)`],
    [!wall || wall - price >= R, wall ? `Jarak ke resistance ${px(wall)} cukup (≥ 1R)` : "Tidak ada resistance dekat"]
  ] : [
    [!h1 || h1.trend !== "Bullish", `Tren 1 jam ${h1 ? h1.trend : "belum ada data"} (tidak bullish)`],
    [price < e20[e20.length - 1], "Harga di bawah EMA20 (15m)"],
    [md.hist < 0, `MACD 15m negatif${md.hist < 0 && md.prevHist >= 0 ? " (baru cross turun)" : ""}`],
    [rsi != null && rsi >= 30 && rsi <= 55, `RSI 15m ${rsi == null ? "--" : rsi.toFixed(0)} di 30–55 (lemah, belum jenuh jual)`],
    [!wall || price - wall >= R, wall ? `Jarak ke support ${px(wall)} cukup (≥ 1R)` : "Tidak ada support dekat"]
  ];
  const age = Date.now() - s.t;
  let st, why;
  if (age > IK_WINDOW) { st = "miss"; why = "KEDALUWARSA · lebih dari 60 menit"; }
  else if (long ? price <= sl : price >= sl) { st = "cancel"; why = "BATAL · stop loss tersentuh"; }
  else if (long ? price >= tp1 : price <= tp1) { st = "miss"; why = "TERLEWAT · sudah sampai TP1"; }
  else if (long ? price > zHi : price < zLo) { st = "miss"; why = "TERLEWAT · harga lari dari zona entry"; }
  else if (checks.every(c => c[0])) { st = "go"; why = "✓ BISA DIIKUTI SEKARANG"; }
  else { st = "wait"; why = `TUNGGU KONFIRMASI · ${checks.filter(c => !c[0]).length} syarat belum terpenuhi`; }
  const prev = x.st;
  Object.assign(x, { price, entry, sl, tp1, tp2, zLo, zHi, R, lv, rsi, md, e20: e20[e20.length - 1], e50: e50[e50.length - 1], h1, checks, st, why, at: Date.now() });
  if (st === "go" && prev !== "go") notifyIkut(x);
}
function notifyIkut(x) {
  if (IK.notified.has(x.sig.id)) return;
  IK.notified.add(x.sig.id);
  const body = `${x.side} ${x.sig.coin} · Entry ${px(x.zLo)}–${px(x.zHi)} · SL ${px(x.sl)} · TP1 ${px(x.tp1)}`;
  beep(x.side === "LONG");
  toast(`Bisa diikuti: ${body}`);
  notify(`✅ ${x.sig.coin} bisa diikuti (${x.side})`, body, "ik-" + x.sig.id);
}
function ladderHTML(x) {
  const pts = [x.sl, x.zLo, x.zHi, x.tp1, x.tp2, x.price];
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const pos = v => clamp((v - lo) / span * 100, 0, 100).toFixed(1);
  const long = x.side === "LONG";
  const slSide = long ? `left:0;width:${pos(x.zLo)}%` : `left:${pos(x.zHi)}%;right:0`;
  const tpSide = long ? `left:${pos(x.zHi)}%;width:${(pos(x.tp2) - pos(x.zHi)).toFixed(1)}%` : `left:${pos(x.tp2)}%;width:${(pos(x.zLo) - pos(x.tp2)).toFixed(1)}%`;
  return `<div class="ladder" aria-label="Posisi harga terhadap level">
    <div class="bar"><i style="${slSide};background:rgba(234,57,67,.45)"></i><i style="${tpSide};background:rgba(22,199,132,.45)"></i><i style="left:${pos(x.zLo)}%;width:${(pos(x.zHi) - pos(x.zLo)).toFixed(1)}%;background:#22d3ee"></i></div>
    ${[[x.sl, "SL"], [x.entry, "Entry"], [x.tp1, "TP1"], [x.tp2, "TP2"]].map(([v, t]) => `<span class="tick" style="left:${pos(v)}%"></span><span class="lab" style="left:${pos(v)}%">${t}</span>`).join("")}
    <span class="now" style="left:${pos(x.price)}%">${px(x.price)}</span>
  </div>`;
}
function ikutCard(x) {
  const s = x.sig, mins = Math.floor((Date.now() - s.t) / 60000);
  const head = `<div class="ik-h">${logo(s.coin, "lg")}<div class="id"><b>${esc(s.coin)}</b><span class="chip ${x.side === "LONG" ? "buy" : "sell"}">${x.side === "LONG" ? "▲ LONG" : "▼ SHORT"}</span><small>${EX[s.mk]} · ${mins} mnt lalu · ${wib(s.t)}</small></div>${ring(s.reco.score, 42)}</div>`;
  if (!x.at) return `<article class="ik wait">${head}<div class="foot">${x.err ? esc(x.err) : "Menghitung indikator…"}</div></article>`;
  const cls = x.st === "go" ? "go" : x.st === "wait" ? "wait" : "off";
  const fmtL = a => a.length ? a.map(px).join(" · ") : "--";
  const h1 = x.h1;
  const emaUp = x.e20 > x.e50;
  return `<article class="ik ${cls}">
  ${head}
  <div class="st ${x.st}">${esc(x.why)}</div>
  ${ladderHTML(x)}
  <div class="lv">
    <div class="e"><small>Zona entry</small><span>${px(x.zLo)} – ${px(x.zHi)}</span></div>
    <div class="s"><small>Stop loss</small><span>${px(x.sl)} (${pct(x.sl / x.entry - 1, 1)})</span></div>
    <div class="t"><small>TP1 · 1.5R</small><span>${px(x.tp1)} (${pct(x.tp1 / x.entry - 1, 1)})</span></div>
    <div class="t"><small>TP2 · 2.5R</small><span>${px(x.tp2)} (${pct(x.tp2 / x.entry - 1, 1)})</span></div>
    <div><small>Support</small><span>${fmtL(x.lv.sup)}</span></div>
    <div><small>Resistance</small><span>${fmtL(x.lv.res)}</span></div>
  </div>
  <div class="ind">
    <div><small>Tren 1 jam</small><span class="${h1 && h1.trend === "Bullish" ? "up" : h1 && h1.trend === "Bearish" ? "down" : "flat"}">${h1 ? (h1.trend === "Bullish" ? "▲ " : h1.trend === "Bearish" ? "▼ " : "■ ") + h1.trend : "--"}</span></div>
    <div><small>RSI 14 · 15m</small><span>${x.rsi == null ? "--" : x.rsi.toFixed(0)}${h1 && h1.rsi != null ? ` <span style="color:var(--muted);font-size:11px">1j ${h1.rsi.toFixed(0)}</span>` : ""}</span>${x.rsi == null ? "" : `<div class="meter"><i style="left:${clamp(x.rsi, 0, 100)}%"></i></div>`}</div>
    <div><small>MACD 15m</small><span class="${x.md.hist >= 0 ? "up" : "down"}">${x.md.hist >= 0 ? "▲ Positif" : "▼ Negatif"}${(x.md.hist > 0) !== (x.md.prevHist > 0) ? " · cross" : ""}</span></div>
    <div><small>EMA 15m 20/50</small><span class="${emaUp ? "up" : "down"}">${emaUp ? "20 > 50 ▲" : "20 < 50 ▼"}</span></div>
    <div><small>EMA 1j 20/50/200</small><span style="font-size:11.5px">${h1 ? `${px(h1.e20)} / ${px(h1.e50)} / ${h1.e200 ? px(h1.e200) : "--"}` : "--"}</span></div>
    <div><small>Leverage · risiko</small><span>${(s.reco.plan && s.reco.plan.lev) || 3}x · 1% modal</span></div>
  </div>
  <ul class="checks">${x.checks.map(([ok, t]) => `<li class="${ok ? "ok" : "no"}">${esc(t)}</li>`).join("")}</ul>
  <div class="acts"><button type="button" class="pri" data-ikchart="${esc(x.key)}">Chart + level</button><button type="button" data-ask="${s.id}">Tanya Claude</button></div>
</article>`;
}
const ikRank = { go: 0, wait: 1, miss: 2, cancel: 3 };
const ikSorted = () => [...IK.setups.values()].sort((a, b) => (ikRank[a.st] ?? 1) - (ikRank[b.st] ?? 1) || b.sig.t - a.sig.t);
function renderIkut() {
  const list = ikSorted(), go = list.filter(x => x.st === "go").length;
  const badge = $("ikBadge"); badge.hidden = !go; badge.textContent = go;
  if (VIEW === "home") renderHomeIk();
  if (VIEW !== "ikut") return;
  $("ikList").innerHTML = list.length ? list.map(ikutCard).join("")
    : `<article class="panel"><div class="empty">Belum ada sinyal IKUT dalam 60 menit terakhir. Profil konservatif membuat IKUT jarang muncul, biarkan dashboard terbuka.</div></article>`;
}
async function ikutLoop() {
  if (IK.busy) return;
  IK.busy = true;
  try {
    collectIkut();
    for (const x of IK.setups.values()) { try { await evalSetup(x); } catch { x.err = "Gagal menghitung indikator"; } }
    renderIkut();
  } finally { IK.busy = false; }
}

/* ============ history & recap (24/7 recordings from GitHub Actions) ============ */
// HEAD = the repo's default branch, which is where the scheduled recorder commits its data
const REPO_RAW = "https://raw.githubusercontent.com/adhiyudho-lang/Hello/HEAD/";
const HIST = { index: null, items: [], date: null, shown: 120, loaded: false };
const dayName = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", weekday: "short", day: "numeric", month: "short" });
const dLabel = d => dayName.format(new Date(d + "T12:00:00+07:00"));
const hourWIB = t => new Date(t + 7 * 3600e3).getUTCHours();
const dateKey = t => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
async function fetchData(rel) {
  for (const url of [REPO_RAW + rel, rel + "?t=" + Date.now()]) {
    try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return await r.json(); } catch {}
  }
  throw new Error("Data rekaman tidak bisa dibuka");
}
function outcomeHTML(s) {
  if (s.dir !== "up" && s.dir !== "down") return "";
  const cells = [1, 4, 24].map(h => {
    const r = s.o ? s.o[h] : undefined;
    if (r === undefined) return `<span class="oc">${h}j menunggu</span>`;
    if (r === null) return `<span class="oc">${h}j n/a</span>`;
    const ok = (s.dir === "up" ? r : -r) > 0;
    return `<span class="oc ${ok ? "ok" : "bad"}">${h}j ${pct(r)} ${ok ? "✓" : "✗"}</span>`;
  }).join("");
  return `<div class="outcome"><em>Hasil harga</em>${cells}</div>`;
}
function accOf(items, verdict) {
  const out = {};
  for (const h of [1, 4, 24]) {
    let w = 0, n = 0, sum = 0;
    for (const s of items) {
      if (verdict && s.reco.verdict !== verdict) continue;
      const r = s.o && s.o[h];
      if (r == null || (s.dir !== "up" && s.dir !== "down")) continue;
      const dr = s.dir === "up" ? r : -r; n++; sum += dr; if (dr > 0) w++;
    }
    out[h] = { w, n, sum };
  }
  return out;
}
const accTxt = a => a && a.n ? `${Math.round(a.w / a.n * 100)}%` : "--";
const accSub = a => a && a.n ? `rata-rata ${pct(a.sum / a.n)} · ${a.n}` : "belum ada";
async function ensureIndex() {
  if (HIST.loaded) return HIST.index;
  try { HIST.index = await fetchData("data/index.json"); } catch { HIST.index = null; }
  HIST.loaded = true;
  return HIST.index;
}
function noDataMsg() {
  if (!HIST.index) return "Data rekaman belum bisa dibuka. Pastikan repo public dan perekam GitHub Actions aktif.";
  return "Belum ada rekaman. Perekam berjalan tiap jam lewat GitHub Actions; data pertama muncul ±1 jam setelah aktif.";
}
async function openHist(date) {
  const idx = await ensureIndex();
  const days = (idx && idx.days) || [];
  const d = date || HIST.date || (days[0] && days[0].date);
  $("hDates").innerHTML = days.map(x => `<button class="dt" data-date="${x.date}" aria-pressed="${x.date === d}"><b>${dLabel(x.date)}</b><small>${(x.n.whale || 0) + (x.n.liq || 0) + (x.n.signal || 0)} sinyal · ${x.ikut || 0} IKUT</small></button>`).join("");
  if (!d) { $("hStats").innerHTML = ""; $("hList").innerHTML = `<div class="empty">${noDataMsg()}</div>`; return; }
  if (HIST.date !== d) {
    $("hList").innerHTML = `<div class="empty">Memuat ${dLabel(d)}…</div>`;
    try {
      const day = await fetchData(`data/days/${d}.json`);
      HIST.items = (day.items || []).filter(s => s && s.reco).sort((a, b) => b.t - a.t);
      HIST.date = d;
    } catch { $("hList").innerHTML = `<div class="empty">Gagal memuat ${dLabel(d)}. Coba lagi nanti.</div>`; return; }
  }
  HIST.shown = 120;
  renderHist();
}
$("hDates").addEventListener("click", e => { const b = e.target.closest("[data-date]"); if (b) openHist(b.dataset.date); });
function histFiltered() {
  const from = +$("hFrom").value, to = +$("hTo").value, type = $("hType").value, verdict = $("hVerdict").value, ex = $("hEx").value;
  const q = $("hCoin").value.trim().toUpperCase();
  return HIST.items.filter(s => {
    const h = hourWIB(s.t);
    if (h < from || h > to) return false;
    if (type !== "all" && s.f !== type) return false;
    if (verdict !== "all" && s.reco.verdict !== verdict) return false;
    if (ex !== "all" && s.mk !== ex) return false;
    if (q && !s.coin.includes(q)) return false;
    return true;
  });
}
function renderHist() {
  const list = histFiltered(), ikut = list.filter(s => s.reco.verdict === "IKUT"), a = accOf(ikut);
  const tile = (w, label, val, sub) => `<div class="tile ${w}"><div class="tx"><b>${val}</b><small>${label}${sub ? ` · ${sub}` : ""}</small></div></div>`;
  $("hStats").innerHTML = tile("w3", "sinyal", list.length, `dari ${HIST.items.length}`) + tile("w3", "saran IKUT", ikut.length, "") +
    [1, 4, 24].map(h => tile("w2", `IKUT tepat ${h}j`, accTxt(a[h]), a[h].n ? `${a[h].n} sinyal` : "")).join("");
  const box = $("hList");
  if (!list.length) { box.innerHTML = `<div class="empty">Tidak ada sinyal untuk filter ini.</div>`; return; }
  box.innerHTML = list.slice(0, HIST.shown).map(s => cardHTML(s, false, true)).join("") +
    (list.length > HIST.shown ? `<button type="button" class="btn ghost morebtn" id="hMore">Tampilkan lagi (sisa ${list.length - HIST.shown})</button>` : "");
  observeSparks(box);
  const more = $("hMore"); if (more) more.addEventListener("click", () => { HIST.shown += 120; renderHist(); });
}
async function openRekap() {
  const idx = await ensureIndex(), days = (idx && idx.days) || [];
  if (!days.length) { $("sumNote").innerHTML = `<div class="empty">${noDataMsg()}</div>`; $("accBox").innerHTML = ""; $("dayBox").innerHTML = ""; return; }
  $("sumNote").innerHTML = `<div class="foot" style="font-size:12.5px;color:var(--muted)">Rekaman 24 jam dari <b style="color:var(--fg)">Binance Spot</b> dan <b style="color:var(--fg)">OKX</b> dengan threshold default, disimpan ${idx.keepDays || 30} hari. Update terakhir <b style="color:var(--fg)">${dLabel(dateKey(idx.updated))} ${wib(idx.updated)}</b>.</div>`;
  const tot = {};
  for (const d of days) for (const v in d.acc || {}) for (const h in d.acc[v]) {
    const a = ((tot[v] = tot[v] || {})[h] = tot[v][h] || { w: 0, n: 0, sum: 0 });
    a.w += d.acc[v][h].w; a.n += d.acc[v][h].n; a.sum += d.acc[v][h].sum;
  }
  const desc = { IKUT: "Saran ikut whale", TUNGGU: "Tunggu konfirmasi", HINDARI: "Jangan ikut", INFO: "Hanya informasi" };
  $("accBox").innerHTML = ["IKUT", "TUNGGU", "HINDARI", "INFO"].map(v => `<article class="panel${v === "IKUT" ? " glow" : ""}">
    <div style="display:flex;align-items:center;gap:8px"><span class="pill ${v}">${v}</span><span class="foot">${desc[v]}</span></div>
    <div class="rings">${pctRing(tot[v] && tot[v][1], "1 jam")}${pctRing(tot[v] && tot[v][4], "4 jam")}${pctRing(tot[v] && tot[v][24], "24 jam")}</div>
    <div class="foot">% sinyal yang harganya bergerak sesuai arah. ${tot[v] && tot[v][4] && tot[v][4].n ? `Rata-rata 4 jam ${pct(tot[v][4].sum / tot[v][4].n)}.` : ""}</div>
  </article>`).join("");
  $("dayBox").innerHTML = days.map(d => {
    const L = d.liq ? d.liq.L : 0, S = d.liq ? d.liq.S : 0, t = L + S || 1, a4 = d.acc && d.acc.IKUT && d.acc.IKUT[4];
    return `<button class="day" data-day="${d.date}">
      <div class="day-h"><b>${dLabel(d.date)}</b><span class="fg" style="color:${d.fng == null ? "var(--muted)" : fngColor(d.fng)}">F&amp;G ${d.fng == null ? "--" : d.fng}</span></div>
      <div><div class="foot">Likuidasi long <span class="up">${usd(L)}</span> · short <span class="down">${usd(S)}</span></div><div class="lsbar"><i style="width:${L / t * 100}%;background:var(--buy)"></i><i style="width:${S / t * 100}%;background:var(--sell)"></i></div></div>
      <div class="day-c"><span class="chip dim">Whale ${d.n.whale || 0}</span><span class="chip dim">Likuidasi ${d.n.liq || 0}</span><span class="chip dim">Pump/Dump ${d.n.signal || 0}</span><span class="chip buy">IKUT ${d.ikut || 0}</span><span class="chip dim">IKUT tepat 4j ${accTxt(a4)}</span></div>
      <div class="day-top">Paling sering: ${(d.top || []).slice(0, 4).map(([c, n]) => `${logo(c, "sm")}<span>${esc(c)} ${n}×</span>`).join(" ")}</div>
    </button>`;
  }).join("");
}
$("dayBox").addEventListener("click", e => { const b = e.target.closest("[data-day]"); if (b) showView("hist", b.dataset.day); });
for (const id of ["hFrom", "hTo"]) $(id).innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${id === "hFrom" ? "Dari" : "s/d"} ${String(h).padStart(2, "0")}.00</option>`).join("");
$("hTo").value = "23";
for (const id of ["hFrom", "hTo", "hType", "hVerdict", "hEx"]) $(id).addEventListener("change", () => { HIST.shown = 120; renderHist(); });
$("hCoin").addEventListener("input", () => { HIST.shown = 120; renderHist(); });

/* ============ navigation ============ */
const VIEWS = { home: "v-home", sig: "v-sig", ikut: "v-ikut", brief: "v-brief", hist: "v-hist", rekap: "v-rekap" };
const HASH = { home: "", sig: "sinyal", ikut: "ikut", brief: "brief", hist: "riwayat", rekap: "ringkasan" };
function showView(v, date) {
  VIEW = v;
  for (const k in VIEWS) $(VIEWS[k]).hidden = k !== v;
  for (const b of document.querySelectorAll(".nb")) { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }
  try { history.replaceState(null, "", HASH[v] ? "#" + HASH[v] : location.pathname); } catch {}
  window.scrollTo(0, 0);
  if (v === "home") { renderHomeIk(); renderLatest(); heatAt = 0; renderHeat(); }
  if (v === "sig") observeSparks($("v-sig"));
  if (v === "ikut") renderIkut();
  if (v === "hist") openHist(date);
  if (v === "rekap") openRekap();
  if (v === "brief" && typeof openBrief === "function") openBrief();
}
document.querySelectorAll(".nb").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));

/* ============ loops & boot ============ */
setInterval(() => {
  $("clock").textContent = wib(Date.now());
  renderTicker();
  if (VIEW === "home") { renderStats(); renderHeat(); if (dirtyHome) { renderLatest(); dirtyHome = false; } }
  if (dirtySave) { saveHistory(); dirtySave = false; }
  for (const k in FEEDS) { const box = $(FEEDS[k].el); if (box.querySelector(".empty")) box.innerHTML = emptyHTML(k); }
}, 1000);
setInterval(ikutLoop, 30000);
setTimeout(ikutLoop, 3000);

loadHistory();
setFeed(FEEDS[UI.feed] ? UI.feed : "whale");
rerenderAll();
const initial = Object.keys(HASH).find(k => HASH[k] && "#" + HASH[k] === location.hash) || "home";
showView(initial);
renderHomeIk();
loadFng(); setInterval(loadFng, 30 * 60000);
loadBtcTrend(); setInterval(loadBtcTrend, 5 * 60000);
loadFunding(); setInterval(loadFunding, 60000);
okxInstruments().then(() => { okxTickers(); setInterval(okxTickers, 10000); });
