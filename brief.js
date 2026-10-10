/* Crypto ETF Weekly Brief view. Reads data/brief.json (synced weekly from the claude.ai
   artifact), data/etf.json (spot ETF flows per coin + BTC issuers, refreshed hourly by the
   recorder) and data/fundamental.json (Adhi's fundamental framework scores).
   Tones: up = green, down = red, flat = grey, swing = amber. Uses helpers from app.js. */
"use strict";
const BF = { data: null, etf: null, fund: null, tab: store.get("awt.bf", "ringkasan"), at: 0, charts: [], layers: store.get("awt.bfLayers", { sr: true, fib: false, main: true, alt: false }) };
const TONE_ICON = { up: "▲", down: "▼", flat: "■", swing: "⇅" };
const tchip = (tone, text) => `<span class="chip ${tone || "flat"}">${TONE_ICON[tone] || "■"} ${esc(text)}</span>`;
const idn = (v, d = 2) => (v > 0 ? "+" : "") + Number(v).toFixed(d).replace(".", ",") + "%";
const tPct = v => `<span class="num tone-${v > 0 ? "up" : v < 0 ? "down" : "flat"}">${v > 0 ? "▲" : v < 0 ? "▼" : "■"} ${idn(v)}</span>`;
const rp = n => Number(n).toLocaleString("id-ID", { maximumFractionDigits: 0 });
const mUsd = v => Math.abs(v) < 0.05 ? "0" : (v > 0 ? "+" : "−") + "$" + Math.abs(v).toLocaleString("id-ID", { maximumFractionDigits: 1 }) + " jt";
const fUsd = v => { const a = Math.abs(v); return Math.abs(v) < 5e4 ? "0" : (v > 0 ? "+" : "−") + "$" + (a >= 1e9 ? (a / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 }) + " miliar" : (a / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 }) + " jt"); };

/* numbers in the brief are written Indonesian-style: "2.405" = 2405, "105,6" = 105.6, "74,9k" = 74900 */
function idNum(s) {
  s = String(s).trim();
  let k = 1;
  if (/k$/i.test(s)) { k = 1000; s = s.slice(0, -1); }
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const v = parseFloat(s) * k;
  return isFinite(v) ? v : null;
}
// "105,6–106,2 · 101,8" -> [{lo:105.6, hi:106.2}, {lo:101.8, hi:101.8}]
function idLevels(str) {
  return String(str || "").split("·").map(part => {
    const [a, b] = part.split(/[–-]/).map(x => idNum(x));
    return a == null ? null : { lo: Math.min(a, b ?? a), hi: Math.max(a, b ?? a) };
  }).filter(Boolean);
}

async function openBrief(force) {
  if (force || !BF.data || Date.now() - BF.at > 10 * 60000) {
    $("bfHead").innerHTML = `<div class="empty">Memuat Crypto ETF Weekly Brief…</div>`;
    try {
      const [d, e, f] = await Promise.all([fetchData("data/brief.json"), fetchData("data/etf.json").catch(() => null), fetchData("data/fundamental.json").catch(() => null)]);
      BF.data = d; BF.etf = e; BF.fund = f; BF.at = Date.now();
    } catch {}
  }
  renderBrief();
}

function killCharts() { for (const c of BF.charts) { try { c.remove(); } catch {} } BF.charts = []; }

function etfLastDate() {
  const a = BF.etf && BF.etf.assets && BF.etf.assets.BTC;
  return a && a.days.length ? a.days[a.days.length - 1].date : null;
}
function renderBrief() {
  killCharts();
  if (!BF.data) {
    $("bfHead").innerHTML = `<div class="empty">Data brief belum ada. Brief disinkronkan otomatis tiap Sabtu pagi; coba muat ulang nanti.</div><div class="bf-tools"><button class="pri" data-bfreload>Muat ulang</button></div>`;
    $("bfBody").innerHTML = "";
    return;
  }
  const D = BF.data, ld = etfLastDate();
  $("bfHead").innerHTML = `
    <div class="k">Crypto ETF Weekly Brief</div>
    <h1>Minggu ${esc(D.period)}</h1>
    <div class="bf-meta"><span>Snapshot <b>${esc(D.snapshot)}</b></span><span>${esc(D.source)}</span>${ld ? `<span>Arus ETF <b>CoinMarketCap</b> · s/d ${dLabel(ld)}</span>` : ""}</div>
    <div class="legend2">${tchip("up", "Naik · Beli · Long")}${tchip("down", "Turun · Jual · Short")}${tchip("flat", "Netral · Tahan")}${tchip("swing", "Dua arah")}</div>
    <div class="bf-tools"><button data-bfreload>Muat ulang</button><a class="pri" href="${esc(D.artifact || "https://claude.ai/artifact/SDiCExUkGBn94iuhEyqmEK")}" target="_blank" rel="noopener">Buka versi lengkap ↗</a></div>`;
  for (const b of $("bfTabs").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.bf === BF.tab);
  const R = { ringkasan: bfRingkasan, etf: bfEtf, event: bfEvent, pengingat: bfPengingat, teknikal: bfTeknikal, altcoin: bfAltcoin, aksi: bfAksi }[BF.tab] || bfRingkasan;
  try { $("bfBody").innerHTML = R(D); }
  catch (e) { console.warn(e); $("bfBody").innerHTML = `<div class="empty">Bagian ini tidak bisa ditampilkan karena format data berubah. Buka versi lengkap di artifact.</div>`; return; }
  if (BF.tab === "teknikal") mountBtcChart(D);
  if (BF.tab === "altcoin") mountAltCharts(D);
}

