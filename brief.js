/* Crypto ETF Weekly Brief view. Reads data/brief.json (synced weekly from the claude.ai
   artifact) and data/etf.json (spot BTC ETF flows, refreshed by the hourly recorder).
   Tones: up = green, down = red, flat = grey, swing = amber. Uses helpers from app.js. */
"use strict";
const BF = { data: null, etf: null, tab: store.get("awt.bf", "ringkasan"), at: 0, err: null };
const TONE_ICON = { up: "▲", down: "▼", flat: "■", swing: "⇅" };
const TONE_LABEL = { up: "Naik · Beli", down: "Turun · Jual", flat: "Netral", swing: "Dua arah" };
const tchip = (tone, text) => `<span class="chip ${tone || "flat"}">${TONE_ICON[tone] || "■"} ${esc(text)}</span>`;
const idn = (v, d = 2) => (v > 0 ? "+" : "") + Number(v).toFixed(d).replace(".", ",") + "%";
const tPct = v => `<span class="num tone-${v > 0 ? "up" : v < 0 ? "down" : "flat"}">${v > 0 ? "▲" : v < 0 ? "▼" : "■"} ${idn(v)}</span>`;
const rp = n => Number(n).toLocaleString("id-ID", { maximumFractionDigits: 0 });
const mUsd = v => Math.abs(v) < 0.05 ? "0" : (v > 0 ? "+" : "−") + "$" + Math.abs(v).toLocaleString("id-ID", { maximumFractionDigits: 1 }) + " jt";

async function openBrief(force) {
  if (force || !BF.data || Date.now() - BF.at > 10 * 60000) {
    $("bfHead").innerHTML = `<div class="empty">Memuat Crypto ETF Weekly Brief…</div>`;
    try {
      const [d, e] = await Promise.all([fetchData("data/brief.json"), fetchData("data/etf.json").catch(() => null)]);
      BF.data = d; BF.etf = e; BF.at = Date.now(); BF.err = null;
    } catch (err) { BF.err = err; }
  }
  renderBrief();
}

function renderBrief() {
  if (!BF.data) {
    $("bfHead").innerHTML = `<div class="empty">Data brief belum ada. Brief disinkronkan otomatis tiap Sabtu pagi; coba muat ulang nanti.</div><div class="bf-tools"><button class="pri" data-bfreload>Muat ulang</button></div>`;
    $("bfBody").innerHTML = "";
    return;
  }
  const D = BF.data;
  $("bfHead").innerHTML = `
    <div class="k">Crypto ETF Weekly Brief</div>
    <h1>Minggu ${esc(D.period)}</h1>
    <div class="bf-meta"><span>Snapshot <b>${esc(D.snapshot)}</b></span><span>${esc(D.source)}</span>${BF.etf ? `<span>Arus ETF <b>${esc(BF.etf.source)}</b> · s/d ${dLabel(BF.etf.days[BF.etf.days.length - 1].date)}</span>` : ""}</div>
    <div class="legend2">${tchip("up", "Naik · Beli · Long")}${tchip("down", "Turun · Jual · Short")}${tchip("flat", "Netral · Tahan")}${tchip("swing", "Dua arah")}</div>
    <div class="bf-tools"><button data-bfreload>Muat ulang</button><a class="pri" href="${esc(D.artifact || "https://claude.ai/artifact/SDiCExUkGBn94iuhEyqmEK")}" target="_blank" rel="noopener">Buka versi lengkap ↗</a></div>`;
  for (const b of $("bfTabs").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.bf === BF.tab);
  const R = { ringkasan: bfRingkasan, etf: bfEtf, event: bfEvent, pengingat: bfPengingat, teknikal: bfTeknikal, altcoin: bfAltcoin, aksi: bfAksi }[BF.tab] || bfRingkasan;
  try { $("bfBody").innerHTML = R(D); }
  catch (e) { console.warn(e); $("bfBody").innerHTML = `<div class="empty">Bagian ini tidak bisa ditampilkan karena format data berubah. Buka versi lengkap di artifact.</div>`; }
}

