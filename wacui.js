/* WAC UI for Adhi Whale Terminal: the advice block on every card (SPOT first, FUTURES collapsed),
   the IKUT tab (pullback zones under watch, nearest first), the home strip, the per-number timeline
   in Riwayat, live stats + backtest in Rekap, WAC settings and browser zone reminders.
   Loaded after app.js and reuses its helpers ($, logo, ring, esc, px, pct, usd, wib, candles, notify...).
   Numbers (#N) and the 24/7 lifecycle come from the recorder (data/wac.json); the browser only previews. */
"use strict";
const WACUI = (() => {
  const NOTIF_KINDS = [["WATCH", "Watch baru"], ["NEAR_ZONE", "Pullback mendekati zona"], ["IN_ZONE", "Pullback masuk zona"], ["ENTRY_READY", "Entry ready"], ["ENTRY_INVALIDATED", "Batal"], ["EXPIRED", "Kedaluwarsa"], ["EXIT", "TP / exit"]];
  const S = {
    base: null, ready: false, state: null, stateAt: 0, regime: null, regAt: 0, etf: undefined, q: [], busy: false, bt: undefined,
    set: Object.assign({ equity: null, riskPct: 1, levCap: null, chase24: null, cooldown: null, notif: {} }, store.get("awt.wac", {})),
    seen: store.get("awt.wacSeen", {}), rem: store.get("awt.wacRem", {}), openWhy: new Set()
  };
  for (const [k] of NOTIF_KINDS) if (S.set.notif[k] == null) S.set.notif[k] = true;
  const C = () => WAC.cfg();
  const equity = () => S.set.equity || C().equityDefault;
  const money = v => "$" + Math.round(v).toLocaleString("en-US");
  const VERD = { "BELI SPOT": "IKUT", "TUNGGU PULLBACK": "TUNGGU", "HINDARI": "HINDARI" };
  const stTone = st => ({ ENTRY_READY: "buy", POSITION_OPEN: "buy", TAKE_PROFIT_PARTIAL: "buy", CONFIRMED: "neu", WATCH: "neu", EXIT_WARNING: "sell", ENTRY_INVALIDATED: "sell", EXPIRED: "dim", EXIT_CONFIRMED: "dim", DETECTED: "dim" }[st] || "dim");
  const statusChip = st => `<span class="chip ${stTone(st)}">${WAC.STATUS_ID[st] || st}</span>`;
  const left = t => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m >= 60 ? `${Math.floor(m / 60)}j ${m % 60}m` : `${m}m`; };

  /* ---------- config ---------- */
  function applyConfig() {
    const c = JSON.parse(JSON.stringify(S.base));
    if (S.set.riskPct) c.risk.riskPct = Math.min(c.risk.riskMax, Math.max(c.risk.riskMin, +S.set.riskPct));
    if (S.set.levCap) c.futures.hardCapLev = +S.set.levCap;
    if (S.set.chase24) c.chase.max24h = +S.set.chase24 / 100;
    if (S.set.cooldown) c.reminders.cooldownMin = +S.set.cooldown;
    WAC.setConfig(c);
  }
  async function loadConfig() {
    for (const url of ["config/wac.json?t=" + Date.now(), REPO_RAW + "config/wac.json"]) {
      try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) { S.base = await r.json(); break; } } catch {}
    }
    if (!S.base) return false;
    applyConfig(); S.ready = true;
    return true;
  }

  /* ---------- inputs: regime, ETF, recorder state ---------- */
  async function regime() {
    if (S.regime && Date.now() - S.regAt < 15 * 60e3) return S.regime;
    const now = Date.now();
    const [d1, h4] = await Promise.all([candles("BS", "BTC", "1d", 250), candles("BS", "BTC", "4h", 60)]);
    const r = WAC.regime(d1 && WAC.closed(d1, "1d", now), h4 && WAC.closed(h4, "4h", now), now);
    if (r.state) { S.regime = r; S.regAt = now; }
    else if (S.state && S.state.regime && now - S.state.regime.at < C().staleMinutes.regime * 60e3) S.regime = S.state.regime;
    return S.regime;
  }
  async function etfFor(coin) {
    if (!C().etfAssets.includes(coin)) return null;
    if (S.etf === undefined) { try { S.etf = await fetchData("data/etf.json"); } catch { S.etf = null; } }
    const a = S.etf && S.etf.assets && S.etf.assets[coin];
    return a ? WAC.etfScore(a.days, Date.now()) : null;
  }
  async function loadState() {
    try { S.state = await fetchData("data/wac.json"); S.stateAt = Date.now(); } catch { return; }
    checkStatusChanges();
    refresh();
  }
  const activeFor = coin => S.state && S.state.signals.find(x => x.coin === coin && WAC.ACTIVE.includes(x.status));
  const livePrice = coin => { for (const mk of ["BS", "BF", "OS", "OF"]) { const r = M[mk].get(coin); if (r && r.p) return r.p; } return null; };

  /* ---------- evaluation of live cards (preview, unnumbered) ---------- */
  function queue(s) { if (!s.wac && !s.wacQ) { s.wacQ = 1; S.q.push(s); pump(); } }
  async function pump() {
    if (S.busy || !S.ready) return;
    S.busy = true;
    try {
      while (S.q.length) {
        const s = S.q.shift();
        try { await evalSig(s); } catch (e) { s.wac = { err: "Gagal menghitung WAC" }; }
        paint(s);
      }
    } finally { S.busy = false; }
  }
  async function evalSig(s) {
    const now = Date.now();
    const c4 = await candles(s.mk, s.coin, "4h", 120);
    const reg = await regime();
    const ev = WAC.evalSpot({
      coin: s.coin, now, price: livePrice(s.coin) || s.price, priceAt: now, chg24: s.chg24, vol24: vol24(s.coin), spreadPct: null,
      taker: s.flow ? { buy: s.flow.b, sell: s.flow.s } : null, dirUp: s.dir === "up" ? true : s.dir === "down" ? false : null, mult: s.mult,
      c4h: c4 && WAC.closed(c4, "4h", now), regime: reg, etf: await etfFor(s.coin), equity: equity(), riskPct: S.set.riskPct
    });
    const fr = funding.get(s.coin);
    ev.fut = WAC.futures(ev, { equity: equity(), riskPct: S.set.riskPct, regime: reg && reg.state, funding: fr == null ? null : fr, takerSell: s.dir === "down" });
    ev.regime = reg;
    ev.at = now;
    s.wac = ev;
  }
  function paint(s) {
    for (const el of document.querySelectorAll(`[data-wac="${CSS.escape(s.id)}"]`)) el.innerHTML = inner(s);
    dirtyHome = true;
    // with "Hanya lolos WAC" on, a card can only appear once its verdict is known
    if (UI.ikut && s.feed && !S.reflow) S.reflow = setTimeout(() => { S.reflow = 0; for (const k in FEEDS) rerender(k); }, 800);
  }

  /* ---------- card block ---------- */
  function block(s) {
    if (s.kind === "liq") {
      const a = activeFor(s.coin);
      return `<div class="wac"><div class="wac-note">Likuidasi = konteks pasar, bukan pemicu entry WAC.${a ? ` Ada <b>sinyal #${a.no}</b> ${esc(s.coin)} yang dipantau (${WAC.STATUS_ID[a.status]}).` : ""}</div></div>`;
    }
    if (!S.ready) return `<div class="wac" data-wac="${s.id}"><div class="wac-note">Memuat aturan WAC…</div></div>`;
    queue(s);
    return `<div class="wac" data-wac="${s.id}">${inner(s)}</div>`;
  }
  function inner(s) {
    const ev = s.wac;
    if (!ev) return `<div class="wac-note">Menghitung skor WAC (candle 4h, rezim BTC)…</div>`;
    if (ev.err) return `<div class="wac-note">${esc(ev.err)}</div>`;
    const sc = ev.score, a = activeFor(s.coin);
    const num = `<span class="chip dim">Preview live</span>`;
    const rec = a ? `<button type="button" class="wac-rec" data-go="ikut">Perekam memantau <b class="wac-no">Sinyal #${a.no}</b> ${esc(s.coin)} · ${statusChip(a.status)} · zona ${px(a.zone.lo)}–${px(a.zone.hi)} ›</button>` : `<div class="wac-note">Belum ada sinyal bernomor untuk ${esc(s.coin)}; nomor (#N) diberikan perekam 24/7.</div>`;
    const p = ev.plan, z = ev.zone, sz = ev.sizing;
    const spot = p ? `<div class="plan">
      <div class="e"><small>Zona entry</small><span>${px(z.lo)}–${px(z.hi)}</span></div>
      <div class="s"><small>Invalidasi / SL</small><span>${px(p.sl)} (−${(p.slPct * 100).toFixed(1)}%)</span></div>
      <div class="t"><small>TP1 · jual 50%</small><span>${px(p.tp1)} (+${(C().risk.tp1 * 100).toFixed(0)}%)</span></div>
      <div class="t"><small>TP2</small><span>${px(p.tp2)} (+${(C().risk.tp2 * 100).toFixed(0)}%)</span></div>
      <div><small>R:R</small><span>${p.rr.toFixed(2)}</span></div>
      <div><small>Ukuran spot</small><span>${money(sz.notional)}${sz.capped ? " (cap)" : ""}</span></div>
      <div><small>Risiko</small><span>${money(sz.risk)} · ${sz.riskPct.toFixed(1)}%</span></div>
      <div><small>Berlaku</small><span>${left(ev.expiresAt)}</span></div>
    </div>
    <div class="wac-note">Pola ${ev.pattern === "A" ? "A · breakout" : "B · pullback (utama)"} · ${esc(z.basis)} · entry 40/30/30, tanpa average down · time stop ${C().risk.timeStopH} jam${sz.bearHalf ? " · rezim BEARISH: ukuran ½" : ""}${S.set.equity ? "" : ` · equity contoh ${money(equity())}, atur di ⚙`}</div>` : "";
    const f = ev.fut;
    const fut = `<details class="wac-fut"><summary>FUTURES (sekunder) · <b class="${f.side === "LONG" ? "up" : f.side === "SHORT" ? "down" : ""}">${esc(f.verdict)}</b></summary>
      ${f.side ? `<div class="plan">
        <div><small>Leverage maks</small><span>${f.lev}x${f.lev < f.maxLev ? ` (dari ${f.maxLev}x, jarak likuidasi)` : ""}</span></div>
        <div><small>Margin</small><span>${money(f.margin)}</span></div>
        <div><small>Notional</small><span>${money(f.notional)}</span></div>
        <div><small>Funding</small><span>${esc(f.funding)}</span></div>
        <div class="e"><small>Entry</small><span>${px(f.entry)}</span></div>
        <div class="s"><small>SL</small><span>${px(f.sl)}</span></div>
        <div><small>Likuidasi ±</small><span>${(f.liqDist * 100).toFixed(1)}%</span></div>
        <div><small>Rumus</small><span>⌊50% ÷ SL⌋</span></div>
      </div>` : `<div class="wac-note">${esc(f.why || "")} Funding: ${esc(f.funding)}.</div>`}
      <div class="wac-mm">⚠️ ${esc(f.mm)}</div>
    </details>`;
    const comps = Object.entries(sc.weights).map(([k, w]) => {
      const c = sc.comps[k], name = { whale: "Arus (proxy whale)", tech: "Teknikal 4h", regime: "Rezim BTC", etf: "Arus ETF/ETP" }[k];
      return `<li><b>${name}</b> · bobot ${w} · ${c && c.status === "ok" ? `skor ${c.score}` : "N/A"} — ${esc(c ? c.note : "")}</li>`;
    }).join("") + (sc.profile === "Non-ETF" ? `<li><b>Arus ETF/ETP</b> · tidak berlaku (bukan aset ETF)</li>` : "");
    return `<div class="wac-h">${ring(sc.score)}<div class="wac-t"><span class="pill ${VERD[ev.verdict]}">${ev.verdict}</span><small><span class="${sc.tone}">${sc.cls}</span> · coverage ${sc.coverage}% · keyakinan ${sc.confLabel}</small></div><div class="wac-n">${num}</div></div>
    <div class="wac-why">${esc(ev.why)}</div>
    ${rec}
    ${spot}
    ${fut}
    <details class="why"><summary>Kenapa skor ${sc.score}? (profil ${sc.profile})</summary><ul>${comps}</ul>
      <ul class="checks">${ev.filters.map(x => `<li class="${x.ok ? "ok" : "no"}">${esc(x.label)}${x.detail ? ` · ${esc(x.detail)}` : ""}</li>`).join("")}</ul>
      ${ev.rejects.length ? `<div class="wac-note">Penolak: ${ev.rejects.map(esc).join("; ")}</div>` : ""}
      <div class="wac-note">Rezim BTC: ${ev.regime ? `${ev.regime.state} · ${esc(ev.regime.detail)}` : "N/A"} · data harga ${ev.stale ? "STALE" : "segar"} · spread tidak dicek.</div>
    </details>`;
  }

  /* ---------- IKUT tab: zones under watch, nearest first ---------- */
  function dist(sig) {
    const p = livePrice(sig.coin);
    if (!p) return { p: null, d: Infinity, txt: "harga live belum ada" };
    const z = sig.zone;
    if (p >= z.lo && p <= z.hi) return { p, d: 0, txt: "di dalam zona" };
    const d = p > z.hi ? p / z.hi - 1 : p / z.lo - 1;
    return { p, d: Math.abs(d), txt: `${d > 0 ? "+" : ""}${(d * 100).toFixed(1)}% ${d > 0 ? "di atas" : "di bawah"} zona` };
  }
  function zoneList() {
    if (!S.state) return [];
    return S.state.signals.filter(x => WAC.ACTIVE.includes(x.status)).map(x => ({ sig: x, ...dist(x) })).sort((a, b) => a.d - b.d);
  }
  function ladder(sig, p) {
    const pos0 = sig.pos, sl = pos0 ? pos0.sl : sig.inval, tp1 = pos0 ? pos0.tp1 : sig.plan.tp1;
    const marks = [[sl, pos0 && pos0.half ? "SL (BE)" : "SL"], [sig.zone.lo, "Zona"], ...(pos0 ? [[pos0.entry, "Entry"]] : []), [tp1, "TP1"]];
    const pts = [...marks.map(m => m[0]), sig.zone.hi, ...(p ? [p] : [])];
    const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1, pos = v => clamp((v - lo) / span * 100, 0, 100).toFixed(1);
    return `<div class="ladder"><div class="bar"><i style="left:0;width:${pos(sl)}%;background:rgba(234,57,67,.4)"></i><i style="left:${pos(sig.zone.lo)}%;width:${(pos(sig.zone.hi) - pos(sig.zone.lo)).toFixed(1)}%;background:#22d3ee"></i><i style="left:${pos(sig.zone.hi)}%;right:0;background:rgba(22,199,132,.35)"></i></div>
      ${marks.map(([v, t]) => `<span class="tick" style="left:${pos(v)}%"></span><span class="lab" style="left:${pos(v)}%">${t}</span>`).join("")}
      ${p ? `<span class="now" style="left:${pos(p)}%">${px(p)}</span>` : ""}</div>`;
  }

  const LEGEND = [
    ["WATCH", "Coin lolos syarat awal (likuid, arus taker beli). Zona pullback dihitung; belum boleh beli."],
    ["CONFIRMED", "Teknikal 4h sudah mendukung. Tunggu harga masuk zona lalu candle 1h hijau."],
    ["ENTRY_READY", "Syarat beli spot lengkap. Boleh entry bertahap 40/30/30 dengan SL di invalidasi."],
    ["POSITION_OPEN", "Simulasi dashboard: dianggap sudah beli di harga berikutnya untuk mengukur hasil. Bukan order sungguhan, kamu tetap memutuskan sendiri."],
    ["TAKE_PROFIT_PARTIAL", "TP1 +9% tercapai: jual 50%, pindahkan SL ke harga entry."],
    ["EXIT_WARNING", "72 jam tanpa TP1: siapkan keluar."],
    ["EXIT_CONFIRMED", "Posisi simulasi ditutup (TP2, SL, atau time stop). Hasilnya masuk Rekap."],
    ["ENTRY_INVALIDATED", "Batal: harga close 1h di bawah invalidasi atau rezim BTC memburuk."],
    ["EXPIRED", "Kedaluwarsa: 72 jam tanpa konfirmasi."]
  ];
  function legendHTML() {
    return `<details class="ik-legend" open><summary>Arti status sinyal &amp; skor</summary>
      <ul>${LEGEND.map(([k, t]) => `<li>${statusChip(k)}<span>${t}</span></li>`).join("")}
      <li><span class="chip dim">Skor</span><span>Lingkaran angka = skor WAC 0–100 (≥80 akumulasi kuat, 65–79 akumulasi, 50–64 watch, &lt;50 risiko distribusi). Ketuk lingkaran untuk melihat kenapa.</span></li></ul>
    </details>`;
  }
  function whyHTML(s) {
    const b = s.breakdown, name = { whale: "Arus (proxy whale)", tech: "Teknikal 4h", regime: "Rezim BTC", etf: "Arus ETF/ETP" };
    const head = `<div class="wac-note"><b style="color:var(--fg)">Skor ${s.score}</b> = rata-rata berbobot komponen yang datanya ada. Kelas <span class="${WAC.CLASS_TONE[s.cls] || ""}">${esc(s.cls)}</span> · coverage ${s.coverage}% (porsi bobot yang datanya tersedia) · keyakinan ${s.confidence}${b ? ` (${b.confLabel})` : ""}.</div>`;
    if (!b) return `<div class="wac-whybox">${head}<div class="wac-note">Rincian per komponen hanya tersimpan untuk sinyal baru (setelah pembaruan ini). Rezim saat deteksi: ${esc(s.regime || "N/A")}.</div></div>`;
    const rows = Object.entries(b.weights).map(([k, w]) => { const c = b.comps[k]; const ok = c && c.status === "ok";
      return `<tr><td>${name[k] || k}</td><td>${w}</td><td>${ok ? c.score : "N/A"}</td><td>${ok ? Math.round(w * c.score / Math.max(1, s.coverage)) : "–"}</td></tr><tr class="sub"><td colspan="4">${esc(c ? c.note : "")}</td></tr>`; }).join("");
    return `<div class="wac-whybox">${head}
      <div class="tblw"><table class="tbl"><thead><tr><th>Komponen (profil ${esc(b.profile)})</th><th>Bobot</th><th>Skor</th><th>Sumbang</th></tr></thead><tbody>${rows}
      ${b.profile === "Non-ETF" ? `<tr><td>Arus ETF/ETP</td><td colspan="3">tidak berlaku (bukan aset ETF)</td></tr>` : ""}</tbody></table></div>
      <ul class="checks">${b.filters.map(f => `<li class="${f.ok ? "ok" : "no"}">${esc(f.label)}${f.detail ? ` · ${esc(f.detail)}` : ""}</li>`).join("")}</ul>
      <div class="wac-note">Arus taker/volume adalah proxy order agresif di exchange, bukan bukti whale membeli.</div></div>`;
  }
  const ringBtn = (s, size) => `<button type="button" class="ringbtn" data-wacwhy="${s.no}" aria-expanded="${S.openWhy.has(String(s.no))}" aria-label="Kenapa skor ${s.score}?">${ring(s.score, size)}<small>kenapa?</small></button>`;
  function zoneCard(x) {
    const s = x.sig, pl = s.plan, cls = s.status === "ENTRY_READY" ? "go" : ["POSITION_OPEN", "TAKE_PROFIT_PARTIAL"].includes(s.status) ? "go" : "wait";
    const ev = s.events.slice(-3).reverse();
    return `<article class="ik ${cls}">
      <div class="ik-h">${logo(s.coin, "lg")}<div class="id"><b>${esc(s.coin)}</b><span class="wac-no">#${s.no}</span>${statusChip(s.status)}<small>${esc(s.id)} · ${wib(s.t)} · ${EX[s.mk] || ""}</small></div>${ringBtn(s, 42)}</div>
      ${S.openWhy.has(String(s.no)) ? whyHTML(s) : ""}
      <div class="st ${cls === "go" ? "go" : "wait"}">${x.p ? `${px(x.p)} · ${x.txt}` : x.txt}</div>
      ${ladder(s, x.p)}
      <div class="lv">
        <div class="e"><small>Zona entry</small><span>${px(s.zone.lo)} – ${px(s.zone.hi)}</span></div>
        <div class="s"><small>${s.pos ? "Stop loss posisi" : "Invalidasi"}</small><span>${px(s.pos ? s.pos.sl : s.inval)}${s.pos && s.pos.half ? " (BE)" : ""}</span></div>
        <div class="t"><small>TP1 · TP2</small><span>${px(pl.tp1)} · ${px(pl.tp2)}</span></div>
        <div><small>R:R · Pola</small><span>${pl.rr.toFixed(2)} · ${s.pattern}</span></div>
        <div><small>Kelas · coverage</small><span class="${WAC.CLASS_TONE[s.cls] || ""}">${esc(s.cls)} · ${s.coverage}%</span></div>
        <div><small>Kedaluwarsa</small><span>${s.status === "POSITION_OPEN" || s.status === "TAKE_PROFIT_PARTIAL" ? "posisi berjalan" : left(s.expiresAt)}</span></div>
      </div>
      <ul class="tl">${ev.map(e => `<li><time>${wib(e.t).replace(" WIB", "")}</time>${esc(e.text)}</li>`).join("")}</ul>
      <div class="acts"><button type="button" class="pri" data-wacchart="${s.no}">Chart + zona</button><button type="button" data-go="hist">Timeline</button></div>
    </article>`;
  }
  /* IKUT list: filters (coin, number, status) and a frozen order so new signals never push cards away */
  const F = Object.assign({ coin: "", no: "", st: "aktif" }, store.get("awt.ikF", {}));
  S.ikOrder = null; S.ikKey = "";
  function matches(sig) {
    const no = String(F.no || "").replace(/\D/g, "");
    if (no) return String(sig.no) === no;
    if (F.coin && !sig.coin.includes(F.coin.trim().toUpperCase())) return false;
    return F.st === "semua" || WAC.ACTIVE.includes(sig.status);
  }
  function orderNow() {
    const rank = x => (WAC.ACTIVE.includes(x.sig.status) ? 0 : 1);
    return S.state.signals.filter(matches).map(x => ({ sig: x, ...dist(x) }))
      .sort((a, b) => rank(a) - rank(b) || (rank(a) ? b.sig.no - a.sig.no : a.d - b.d)).map(x => x.sig.no);
  }
  function ikFilterBar() {
    if ($("ikF").dataset.ready) return;
    $("ikF").dataset.ready = 1;
    $("ikF").innerHTML = `<input type="search" id="ikCoin" placeholder="Cari coin (mis. TIA)" autocomplete="off" aria-label="Cari coin" value="${esc(F.coin)}">
      <input type="search" id="ikNo" inputmode="numeric" placeholder="No. sinyal (#12)" autocomplete="off" aria-label="Nomor sinyal" value="${esc(F.no)}">
      <select id="ikSt" aria-label="Status"><option value="aktif">Dipantau</option><option value="semua">Semua (termasuk selesai/batal)</option></select>`;
    $("ikSt").value = F.st;
    const upd = () => { F.coin = $("ikCoin").value; F.no = $("ikNo").value; F.st = $("ikSt").value; store.set("awt.ikF", F); S.ikOrder = null; renderIkut(); };
    $("ikCoin").addEventListener("input", upd); $("ikNo").addEventListener("input", upd); $("ikSt").addEventListener("change", upd);
  }
  function renderIkut() {
    const list = zoneList(), ready = list.filter(x => x.sig.status === "ENTRY_READY").length;
    const badge = $("ikBadge"); badge.hidden = !ready; badge.textContent = ready;
    if (VIEW === "home") renderHome();
    if (VIEW !== "ikut") return;
    const reg = S.regime || (S.state && S.state.regime);
    $("ikReg").innerHTML = reg ? `Rezim BTC: <b class="${reg.state === "BULLISH" ? "up" : reg.state === "NEUTRAL" ? "" : "down"}">${reg.state}</b> · ${esc(reg.detail)}${reg.state === "BEARISH" ? ` · skor minimal +${C().regime.bearScoreAdd}, ukuran ½` : reg.state === "RISK-OFF" ? " · tidak ada entry baru" : ""}` : "Rezim BTC: memuat…";
    if (!$("ikLegend").firstChild) $("ikLegend").innerHTML = legendHTML();
    ikFilterBar();
    if (!S.state) { $("ikList").innerHTML = `<article class="panel"><div class="empty">Status WAC dari perekam belum bisa dibuka (data/wac.json). Perekam GitHub Actions menulisnya tiap 10 menit.</div></article>`; $("ikNew").hidden = true; return; }
    const now = orderNow();
    if (!S.ikOrder) S.ikOrder = now;
    // cards already on screen keep their place (and stay even if their status changes); new ones wait behind a button
    const fresh = now.filter(n => !S.ikOrder.includes(n));
    $("ikNew").hidden = !fresh.length;
    $("ikNew").textContent = `${fresh.length} sinyal baru · ketuk untuk tampilkan`;
    const byNo = new Map(S.state.signals.map(x => [x.no, x]));
    const shown = S.ikOrder.map(n => byNo.get(n)).filter(Boolean).map(x => ({ sig: x, ...dist(x) }));
    const filtered = F.coin || F.no || F.st !== "aktif";
    $("ikList").innerHTML = shown.length ? shown.map(zoneCard).join("")
      : `<article class="panel"><div class="empty">${filtered ? "Tidak ada sinyal yang cocok dengan filter." : `Belum ada zona pullback yang dipantau. Aturan WAC konservatif: sinyal hanya dicatat bila lolos likuiditas dan arus taker beli. Update terakhir ${S.state.updated ? wib(S.state.updated) : "--"}.`}</div></article>`;
  }
  function renderHome() {
    const list = zoneList();
    $("homeIkN").textContent = list.length ? `${list.filter(x => x.sig.status === "ENTRY_READY").length} entry ready · ${list.length} dipantau` : "";
    if (!list.length) { $("homeIk").innerHTML = `<article class="panel"><div class="empty" style="padding:12px 4px">${S.state ? "Belum ada zona pullback yang dipantau." : "Memuat status WAC…"}</div></article>`; return; }
    $("homeIk").innerHTML = list.slice(0, 8).map(x => {
      const s = x.sig;
      return `<article class="panel mini-ik${s.status === "ENTRY_READY" ? " glow" : ""}">
        <div class="row">${logo(s.coin)}<div style="flex:1;min-width:0"><b>${esc(s.coin)}</b> <span class="wac-no">#${s.no}</span> ${statusChip(s.status)}<div class="foot">${x.txt}</div></div>${ringBtn(s)}</div>
        ${S.openWhy.has(String(s.no)) ? whyHTML(s) : ""}
        <div class="lv3"><div><small class="k">Zona</small><span style="color:var(--glow)">${px(s.zone.lo)}</span></div><div><small class="k">Invalidasi</small><span class="down">${px(s.inval)}</span></div><div><small class="k">TP1</small><span class="up">${px(s.plan.tp1)}</span></div></div>
        <div class="acts"><button class="pri" data-wacchart="${s.no}">Chart + zona</button><button data-go="ikut">Detail</button></div>
      </article>`;
    }).join("");
  }

  /* ---------- browser reminders + status-change notifications ---------- */
  function wacNotify(sig, kind, price) {
    const k = kind.startsWith("EXIT") || kind === "TAKE_PROFIT_PARTIAL" ? "EXIT" : kind;
    if (!S.set.notif[k]) return;
    const extra = kind === "ENTRY_READY" ? WAC.entryTexts(sig, { equity: S.set.equity, riskPct: S.set.riskPct, regime: S.regime && S.regime.state, funding: funding.get(sig.coin) }) : {};
    const n = WAC.notifText(sig, kind, Object.assign({ when: t => wib(t), srcText: x => srcText(x), price }, extra));
    beep(kind !== "ENTRY_INVALIDATED" && kind !== "EXPIRED");
    toast(n.title);
    notify(n.title, n.body, "wac-" + sig.no + "-" + kind);
  }
  const srcText = sig => { const s = sig.src || {}; return s.kind === "volume" ? `Volume tak biasa ${usd(s.value || 0)}/menit (${Math.round(s.mult || 0)}x)` : s.kind === "trade" ? `Order besar ${usd(s.value || 0)} (proxy)` : `Gerak harga`; };
  function checkStatusChanges() {
    const first = !Object.keys(S.seen).length;
    for (const sig of S.state.signals) {
      const prev = S.seen[sig.no];
      if (prev === sig.status) continue;
      S.seen[sig.no] = sig.status;
      if (first || Date.now() - sig.t > 3 * 24 * 3600e3) continue;
      if (!prev && sig.status !== "WATCH" && sig.status !== "ENTRY_READY" && sig.status !== "CONFIRMED") continue;
      wacNotify(sig, prev ? sig.status : (sig.status === "ENTRY_READY" ? "ENTRY_READY" : "WATCH"), livePrice(sig.coin));
    }
    const live = new Set(S.state.signals.map(x => String(x.no)));
    for (const k in S.seen) if (!live.has(k)) delete S.seen[k];
    store.set("awt.wacSeen", S.seen);
  }
  // near / in zone between recorder pushes, deduplicated with a cooldown
  function zoneReminders() {
    if (!S.state || !S.ready) return;
    const rm = C().reminders, cool = rm.cooldownMin * 60e3, now = Date.now();
    for (const sig of S.state.signals) {
      if (!WAC.PRE.includes(sig.status)) continue;
      const p = livePrice(sig.coin);
      if (!p || p < sig.inval) continue;
      const z = sig.zone, inZone = p >= z.lo && p <= z.hi, near = !inZone && p > z.hi && p <= z.hi * (1 + rm.nearPct);
      const kind = inZone ? "IN_ZONE" : near ? "NEAR_ZONE" : null;
      if (!kind) continue;
      const key = sig.no + ":" + kind, last = S.rem[key] || 0;
      if (now - last < cool || (sig.notified && Object.keys(sig.notified).some(n => n.startsWith(kind) && now - sig.notified[n] < cool))) continue;
      S.rem[key] = now;
      wacNotify(sig, kind, p);
    }
    for (const k in S.rem) if (now - S.rem[k] > 7 * 24 * 3600e3) delete S.rem[k];
    store.set("awt.wacRem", S.rem);
  }

  /* ---------- Riwayat: timeline per number ---------- */
  function renderTimeline() {
    const box = $("wacTl");
    if (!box) return;
    if (!S.state || !S.state.signals.length) { box.innerHTML = `<div class="empty">Belum ada sinyal WAC bernomor.</div>`; return; }
    const q = ($("hCoin").value || "").trim().toUpperCase();
    const list = S.state.signals.filter(x => !q || x.coin.includes(q)).slice().sort((a, b) => b.no - a.no).slice(0, 60);
    box.innerHTML = list.map(s => `<details class="tl-item"><summary>${logo(s.coin, "sm")}<b>#${s.no}</b> ${esc(s.coin)} ${statusChip(s.status)}<small>${wib(s.t)} · skor ${s.score}${s.result ? ` · hasil ${pct(s.result.ret)}` : ""}</small></summary>
      <div class="wac-note">${esc(s.id)} · zona ${px(s.zone.lo)}–${px(s.zone.hi)} · SL ${px(s.plan.sl)} · TP1 ${px(s.plan.tp1)} · TP2 ${px(s.plan.tp2)} · rezim ${esc(s.regime || "N/A")}</div>
      <ul class="tl">${s.events.map(e => `<li><time>${wib(e.t).replace(" WIB", "")}</time>${e.status ? `<span class="chip ${stTone(e.status)}">${WAC.STATUS_ID[e.status] || e.status}</span> ` : ""}${esc(e.text)}</li>`).join("")}</ul>
    </details>`).join("");
  }

  /* ---------- Rekap: live stats + backtest ---------- */
  function stats(trades) {
    const n = trades.length;
    if (!n) return null;
    const w = trades.filter(x => x > 0).length, sum = trades.reduce((a, b) => a + b, 0), mean = sum / n;
    const sd = Math.sqrt(trades.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const gp = trades.filter(x => x > 0).reduce((a, b) => a + b, 0), gl = -trades.filter(x => x < 0).reduce((a, b) => a + b, 0);
    let eq = 0, peak = 0, dd = 0;
    for (const r of trades) { eq += r; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
    return { n, win: w / n, mean, pf: gl ? gp / gl : null, t: sd ? mean / (sd / Math.sqrt(n)) : null, dd };
  }
  const statRow = (label, st, unit) => st ? `<tr><td>${label}</td><td>${st.n}</td><td>${Math.round(st.win * 100)}%</td><td>${unit === "R" ? st.mean.toFixed(2) + "R" : pct(st.mean)}</td><td>${st.pf == null ? "--" : st.pf.toFixed(2)}</td><td>${unit === "R" ? st.dd.toFixed(1) + "R" : pct(st.dd)}</td><td>${st.t == null ? "--" : st.t.toFixed(2)}</td></tr>` : `<tr><td>${label}</td><td colspan="6">belum ada trade selesai</td></tr>`;
  async function renderRekap() {
    const box = $("wacStats");
    if (!box) return;
    if (!S.state) await loadState();
    const sigs = (S.state && S.state.signals) || [], done = sigs.filter(x => x.result);
    const cnt = st => sigs.filter(x => x.status === st).length;
    const spot = done.map(x => x.result.ret), futR = done.map(x => x.result.ret / (x.plan.slPct || 0.05));
    const byReg = {};
    for (const x of done) (byReg[x.result.regime || x.regime || "N/A"] = byReg[x.result.regime || x.regime || "N/A"] || []).push(x.result.ret);
    box.innerHTML = `<article class="panel glow">
      <div class="tiles">${[["Total bernomor", sigs.length], ["Dipantau", sigs.filter(x => WAC.ACTIVE.includes(x.status)).length], ["Entry ready → posisi", sigs.filter(x => x.pos).length], ["Batal", cnt("ENTRY_INVALIDATED")], ["Kedaluwarsa", cnt("EXPIRED")], ["Selesai", cnt("EXIT_CONFIRMED")]].map(([l, v]) => `<div class="tile w2"><div class="tx"><b>${v}</b><small>${l}</small></div></div>`).join("")}</div>
      <div class="tblw"><table class="tbl"><thead><tr><th>Live (virtual)</th><th>n</th><th>Win</th><th>Rata-rata</th><th>PF</th><th>Max DD</th><th>t-stat</th></tr></thead><tbody>
        ${statRow("SPOT (net biaya)", stats(spot), "%")}${statRow("FUTURES LONG (R)", stats(futR), "R")}
        ${Object.entries(byReg).map(([k, v]) => statRow("Spot · rezim " + esc(k), stats(v), "%")).join("")}
      </tbody></table></div>
      <div class="wac-note">Posisi virtual: diisi di harga pengamatan berikutnya setelah ENTRY READY, biaya ${(C().fees.side * 100).toFixed(2)}%/sisi. Futures dihitung dalam R (1R = risiko 1%). Sampel kecil = belum bermakna; t-stat &lt; 2 berarti belum terbukti.</div>
    </article>`;
    renderBacktest();
  }
  async function renderBacktest() {
    const box = $("btBox");
    if (S.bt === undefined) { try { S.bt = await fetchData("data/backtest.json"); } catch { S.bt = null; } }
    const bt = S.bt;
    if (!bt) { box.innerHTML = `<article class="panel"><div class="empty">Hasil backtest belum ada (data/backtest.json). Jalankan <code>node backtest/run.cjs</code>.</div></article>`; return; }
    const m = x => x ? `<td>${x.trades}</td><td>${pct(x.ret)}</td><td>${pct(-x.maxDD)}</td><td>${x.trades ? Math.round(x.win * 100) + "%" : "--"}</td><td>${x.pf == null ? "--" : x.pf.toFixed(2)}</td><td>${x.exp == null ? "--" : pct(x.exp)}</td><td>${x.sharpe == null ? "--" : x.sharpe.toFixed(2)}</td><td>${x.t == null ? "--" : x.t.toFixed(2)}</td>` : `<td colspan="8">--</td>`;
    box.innerHTML = `<article class="panel">
      <div class="bt-verdict ${bt.verdict.pass ? "ok" : "no"}">${bt.verdict.pass ? "✓ LOLOS KRITERIA" : "BELUM TERBUKTI"}</div>
      <div class="wac-note">${esc(bt.verdict.text)}</div>
      <div class="wac-note">${bt.coins.length} coin · ${esc(bt.period.from)} s/d ${esc(bt.period.to)} · candle 4h OKX · biaya ${(bt.fees * 100).toFixed(2)}%/sisi · SL dihitung lebih dulu bila SL &amp; TP kena di candle yang sama. Dibuat ${wib(bt.generated)}.</div>
      ${["test", "validation", "train"].map(sp => `<div class="sec-h" style="margin:10px 0 4px"><h2 style="font-size:14px">${{ test: "Test (out-of-sample)", validation: "Validasi", train: "Train" }[sp]}</h2><small>${esc(bt.splits[sp].from)} – ${esc(bt.splits[sp].to)}</small></div>
      <div class="tblw"><table class="tbl"><thead><tr><th>Strategi</th><th>Trade</th><th>Return</th><th>Max DD</th><th>Win</th><th>PF</th><th>Expectancy</th><th>Sharpe</th><th>t</th></tr></thead><tbody>
        ${bt.strategies.map(s => `<tr${s.key.startsWith("wac") ? ' class="hl"' : ""}><td>${esc(s.name)}</td>${m(s[sp])}</tr>`).join("")}
      </tbody></table></div>`).join("")}
      <div class="sec-h" style="margin:10px 0 4px"><h2 style="font-size:14px">Uji biaya 2× (test)</h2></div>
      <div class="tblw"><table class="tbl"><thead><tr><th>Strategi</th><th>Trade</th><th>Return</th><th>Max DD</th><th>Win</th><th>PF</th><th>Expectancy</th><th>Sharpe</th><th>t</th></tr></thead><tbody>
        ${bt.strategies.filter(s => s.test2x).map(s => `<tr><td>${esc(s.name)}</td>${m(s.test2x)}</tr>`).join("")}
      </tbody></table></div>
      ${(() => { const w = bt.strategies.find(s => s.key === "wacR"); if (!w || !w.perCoin) return ""; const row = (k, g) => `<tr><td>${esc(k)}</td><td>${g.n}</td><td>${Math.round(g.win / g.n * 100)}%</td><td>${pct(g.sum / g.n)}</td><td>${pct(g.sum)}</td></tr>`;
        const tb = (title, o) => `<div class="sec-h" style="margin:10px 0 4px"><h2 style="font-size:14px">${title}</h2><small>WAC + rezim · test</small></div><div class="tblw"><table class="tbl"><thead><tr><th></th><th>n</th><th>Win</th><th>Rata-rata</th><th>Jumlah</th></tr></thead><tbody>${Object.entries(o).sort((a, b) => b[1].n - a[1].n).map(([k, g]) => row(k, g)).join("") || `<tr><td colspan="5">tidak ada trade</td></tr>`}</tbody></table></div>`;
        return tb("Per coin", w.perCoin) + tb("Per rezim", w.perRegime) + tb("Jenis exit", w.exits || {}) + `<div class="wac-note">Biaya memakan ${w.test.feeShare == null ? "--" : Math.round(w.test.feeShare * 100) + "%"} dari profit kotor · kasus ambigu SL/TP satu candle: ${w.test.amb || 0}.</div>`; })()}
      <ul class="checks">${bt.verdict.checks.map(c => `<li class="${c.ok ? "ok" : "no"}">${esc(c.label)}</li>`).join("")}</ul>
      <div class="wac-note"><b>Keterbatasan:</b> ${bt.limits.map(esc).join(" · ")}</div>
    </article>`;
  }

  /* ---------- settings ---------- */
  function fillSettings() {
    $("w_equity").value = S.set.equity || ""; $("w_riskPct").value = S.set.riskPct || C().risk.riskPct;
    $("w_levCap").value = S.set.levCap || S.base.futures.hardCapLev; $("w_chase24").value = S.set.chase24 || S.base.chase.max24h * 100;
    $("w_cooldown").value = S.set.cooldown || S.base.reminders.cooldownMin;
    $("w_notif").innerHTML = NOTIF_KINDS.map(([k, l]) => `<label class="ck"><input type="checkbox" data-wn="${k}"${S.set.notif[k] ? " checked" : ""}> ${l}</label>`).join("");
  }
  function saveSettings() {
    const num = id => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : null; };
    S.set.equity = num("w_equity"); S.set.riskPct = Math.min(1, Math.max(0.5, num("w_riskPct") || 1));
    S.set.levCap = Math.min(50, num("w_levCap") || 50); S.set.chase24 = num("w_chase24"); S.set.cooldown = num("w_cooldown");
    for (const el of document.querySelectorAll("[data-wn]")) S.set.notif[el.dataset.wn] = el.checked;
    store.set("awt.wac", S.set);
    applyConfig();
    for (const k in FEEDS) for (const s of FEEDS[k].items) { s.wac = null; s.wacQ = 0; }
    rerenderAll();
  }

  /* ---------- chart overlay ---------- */
  function chartCtx(no) {
    const sig = S.state && S.state.signals.find(x => String(x.no) === String(no));
    return sig ? { mk: sig.mk || "BS", coin: sig.coin, wac: sig } : null;
  }

  /* ---------- boot ---------- */
  $("ikNew").addEventListener("click", () => { S.ikOrder = null; renderIkut(); $("ikF").scrollIntoView({ block: "start", behavior: "smooth" }); });
  document.addEventListener("click", e => {
    const w = e.target.closest("[data-wacwhy]");
    if (!w) return;
    const k = w.dataset.wacwhy;
    if (S.openWhy.has(k)) S.openWhy.delete(k); else S.openWhy.add(k);
    renderIkut(); if (VIEW === "home") renderHome();
  });
  document.addEventListener("click", e => { const b = e.target.closest("[data-wacchart]"); if (b) { const c = chartCtx(b.dataset.wacchart); if (c) openChart(c); } });
  $("btnSettings").addEventListener("click", () => { if (S.ready) fillSettings(); });
  $("setForm").addEventListener("submit", () => { if (S.ready) saveSettings(); });
  $("hCoin").addEventListener("input", renderTimeline);
  (async () => {
    if (!(await loadConfig())) { toast("Aturan WAC (config/wac.json) gagal dimuat"); return; }
    rerenderAll();
    for (const k in FEEDS) for (const x of FEEDS[k].items) if (x.kind !== "liq" && !x.wac) { x.wacQ = 0; queue(x); }
    await loadState();
    regime().then(() => { if (VIEW === "ikut") renderIkut(); }).catch(() => {});
    setInterval(loadState, 2 * 60e3);
    setInterval(zoneReminders, 15e3);
    setInterval(() => { if (VIEW === "ikut" || VIEW === "home") renderIkut(); }, 10e3);
  })();

  function refresh() { renderIkut(); if (VIEW === "hist") renderTimeline(); if (VIEW === "rekap") renderRekap(); }
  return { queue: s => { if (s.kind !== "liq") queue(s); }, block, renderIkut, renderHome, renderTimeline, renderRekap, verdictOf: s => s.wac && s.wac.verdict ? VERD[s.wac.verdict] : null, label: s => s.wac && s.wac.verdict };
})();