$("bfTabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-bf]"); if (!b) return;
  BF.tab = b.dataset.bf; store.set("awt.bf", BF.tab); renderBrief();
});
document.addEventListener("click", e => {
  if (e.target.closest("[data-bfreload]")) { openBrief(true); return; }
  const g = e.target.closest("[data-bfgo]");
  if (g) { BF.tab = g.dataset.bfgo; store.set("awt.bf", BF.tab); renderBrief(); window.scrollTo(0, 0); return; }
  const ly = e.target.closest("[data-layer]");
  if (ly) { BF.layers[ly.dataset.layer] = !BF.layers[ly.dataset.layer]; store.set("awt.bfLayers", BF.layers); ly.setAttribute("aria-pressed", BF.layers[ly.dataset.layer]); if (BF.btcSeries) applyBtcLayers(); return; }
  const c = e.target.closest("[data-copy]");
  if (c) {
    const done = () => { c.textContent = "Tersalin ✓"; setTimeout(() => (c.textContent = "Salin"), 1600); };
    try { navigator.clipboard.writeText(c.dataset.copy).then(done, () => toast("Salin tidak didukung. Tekan lama teks di atas untuk menyalin.")); }
    catch { toast("Salin tidak didukung. Tekan lama teks di atas untuk menyalin."); }
  }
});

/* ---------- shared chart helper ---------- */
function makeCandleChart(el, cs, height) {
  const chart = LightweightCharts.createChart(el, {
    autoSize: true, height,
    layout: { background: { color: "#0c1526" }, textColor: "#8a9bb8", fontFamily: "IBM Plex Mono, monospace", fontSize: 10 },
    grid: { vertLines: { color: "#132039" }, horzLines: { color: "#132039" } },
    rightPriceScale: { borderColor: "#1b2945" },
    timeScale: { borderColor: "#1b2945", tickMarkFormatter: t => df.format(new Date(t * 1000)) },
    localization: { locale: "id-ID", timeFormatter: t => df.format(new Date(t * 1000)) },
    handleScroll: { vertTouchDrag: false }, crosshair: { mode: 0 }
  });
  const last = cs[cs.length - 1].c, prec = last >= 1000 ? 0 : last >= 100 ? 2 : last >= 1 ? 3 : 4;
  const s = chart.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", borderVisible: false, wickUpColor: "#16c784", wickDownColor: "#ea3943", priceFormat: { type: "price", precision: prec, minMove: Math.pow(10, -prec) } });
  s.setData(cs.map(c => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c })));
  BF.charts.push(chart);
  return { chart, s };
}
const noLib = el => { el.innerHTML = `<div class="empty">Library chart gagal dimuat.</div>`; };