$("bfTabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-bf]"); if (!b) return;
  BF.tab = b.dataset.bf; store.set("awt.bf", BF.tab); renderBrief();
});
document.addEventListener("click", e => {
  if (e.target.closest("[data-bfreload]")) { openBrief(true); return; }
  const c = e.target.closest("[data-copy]");
  if (c) {
    const text = c.dataset.copy;
    const done = () => { c.textContent = "Tersalin ✓"; setTimeout(() => (c.textContent = "Salin"), 1600); };
    try { navigator.clipboard.writeText(text).then(done, () => toast("Salin tidak didukung. Tekan lama teks di atas untuk menyalin.")); }
    catch { toast("Salin tidak didukung. Tekan lama teks di atas untuk menyalin."); }
  }
});

/* ---------- Ringkasan ---------- */
function biasHTML(b) {
  const pos = clamp((b.score + 100) / 2, 0, 100);
  const tone = b.score > 15 ? "up" : b.score < -15 ? "down" : "flat";
  return `<div class="bias">
    <div style="display:flex;align-items:baseline;gap:10px"><span class="bf-big tone-${tone}" style="font-size:28px">${b.score > 0 ? "+" : ""}${b.score}</span><b class="tone-${tone}" style="font-size:16px">${esc(b.label)}</b></div>
    <div class="track" role="img" aria-label="Bias ${b.score} dari -100 sampai 100"><span class="pin" style="left:${pos}%"></span></div>
    <div class="ends"><span class="tone-down">◀ Short −100</span><span>0</span><span class="tone-up">Long +100 ▶</span></div>
  </div>`;
}
function etfStats() {
  const E = BF.etf;
  if (!E || !E.days.length) return null;
  const d = E.days, last = d[d.length - 1], wk = d.slice(-5), sum5 = wk.reduce((a, x) => a + x.total, 0);
  return { last, sum5, n: wk.length };
}
function bfRingkasan(D) {
  const B = D.btc, pos = clamp((B.price - B.lo50) / (B.hi50 - B.lo50) * 100, 0, 100), es = etfStats();
  return `<div class="bf-grid">
    <article class="bf-card glow">
      <div style="display:flex;align-items:center;gap:10px">${logo("BTC", "lg")}<div><b style="font-size:16px">Bitcoin</b><div class="foot">Harga snapshot</div></div></div>
      <div class="bf-big">$${rp(B.price)}</div>
      <div style="display:flex;gap:14px;font-size:13px"><span><span class="k">7H</span> ${tPct(B.d7)}</span><span><span class="k">30H</span> ${tPct(B.d30)}</span></div>
      <div class="rng"><div class="k">Posisi di range 50 hari</div><div class="track"><span class="dot" style="left:${pos}%"></span></div><div class="ends"><span>Low ${rp(B.lo50)}</span><span>High ${rp(B.hi50)}</span></div></div>
    </article>
    <article class="bf-card">
      <div class="k">Bias pasar minggu ini</div>
      ${biasHTML(D.bias)}
      <p>${esc(D.bias.note)}</p>
    </article>
    ${es ? `<article class="bf-card t-${es.sum5 >= 0 ? "up" : "down"}">
      <div class="k">Arus ETF Bitcoin spot</div>
      <div class="bf-big tone-${es.sum5 >= 0 ? "up" : "down"}" style="font-size:28px">${mUsd(es.sum5)}</div>
      <p>${es.n} hari bursa terakhir. Hari terakhir (${dLabel(es.last.date)}): <b class="tone-${es.last.total >= 0 ? "up" : "down"}">${mUsd(es.last.total)}</b>.</p>
      <button class="copyb" data-bfgo="etf">Lihat arus ETF ›</button>
    </article>` : ""}
  </div>
  <div class="bf-grid">${(D.summary || []).map(s => `<article class="bf-card t-${s.tone}"><h3><span class="tone-${s.tone}">${TONE_ICON[s.tone] || "■"}</span>${esc(s.title)}</h3><p>${esc(s.text)}</p></article>`).join("")}</div>`;
}
document.addEventListener("click", e => { const g = e.target.closest("[data-bfgo]"); if (g) { BF.tab = g.dataset.bfgo; store.set("awt.bf", BF.tab); renderBrief(); } });