/* ---------- ETF / ETP accumulation model ---------- */
function etfMetrics(sym) {
  const a = BF.etf && BF.etf.assets && BF.etf.assets[sym];
  if (!a || a.days.length < 5) return null;
  const d = a.days, last = d[d.length - 1], t0 = Date.parse(last.date);
  const since = n => d.filter(x => Date.parse(x.date) > t0 - n * 86400e3);
  const sum = n => since(n).reduce((s, x) => s + x.flow, 0);
  const priceAgo = n => { let p = d[0].price; for (const x of d) if (Date.parse(x.date) <= t0 - n * 86400e3) p = x.price; return p; };
  const prev = d[d.length - 2];
  const m = {
    sym, days: d, last,
    f1: last.flow, f7: sum(7), f30: sum(30),
    p1: prev ? last.price / prev.price - 1 : 0, p7: last.price / priceAgo(7) - 1, p30: last.price / priceAgo(30) - 1
  };
  const recent = d.slice(-60), avg = recent.reduce((s, x) => s + Math.abs(x.flow), 0) / recent.length || 1;
  // score 1-100 for a 2-3 year accumulation horizon: sustained net inflow pushes it up,
  // inflow while price falls (institutions buying the dip) adds more, outflow into strength subtracts
  let sc = 50 + 25 * clamp(m.f30 / (avg * 20), -1, 1) + 15 * clamp(m.f7 / (avg * 5), -1, 1);
  if (m.f30 > 0 && m.p30 <= 0) sc += 10;
  if (m.f30 < 0 && m.p30 >= 0) sc -= 10;
  if (m.p30 < -0.1) sc += 5;
  m.score = Math.round(clamp(sc, 1, 100));
  m.phase = m.f30 > 0 ? (m.p30 > 0 ? "acc" : "hidden") : (m.p30 > 0 ? "risk" : "dist");
  return m;
}
const PHASE = {
  acc: { label: "Akumulasi", tone: "up", why: "Dana institusi masuk dan harga ikut naik." },
  hidden: { label: "Akumulasi tersembunyi", tone: "up", why: "Dana institusi masuk walau harga turun/datar: ada yang mengumpulkan di harga murah." },
  risk: { label: "Risiko distribusi", tone: "swing", why: "Harga naik tapi dana keluar: rally kurang didukung institusi." },
  dist: { label: "Distribusi", tone: "down", why: "Dana keluar dan harga turun: institusi sedang mengurangi." }
};
function etfAdvice(sc) {
  if (sc >= 70) return "Saatnya akumulasi bertahap (DCA mingguan) untuk horizon 2–3 tahun.";
  if (sc >= 55) return "Cicil pelan-pelan; arus institusi mulai mendukung.";
  if (sc >= 40) return "Netral: lanjutkan DCA rutin kecil, jangan tambah besar.";
  if (sc >= 25) return "Tahan posisi, tunda pembelian besar sampai arus ETF berbalik masuk.";
  return "Jangan tambah dulu; institusi sedang keluar. Tunggu outflow mereda.";
}
function bigRing(score, size = 84) {
  const r = 32, c = 2 * Math.PI * r, col = score >= 70 ? "#16c784" : score >= 55 ? "#93d14f" : score >= 40 ? "#f3ba2f" : score >= 25 ? "#f0883d" : "#ea3943";
  return `<svg width="${size}" height="${size}" viewBox="0 0 80 80" role="img" aria-label="Skor ${score} dari 100" style="flex:none"><circle cx="40" cy="40" r="${r}" fill="none" stroke="#1b2945" stroke-width="8"/><circle cx="40" cy="40" r="${r}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(score / 100 * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)" style="filter:drop-shadow(0 0 6px ${col}88)"/><text x="40" y="44" text-anchor="middle" font-size="20" font-weight="700" fill="#e7eef8" font-family="IBM Plex Mono, monospace">${score}</text><text x="40" y="58" text-anchor="middle" font-size="8" fill="#8a9bb8">/100</text></svg>`;
}
function flowPriceSvg(days) {
  const d = days.slice(-30), W = 600, H = 170, P = 8, base = 120;
  const mx = Math.max(1, ...d.map(x => Math.abs(x.flow)));
  const lo = Math.min(...d.map(x => x.price)), hi = Math.max(...d.map(x => x.price)), sp = hi - lo || 1;
  const bw = (W - P * 2) / d.length;
  const bars = d.map((x, i) => {
    const h = Math.abs(x.flow) / mx * 48, up = x.flow >= 0, X = P + i * bw + bw * 0.18;
    return `<rect x="${X.toFixed(1)}" y="${(up ? base - h : base).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5" fill="${up ? "#16c784" : "#ea3943"}" opacity=".85"><title>${x.date}: ${fUsd(x.flow)}</title></rect>`;
  }).join("");
  const py = v => 10 + 52 * (1 - (v - lo) / sp);
  const line = d.map((x, i) => `${i ? "L" : "M"}${(P + i * bw + bw / 2).toFixed(1)} ${py(x.price).toFixed(1)}`).join(" ");
  const lab = i => `<text x="${(P + i * bw + bw / 2).toFixed(1)}" y="${H - 2}" fill="#56688a" font-size="10" text-anchor="middle">${d[i].date.slice(8)}/${d[i].date.slice(5, 7)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:170px;display:block" role="img" aria-label="Arus ETF harian dan harga">
    <line x1="${P}" x2="${W - P}" y1="${base}" y2="${base}" stroke="#2a3a5a" vector-effect="non-scaling-stroke"/>${bars}
    <path d="${line}" fill="none" stroke="#22d3ee" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${[0, Math.floor(d.length / 2), d.length - 1].map(lab).join("")}
  </svg>`;
}
function etfCard(m) {
  const ph = PHASE[m.phase];
  const row = (k, f, p) => `<tr><td>${k}</td><td class="n tone-${f > 0 ? "up" : f < 0 ? "down" : "flat"}">${fUsd(f)}</td><td class="n">${tPct(p * 100)}</td></tr>`;
  return `<article class="bf-card t-${ph.tone}">
    <div style="display:flex;align-items:center;gap:12px">${logo(m.sym, "lg")}<div style="flex:1;min-width:0"><b style="font-size:17px">${m.sym} ETF/ETP</b><div style="margin-top:4px">${tchip(ph.tone, ph.label)}</div></div>${bigRing(m.score)}</div>
    <p>${ph.why}</p>
    ${flowPriceSvg(m.days)}
    <div class="legend"><span><i style="background:#16c784"></i>Inflow</span><span><i style="background:#ea3943"></i>Outflow</span><span><i style="background:#22d3ee"></i>Harga ${m.sym}</span><span>${m.days.slice(-30).length} hari bursa</span></div>
    <table class="tbl"><thead><tr><th>Periode</th><th style="text-align:right">Arus ETF</th><th style="text-align:right">Harga</th></tr></thead><tbody>
      ${row("24 jam", m.f1, m.p1)}${row("7 hari", m.f7, m.p7)}${row("30 hari", m.f30, m.p30)}
    </tbody></table>
    <div class="lane ${m.score >= 55 ? "up" : m.score < 40 ? "down" : ""}" style="${m.score >= 40 && m.score < 55 ? "background:var(--warn-bg)" : ""}"><em>Saran 2–3 thn</em><span>${etfAdvice(m.score)}</span></div>
  </article>`;
}
function bfEtf() {
  const ms = ["BTC", "ETH", "SOL"].map(etfMetrics).filter(Boolean);
  if (!ms.length) return `<div class="empty">Data arus ETF belum tersedia. Perekam GitHub Actions mengambilnya dari CoinMarketCap setiap jam.</div>`;
  const iss = BF.etf.issuers && BF.etf.issuers.BTC;
  let issHtml = "";
  if (iss && iss.days.length) {
    const days = iss.days.slice(-30), last = days[days.length - 1], sums = {};
    for (const d of days) for (const f in d.by) sums[f] = (sums[f] || 0) + d.by[f];
    const rows = Object.entries(sums).filter(([, v]) => Math.abs(v) >= 0.05).sort((a, b) => b[1] - a[1]);
    issHtml = `<article class="bf-card"><div class="k">ETF Bitcoin per penerbit · ${days.length} hari bursa</div>
      <table class="tbl"><thead><tr><th>ETF</th><th style="text-align:right">Total</th><th style="text-align:right">${dLabel(last.date)}</th></tr></thead><tbody>
      ${rows.map(([f, v]) => `<tr><td><b>${esc(f)}</b></td><td class="n tone-${v >= 0 ? "up" : "down"}">${mUsd(v)}</td><td class="n tone-${(last.by[f] || 0) > 0 ? "up" : (last.by[f] || 0) < 0 ? "down" : "flat"}">${last.by[f] == null ? "--" : mUsd(last.by[f])}</td></tr>`).join("")}
      </tbody></table><div class="foot">Sumber bitbo.io</div></article>`;
  }
  return `<div class="bf-grid">${ms.map(etfCard).join("")}</div>
  ${issHtml}
  <article class="bf-card"><div class="k">Cara membaca skor (1–100)</div>
    <ul>
      <li><b class="tone-up">Akumulasi</b>: arus 30 hari masuk dan harga naik.</li>
      <li><b class="tone-up">Akumulasi tersembunyi</b>: arus masuk saat harga turun. Biasanya peluang terbaik untuk horizon 2–3 tahun.</li>
      <li><b class="tone-swing">Risiko distribusi</b>: harga naik tapi dana keluar.</li>
      <li><b class="tone-down">Distribusi</b>: dana keluar dan harga turun.</li>
      <li>Skor menimbang besar arus 30 hari dan 7 hari dibanding rata-rata 60 hari, plus bonus/penalti selisih arah arus vs harga. ≥70 akumulasi, 55–69 cicil pelan, 40–54 netral, &lt;40 tahan/tunda.</li>
    </ul>
    <div class="foot">Sumber arus harian: CoinMarketCap ETF (BTC, ETH, SOL) · update ${BF.etf.updated ? wib(BF.etf.updated) : "--"}. Bukan nasihat keuangan.</div>
  </article>`;
}

/* ---------- Ringkasan ---------- */
function biasHTML(b) {
  const pos = clamp((b.score + 100) / 2, 0, 100), tone = b.score > 15 ? "up" : b.score < -15 ? "down" : "flat";
  return `<div class="bias">
    <div style="display:flex;align-items:baseline;gap:10px"><span class="bf-big tone-${tone}" style="font-size:28px">${b.score > 0 ? "+" : ""}${b.score}</span><b class="tone-${tone}" style="font-size:16px">${esc(b.label)}</b></div>
    <div class="track" role="img" aria-label="Bias ${b.score} dari -100 sampai 100"><span class="pin" style="left:${pos}%"></span></div>
    <div class="ends"><span class="tone-down">◀ Short −100</span><span>0</span><span class="tone-up">Long +100 ▶</span></div>
  </div>`;
}
function bfRingkasan(D) {
  const B = D.btc, pos = clamp((B.price - B.lo50) / (B.hi50 - B.lo50) * 100, 0, 100);
  const ms = ["BTC", "ETH", "SOL"].map(etfMetrics).filter(Boolean);
  return `<div class="bf-grid">
    <article class="bf-card glow">
      <div style="display:flex;align-items:center;gap:10px">${logo("BTC", "lg")}<div><b style="font-size:16px">Bitcoin</b><div class="foot">Harga snapshot</div></div></div>
      <div class="bf-big">$${rp(B.price)}</div>
      <div style="display:flex;gap:14px;font-size:13px"><span><span class="k">7H</span> ${tPct(B.d7)}</span><span><span class="k">30H</span> ${tPct(B.d30)}</span></div>
      <div class="rng"><div class="k">Posisi di range 50 hari</div><div class="track"><span class="dot" style="left:${pos}%"></span></div><div class="ends"><span>Low ${rp(B.lo50)}</span><span>High ${rp(B.hi50)}</span></div></div>
    </article>
    <article class="bf-card"><div class="k">Bias pasar minggu ini</div>${biasHTML(D.bias)}<p>${esc(D.bias.note)}</p></article>
    ${ms.length ? `<article class="bf-card"><div class="k">Skor akumulasi ETF · 2–3 tahun</div>
      ${ms.map(m => `<div style="display:flex;align-items:center;gap:10px">${logo(m.sym, "sm")}<b style="width:38px">${m.sym}</b><span class="chip ${PHASE[m.phase].tone}" style="flex:1;justify-content:center">${PHASE[m.phase].label}</span><b class="num" style="width:32px;text-align:right">${m.score}</b></div>`).join("")}
      <button class="copyb" data-bfgo="etf">Lihat arus ETF ›</button></article>` : ""}
  </div>
  <div class="bf-grid">${(D.summary || []).map(s => `<article class="bf-card t-${s.tone}"><h3><span class="tone-${s.tone}">${TONE_ICON[s.tone] || "■"}</span>${esc(s.title)}</h3><p>${esc(s.text)}</p></article>`).join("")}</div>`;
}