/* ---------- Arus ETF ---------- */
function bfEtf() {
  const E = BF.etf;
  if (!E || !E.days.length) return `<div class="empty">Data arus ETF belum tersedia. Perekam GitHub Actions mengambilnya dari bitbo.io setiap jam.</div>`;
  const days = E.days.slice(-30), W = 600, H = 190, P = 22;
  const mx = Math.max(1, ...days.map(d => Math.abs(d.total)));
  const bw = (W - P * 2) / days.length, y0 = H / 2;
  const bars = days.map((d, i) => {
    const h = Math.abs(d.total) / mx * (H / 2 - 18), x = P + i * bw + bw * 0.15, up = d.total >= 0;
    return `<rect x="${x.toFixed(1)}" y="${(up ? y0 - h : y0).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${up ? "#16c784" : "#ea3943"}"><title>${d.date}: ${mUsd(d.total)}</title></rect>`;
  }).join("");
  const lbl = (i) => { const d = days[i]; return `<text x="${(P + i * bw + bw / 2).toFixed(1)}" y="${H - 4}" fill="#56688a" font-size="10" text-anchor="middle">${d.date.slice(8)}/${d.date.slice(5, 7)}</text>`; };
  const ticks = [0, Math.floor(days.length / 2), days.length - 1].filter((v, i, a) => a.indexOf(v) === i).map(lbl).join("");
  const tot = days.reduce((a, d) => a + d.total, 0);
  const last = days[days.length - 1];
  // per issuer: sum over the visible window
  const sums = {};
  for (const d of days) for (const f in d.by) sums[f] = (sums[f] || 0) + d.by[f];
  const rows = Object.entries(sums).filter(([, v]) => Math.abs(v) >= 0.05).sort((a, b) => b[1] - a[1]);
  let streak = 0; for (let i = days.length - 1; i >= 0 && Math.sign(days[i].total) === Math.sign(last.total); i--) streak++;
  return `<div class="bf-grid">
    <article class="bf-card t-${tot >= 0 ? "up" : "down"}"><div class="k">Total ${days.length} hari bursa</div><div class="bf-big tone-${tot >= 0 ? "up" : "down"}" style="font-size:28px">${mUsd(tot)}</div><p>${tot >= 0 ? "Dana institusi masuk bersih ke ETF Bitcoin spot." : "Dana institusi keluar bersih dari ETF Bitcoin spot."}</p></article>
    <article class="bf-card t-${last.total >= 0 ? "up" : "down"}"><div class="k">Hari terakhir · ${dLabel(last.date)}</div><div class="bf-big tone-${last.total >= 0 ? "up" : "down"}" style="font-size:28px">${mUsd(last.total)}</div><p>${streak} hari berturut-turut ${last.total >= 0 ? "inflow" : "outflow"}.</p></article>
  </div>
  <article class="bf-card">
    <div class="k">Arus harian (USD juta) · hijau = inflow, merah = outflow</div>
    <svg class="etf-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Arus harian ETF Bitcoin">
      <line x1="${P}" x2="${W - P}" y1="${y0}" y2="${y0}" stroke="#2a3a5a" vector-effect="non-scaling-stroke"/>${bars}${ticks}
    </svg>
  </article>
  <article class="bf-card">
    <div class="k">Per penerbit · total ${days.length} hari</div>
    <table class="tbl"><thead><tr><th>ETF</th><th style="text-align:right">Total</th><th style="text-align:right">${esc(last.date.slice(5))}</th></tr></thead><tbody>
    ${rows.map(([f, v]) => `<tr><td><b>${esc(f)}</b></td><td class="n tone-${v >= 0 ? "up" : "down"}">${mUsd(v)}</td><td class="n tone-${(last.by[f] || 0) > 0 ? "up" : (last.by[f] || 0) < 0 ? "down" : "flat"}">${last.by[f] == null ? "--" : mUsd(last.by[f])}</td></tr>`).join("")}
    </tbody></table>
    <div class="foot">Sumber ${esc(E.source)} · update ${wib(E.updated)}. ETF Ethereum belum tersedia dari sumber gratis yang bisa diambil otomatis.</div>
  </article>`;
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

/* ---------- Teknikal BTC ---------- */
function waveSvg(path, tone) {
  const W = 300, H = 64, n = path.length, lo = Math.min(...path), hi = Math.max(...path), sp = hi - lo || 1;
  const pts = path.map((v, i) => `${(6 + (W - 12) * i / (n - 1)).toFixed(1)},${(H - 8 - (H - 16) * (v - lo) / sp).toFixed(1)}`).join(" ");
  const col = tone === "up" ? "#16c784" : "#ea3943";
  return `<svg class="wave-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${path.map((v, i) => `<circle cx="${(6 + (W - 12) * i / (n - 1)).toFixed(1)}" cy="${(H - 8 - (H - 16) * (v - lo) / sp).toFixed(1)}" r="3" fill="${col}"/>`).join("")}</svg>`;
}
function bfTeknikal(D) {
  const B = D.btc, [r0, r1] = B.range, x = v => clamp((v - r0) / (r1 - r0) * 100, 0, 100);
  const zones = B.zones.map((z, i) => `<span class="zone ${z.side}" style="left:${x(z.lo)}%;width:${Math.max(x(z.hi) - x(z.lo), 0.8)}%" title="${esc(z.basis)}"></span>
    <span class="lb ${i % 2 ? "bot" : "top"} tone-${z.side}" style="left:${x((z.lo + z.hi) / 2)}%"><b>${esc(z.label)} ${z.lo === z.hi ? rp(z.lo) : rp(z.lo) + "–" + rp(z.hi)}</b>${esc(z.side === "up" ? "Support" : "Resistance")}</span>`).join("");
  const stat = (k, v) => `<div class="ms"><div class="k">${k}</div><div class="v" style="font-size:16px">${v}</div></div>`;
  const sc = s => `<article class="bf-card t-${s.tone}"><h3><span class="tone-${s.tone}">${TONE_ICON[s.tone]}</span>${esc(s.title)}</h3>${waveSvg(s.path, s.tone)}<ul>${s.items.map(t => `<li>${esc(t)}</li>`).join("")}</ul></article>`;
  return `<div class="mstats" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">${stat("Harga", "$" + rp(B.price))}${stat("7 hari", tPct(B.d7))}${stat("30 hari", tPct(B.d30))}${stat("High 50H", rp(B.hi50))}${stat("Low 50H", rp(B.lo50))}</div>
  <article class="bf-card"><div class="k">Peta support (hijau) &amp; resistance (merah)</div>
    <div class="sr-wrap"><div class="sr"><div class="axis"></div>${zones}<div class="now" style="left:${x(B.price)}%"><span>Kini ${rp(B.price)}</span></div></div></div>
    <ul>${B.zones.map(z => `<li><b class="tone-${z.side}">${esc(z.label)}</b> ${z.lo === z.hi ? rp(z.lo) : rp(z.lo) + "–" + rp(z.hi)} · ${esc(z.basis)}</li>`).join("")}</ul>
  </article>
  <div class="bf-grid">${sc(B.main)}${sc(B.alt)}</div>
  <div class="bf-grid">
    <article class="bf-card"><div class="k">EMA (daily)</div><table class="tbl"><tbody>${B.ema.map(e => `<tr><td><b>${esc(e.name)}</b></td><td class="n">${esc(e.value)}</td><td class="tone-${e.tone}">${TONE_ICON[e.tone]} ${esc(e.status)}</td></tr>`).join("")}</tbody></table>${B.emaNote ? `<div class="foot">${esc(B.emaNote)}</div>` : ""}</article>
    <article class="bf-card"><div class="k">Fibonacci</div><table class="tbl"><tbody>${B.fib.map(f => `<tr><td>${esc(f.name)}</td><td class="n tone-${f.role}">${esc(f.lv)}</td><td class="tone-${f.role}">${esc(f.fn)}</td></tr>`).join("")}</tbody></table></article>
  </div>`;
}

/* ---------- Altcoin ---------- */
function rangeBar(p, lo, hi) {
  const pos = clamp((p - lo) / (hi - lo) * 100, 0, 100);
  return `<div class="rng"><div class="track"><span class="dot" style="left:${pos}%"></span></div><div class="ends"><span>${lo}</span><span>${Math.round(pos)}% dari range 50H</span><span>${hi}</span></div></div>`;
}
function bfAltcoin(D) {
  return `<div class="bf-grid">${D.tokens.map(t => `<article class="bf-card t-${t.tone}">
    <div style="display:flex;align-items:center;gap:10px">${logo(t.sym)}<div style="flex:1;min-width:0"><b style="font-size:16px">${esc(t.sym)}</b> <span class="chip dim">${esc(t.bucket)}</span></div><span class="num" style="font-size:16px;font-weight:600">$${esc(t.price)}</span></div>
    <div style="display:flex;gap:14px;font-size:13px"><span><span class="k">7H</span> ${tPct(t.d7)}</span><span><span class="k">30H</span> ${tPct(t.d30)}</span></div>
    ${rangeBar(t.p, t.lo50, t.hi50)}
    <div class="lane up"><em>▲ Support</em><span class="num">${esc(t.sup)}</span></div>
    <div class="lane down"><em>▼ Resistance</em><span class="num">${esc(t.res)}</span></div>
    <div class="foot">Tren: <span class="tone-${t.tone}">${TONE_ICON[t.tone]} ${esc(t.trend)}</span></div>
  </article>`).join("")}</div>`;
}

/* ---------- Aksi ---------- */
function bfAksi(D) {
  const groups = [...new Set(D.actions.map(a => a.bucket))];
  const desc = { Core: "aset utama", Satellite: "pendukung", "10x": "spekulatif" };
  return groups.map(g => `<div class="bucket-h">${esc(g)} <small>${esc(desc[g] || "")}</small></div>
    <div class="bf-grid">${D.actions.filter(a => a.bucket === g).map(a => `<article class="bf-card t-${a.tone}">
      <div style="display:flex;align-items:center;gap:10px">${logo(a.sym)}<b style="font-size:16px;flex:1">${esc(a.sym)}</b>${tchip(a.tone, a.action)}</div>
      <div class="lane up"><em>▲ Potensi long</em><span>${esc(a.long)}</span></div>
      ${a.trim ? `<div class="lane down"><em>▼ Jual sebagian</em><span>${esc(a.trim)}</span></div>` : ""}
      <div class="lane down"><em>✕ Invalidasi</em><span class="num">${esc(a.inval)} (close harian)</span></div>
    </article>`).join("")}</div>`).join("") +
    (D.risk && D.risk.length ? `<div class="risk-box"><h3>⚠ Catatan risiko</h3><ul>${D.risk.map(r => `<li>${esc(r)}</li>`).join("")}</ul></div>` : "") +
    (D.sources && D.sources.length ? `<details class="why bf-card"><summary>Sumber data &amp; berita (${D.sources.length})</summary><ul>${D.sources.map(([t, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join("")}</ul></details>` : "");
}

if (VIEW === "brief") openBrief();