/* ---------- Event ---------- */
function bfEvent(D) {
  return `<div class="bf-grid">${D.events.map(e => `<article class="bf-card t-${e.tone}${e.upcoming ? " dashed" : ""}">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="when">${esc(e.date)} · ${e.time === "—" ? "sepanjang hari" : esc(e.time) + " WIB"}</span>${e.upcoming ? `<span class="chip swing">🔔 Akan datang</span>` : ""}<span class="chip dim" style="margin-left:auto">${esc(e.scope)}</span></div>
    <h3><span class="tone-${e.tone}">${TONE_ICON[e.tone] || "■"}</span>${esc(e.title)}</h3>
    <p>${esc(e.detail)}</p>
    <div class="scn">${e.up ? `<div class="up"><b>▲ Skenario hijau</b> · ${esc(e.up)}</div>` : ""}${e.down ? `<div class="down"><b>▼ Skenario merah</b> · ${esc(e.down)}</div>` : ""}</div>
  </article>`).join("")}</div>${D.eventsNote ? `<div class="foot">${esc(D.eventsNote)}</div>` : ""}`;
}

/* ---------- Pengingat ---------- */
function bfPengingat(D) {
  return `<div class="foot" style="color:var(--muted)">Salin kalimat Siri lalu ucapkan ke iPhone, atau buat manual di Reminders dengan judul, tanggal dan jam alert.</div>
  <div class="bf-grid">${D.reminders.map(r => `<article class="bf-card">
    <h3>🔔 ${esc(r.title)}</h3>
    <div class="when">${esc(r.when)} · alert ${esc(r.alert)}</div>
    <p>${esc(r.note)}</p>
    <div class="siri">${esc(r.siri)}</div>
    <button class="copyb" data-copy="${esc(r.siri)}">Salin</button>
  </article>`).join("")}</div>`;
}

/* ---------- Teknikal BTC: one candle chart with S/R, Fibonacci and both Elliott counts ---------- */
// pull key prices out of the Elliott scenario text, labelled with the wave/target word before them
function elliottLevels(sc, price) {
  const out = [];
  const KEYS = [[/Target(?: W\d)?:?\s*$/, () => "Target"], [/W([1-5])\s*$/, m => "W" + m[1]], [/\b([ABC])\s*$/, m => m[1]], [/low sementara\s*$/, () => "W4 low"], [/ATH\s*$/, () => "ATH"],
    [/Target[^\d]*$/, () => "Target"], [/Konfirmasi[^\d]*$/, () => "Konfirmasi"], [/(Batal|harian)[^\d]*<\s*$/, () => "Batal"]];
  for (const t of sc.items) {
    const re = /\d{2,3}(?:\.\d{3}|,\dk|k)/g;
    let m, prevEnd = 0, prevLabel = null;
    while ((m = re.exec(t))) {
      const v = idNum(m[0]);
      const before = t.slice(Math.max(0, m.index - 24), m.index), gap = t.slice(prevEnd, m.index);
      prevEnd = m.index + m[0].length;
      let label = null;
      for (const [rx, fn] of KEYS) { const k = rx.exec(before); if (k) { label = fn(k); break; } }
      if (!label && prevLabel === "Target" && /^\s*(→|lalu|,)\s*$/.test(gap)) label = "Target";
      if (!label && /^\s*(→)\s*$/.test(gap) && out.length) label = null;
      if (!label && /^[^\d]*$/.test(t.slice(0, m.index)) && /→|Rally|Hitungan/.test(t)) label = "Awal";
      prevLabel = label;
      if (!v || v < price * 0.6 || v > price * 1.4) continue;
      const dup = out.find(o => Math.abs(o.v - v) / v < 0.002);
      if (!dup) out.push({ v, label: label || "Level" });
      else if (dup.label === "Level" && label) dup.label = label;
    }
  }
  return out;
}
function bfTeknikal(D) {
  const B = D.btc;
  const zs = B.zones.slice().sort((a, b) => b.hi - a.hi);
  const chip = (k, t) => `<button class="fc" data-layer="${k}" aria-pressed="${!!BF.layers[k]}">${t}</button>`;
  const stat = (k, v) => `<div class="ms"><div class="k">${k}</div><div class="v" style="font-size:16px">${v}</div></div>`;
  const sc = s => `<article class="bf-card t-${s.tone}"><h3><span class="tone-${s.tone}">${TONE_ICON[s.tone]}</span>${esc(s.title)}</h3><ul>${s.items.map(t => `<li>${esc(t)}</li>`).join("")}</ul></article>`;
  return `<div class="mstats" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">${stat("Harga", "$" + rp(B.price))}${stat("7 hari", tPct(B.d7))}${stat("30 hari", tPct(B.d30))}${stat("High 50H", rp(B.hi50))}${stat("Low 50H", rp(B.lo50))}</div>
  <article class="bf-card glow">
    <div class="k">BTC/USDT · candle harian · semua level kunci</div>
    <div class="fbar">${chip("sr", "Support & resistance")}${chip("fib", "Fibonacci")}${chip("main", "Elliott utama")}${chip("alt", "Elliott alternatif")}</div>
    <div id="bfBtcChart" style="height:400px;border-radius:12px;overflow:hidden;background:var(--panel)"><div class="empty">Memuat candle BTC…</div></div>
    <div class="legend"><span><i style="background:#16c784"></i>Support</span><span><i style="background:#ea3943"></i>Resistance</span><span><i style="background:#a78bfa"></i>Fibonacci</span><span><i style="background:#22d3ee"></i>Elliott utama</span><span><i style="background:#f3ba2f"></i>Elliott alternatif</span></div>
  </article>
  <article class="bf-card"><div class="k">Penjelasan level (atas → bawah)</div>
    <table class="tbl"><tbody>
      ${zs.filter(z => z.side === "down").map(z => `<tr><td><b class="tone-down">${esc(z.label)}</b></td><td class="n tone-down">${z.lo === z.hi ? rp(z.lo) : rp(z.lo) + "–" + rp(z.hi)}</td><td>Resistance · ${esc(z.basis)}</td></tr>`).join("")}
      <tr><td><b style="color:var(--glow)">Kini</b></td><td class="n" style="color:var(--glow)">${rp(B.price)}</td><td>Harga snapshot</td></tr>
      ${zs.filter(z => z.side === "up").map(z => `<tr><td><b class="tone-up">${esc(z.label)}</b></td><td class="n tone-up">${z.lo === z.hi ? rp(z.lo) : rp(z.lo) + "–" + rp(z.hi)}</td><td>Support · ${esc(z.basis)}</td></tr>`).join("")}
    </tbody></table>
  </article>
  <div class="bf-grid">${sc(B.main)}${sc(B.alt)}</div>
  <div class="bf-grid">
    <article class="bf-card"><div class="k">EMA (daily)</div><table class="tbl"><tbody>${B.ema.map(e => `<tr><td><b>${esc(e.name)}</b></td><td class="n">${esc(e.value)}</td><td class="tone-${e.tone}">${TONE_ICON[e.tone]} ${esc(e.status)}</td></tr>`).join("")}</tbody></table>${B.emaNote ? `<div class="foot">${esc(B.emaNote)}</div>` : ""}</article>
    <article class="bf-card"><div class="k">Fibonacci</div><table class="tbl"><tbody>${B.fib.map(f => `<tr><td>${esc(f.name)}</td><td class="n tone-${f.role}">${esc(f.lv)}</td><td class="tone-${f.role}">${esc(f.fn)}</td></tr>`).join("")}</tbody></table></article>
  </div>`;
}
async function mountBtcChart(D) {
  const el = $("bfBtcChart");
  const cs = await candles("BS", "BTC", "1d", 180);
  if (!el.isConnected) return;
  if (!cs) { el.innerHTML = `<div class="empty">Candle BTC belum bisa diambil.</div>`; return; }
  if (!window.LightweightCharts) return noLib(el);
  el.innerHTML = "";
  const { chart, s } = makeCandleChart(el, cs, 400);
  BF.btcSeries = s; BF.btcLines = [];
  const B = D.btc, groups = { sr: [], fib: [], main: [], alt: [] };
  for (const z of B.zones) {
    const col = z.side === "up" ? "#16c784" : "#ea3943";
    groups.sr.push({ price: z.hi, color: col, title: z.label, lineWidth: 2, lineStyle: 0 });
    if (z.hi !== z.lo) groups.sr.push({ price: z.lo, color: col, title: "", lineWidth: 2, lineStyle: 0, axisLabelVisible: false });
  }
  for (const f of B.fib) { const v = idNum(f.lv); if (v) groups.fib.push({ price: v, color: "#a78bfa", title: "Fib " + f.name.split(" ")[0], lineWidth: 1, lineStyle: 2 }); }
  for (const l of elliottLevels(B.main, B.price)) groups.main.push({ price: l.v, color: "#22d3ee", title: l.label, lineWidth: 1, lineStyle: 1 });
  for (const l of elliottLevels(B.alt, B.price)) groups.alt.push({ price: l.v, color: "#f3ba2f", title: "Alt " + l.label, lineWidth: 1, lineStyle: 1 });
  BF.btcGroups = groups;
  applyBtcLayers();
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cs.length - 120), to: cs.length + 4 });
}
function applyBtcLayers() {
  for (const l of BF.btcLines || []) { try { BF.btcSeries.removePriceLine(l); } catch {} }
  BF.btcLines = [];
  for (const k in BF.btcGroups) if (BF.layers[k]) for (const o of BF.btcGroups[k]) BF.btcLines.push(BF.btcSeries.createPriceLine(Object.assign({ axisLabelVisible: true }, o)));
}

/* ---------- Altcoin: candle chart + 2-year recommendation per token ---------- */
function fundScore(sym) {
  const F = BF.fund, c = F && F.coins && F.coins[sym];
  if (!c) return null;
  const tot = F.criteria.reduce((s, k) => s + (c.s[k.key] || 0) * k.w, 0) / 100;
  return { tot, c, criteria: F.criteria };
}
function twoYear(t, D) {
  const f = fundScore(t.sym), act = (D.actions || []).find(a => a.sym === t.sym);
  const pos = clamp((t.p - t.lo50) / (t.hi50 - t.lo50), 0, 1);
  const a = act ? act.action : "";
  let tech = 50 + (/ADD/.test(a) ? 20 : /WAIT/.test(a) ? 0 : -5) + (1 - pos) * 20 + (t.tone === "up" ? 5 : t.tone === "down" ? -10 : 0);
  tech = clamp(tech, 0, 100);
  const fs = f ? f.tot : 6;
  const score = Math.round(clamp(fs * 10 * 0.7 + tech * 0.3, 1, 100));
  let verdict = score >= 65 && fs >= 6.5 ? "MASUK" : fs < 6 || score < 45 ? "HINDARI" : "TAHAN";
  const why = verdict === "MASUK" ? "Cicil bertahap selama 2 tahun (DCA), utamakan beli di zona support."
    : verdict === "TAHAN" ? "Pegang posisi yang ada; tambah hanya di support kuat atau setelah fundamental membaik."
    : "Jangan tambah posisi; kalau ingin tetap punya, cukup porsi kecil.";
  return { f, act, pos, tech: Math.round(tech), score, verdict, why };
}
const VCOL = { MASUK: "var(--buy)", TAHAN: "var(--warn)", HINDARI: "var(--sell)" };
function bfAltcoin(D) {
  return `<div class="foot" style="color:var(--muted)">Rekomendasi 2 tahun = 70% skor fundamental (framework Adhi, ${esc((BF.fund && BF.fund.asOf) || "--")}) + 30% teknikal (rencana aksi, posisi di range 50 hari, tren). MASUK ≥ 65 dengan fundamental ≥ 6,5 · HINDARI bila fundamental &lt; 6.</div>
  <div class="alt-list">${D.tokens.map(t => {
    const r = twoYear(t, D), f = r.f;
    return `<article class="bf-card alt-row t-${t.tone}">
      <div class="alt-main">
        <div style="display:flex;align-items:center;gap:10px">${logo(t.sym)}<div style="flex:1;min-width:0"><b style="font-size:16px">${esc(t.sym)}</b> <span class="chip dim">${esc(t.bucket)}</span><div style="display:flex;gap:12px;font-size:12.5px;margin-top:2px"><span><span class="k">7H</span> ${tPct(t.d7)}</span><span><span class="k">30H</span> ${tPct(t.d30)}</span></div></div><span class="num" style="font-size:16px;font-weight:600">$${esc(t.price)}</span></div>
        <div class="alt-chart" data-altchart="${esc(t.sym)}" style="height:240px;border-radius:12px;overflow:hidden;background:var(--panel)"><div class="empty">Memuat candle…</div></div>
        <div class="lane up"><em>▲ Support</em><span class="num">${esc(t.sup)}</span></div>
        <div class="lane down"><em>▼ Resistance</em><span class="num">${esc(t.res)}</span></div>
        <div class="foot">Tren: <span class="tone-${t.tone}">${TONE_ICON[t.tone]} ${esc(t.trend)}</span> · posisi ${Math.round(r.pos * 100)}% dari range 50 hari</div>
      </div>
      <aside class="alt-side">
        <div class="k">Rekomendasi investasi 2 tahun</div>
        <div style="display:flex;align-items:center;gap:12px">${bigRing(r.score, 76)}<div><div class="verdict" style="color:${VCOL[r.verdict]};border-color:${VCOL[r.verdict]}">${r.verdict}</div><div class="foot" style="margin-top:4px">${esc(r.why)}</div></div></div>
        ${f ? `<div class="k" style="margin-top:4px">Fundamental ${f.tot.toFixed(2).replace(".", ",")} / 10</div>
        <div class="fbars">${f.criteria.map(k => { const v = f.c.s[k.key] || 0; return `<div><span>${esc(k.name)}</span><i><b style="width:${v * 10}%;background:${v >= 7 ? "var(--buy)" : v >= 5 ? "var(--warn)" : "var(--sell)"}"></b></i><em>${v}</em></div>`; }).join("")}</div>
        <p style="font-size:12px">${esc(f.c.note)}</p><div class="foot">${esc(f.c.snap)}</div>` : `<div class="foot">Skor fundamental belum ada untuk ${esc(t.sym)}.</div>`}
        ${r.act ? `<div class="foot">Aksi brief: <b style="color:var(--fg)">${esc(r.act.action)}</b> · invalidasi ${esc(r.act.inval)}</div>` : ""}
      </aside>
    </article>`;
  }).join("")}</div>
  ${BF.fund && BF.fund.sources ? `<details class="why bf-card"><summary>Sumber skor fundamental</summary><ul>${BF.fund.sources.map(([a, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(a)}</a></li>`).join("")}</ul></details>` : ""}
  <div class="foot">Analisis framework, bukan nasihat keuangan. Kripto sangat volatil dan bisa kehilangan seluruh modal.</div>`;
}
function mountAltCharts(D) {
  const els = [...document.querySelectorAll("[data-altchart]")];
  const draw = async el => {
    const t = D.tokens.find(x => x.sym === el.dataset.altchart);
    const cs = await candles("BS", t.sym, "1d", 150);
    if (!el.isConnected) return;
    if (!cs) { el.innerHTML = `<div class="empty">Candle ${esc(t.sym)} belum bisa diambil.</div>`; return; }
    if (!window.LightweightCharts) return noLib(el);
    el.innerHTML = "";
    const { chart, s } = makeCandleChart(el, cs, 240);
    idLevels(t.sup).forEach((z, i) => { s.createPriceLine({ price: z.hi, color: "#16c784", lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: "S" + (i + 1) }); if (z.lo !== z.hi) s.createPriceLine({ price: z.lo, color: "#16c784", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" }); });
    idLevels(t.res).forEach((z, i) => { s.createPriceLine({ price: z.lo, color: "#ea3943", lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: "R" + (i + 1) }); if (z.lo !== z.hi) s.createPriceLine({ price: z.hi, color: "#ea3943", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" }); });
    const act = (D.actions || []).find(a => a.sym === t.sym), inv = act && idNum(String(act.inval).replace(/[<>\s]/g, ""));
    if (inv) s.createPriceLine({ price: inv, color: "#f0883d", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "Invalidasi" });
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cs.length - 90), to: cs.length + 3 });
  };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); draw(e.target); } }, { rootMargin: "300px" });
    els.forEach(el => io.observe(el));
  } else els.forEach(draw);
}

/* ---------- Aksi: big HOLD / ADD / WAIT / TRIM badges ---------- */
const ACT_ICON = {
  HOLD: { col: "#4f8cff", label: "HOLD", sub: "Tahan", svg: '<path d="M12 3 4 6v6c0 4.6 3.4 8.4 8 9 4.6-.6 8-4.4 8-9V6z"/><path d="m9 12 2 2 4-4"/>' },
  ADD: { col: "#16c784", label: "ADD", sub: "Tambah", svg: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>' },
  WAIT: { col: "#f3ba2f", label: "WAIT", sub: "Tunggu", svg: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>' },
  TRIM: { col: "#ea3943", label: "TRIM", sub: "Jual sebagian", svg: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M20 4 8.5 15M20 20 8.5 9"/>' }
};
function actBadges(action) {
  return Object.keys(ACT_ICON).filter(k => new RegExp("\\b" + k + "\\b").test(action)).map(k => {
    const a = ACT_ICON[k];
    return `<span class="actb" style="--c:${a.col}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${a.svg}</svg><b>${a.label}</b><small>${a.sub}</small></span>`;
  }).join("");
}
function bfAksi(D) {
  const groups = [...new Set(D.actions.map(a => a.bucket))];
  const desc = { Core: "aset utama", Satellite: "pendukung", "10x": "spekulatif" };
  return `<div class="actlegend">${Object.keys(ACT_ICON).map(k => actBadges(k)).join("")}</div>` +
    groups.map(g => `<div class="bucket-h">${esc(g)} <small>${esc(desc[g] || "")}</small></div>
    <div class="bf-grid">${D.actions.filter(a => a.bucket === g).map(a => `<article class="bf-card t-${a.tone}">
      <div style="display:flex;align-items:center;gap:10px">${logo(a.sym, "lg")}<b style="font-size:18px;flex:1">${esc(a.sym)}</b></div>
      <div class="actrow">${actBadges(a.action)}</div>
      <div class="lane up"><em>▲ Potensi long</em><span>${esc(a.long)}</span></div>
      ${a.trim ? `<div class="lane down"><em>▼ Jual sebagian</em><span>${esc(a.trim)}</span></div>` : ""}
      <div class="lane down"><em>✕ Invalidasi</em><span class="num">${esc(a.inval)} (close harian)</span></div>
    </article>`).join("")}</div>`).join("") +
    (D.risk && D.risk.length ? `<div class="risk-box"><h3>⚠ Catatan risiko</h3><ul>${D.risk.map(r => `<li>${esc(r)}</li>`).join("")}</ul></div>` : "") +
    (D.sources && D.sources.length ? `<details class="why bf-card"><summary>Sumber data &amp; berita (${D.sources.length})</summary><ul>${D.sources.map(([t, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join("")}</ul></details>` : "");
}

if (VIEW === "brief") openBrief();
