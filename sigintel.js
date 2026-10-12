/* Signal Intelligence UI (spec Modul A + B; Modul C is an adapter waiting for API keys).
   Every non-liquidation card gets a flow label (who is moving?) and a T+5/15/60 tracker (still in?).
   - Binance Futures & Binance Spot: computed live here (fapi / data-api klines + OI history, CORS-friendly).
   - OKX Futures & OKX Spot: OKX's history endpoints block browsers, so labels come from the 24/7 recorder
     (data/flow-live.json, refreshed every 5 minutes) and are matched by coin + exchange + time.
   Thresholds come from config/flow.json and can be overridden per device in ⚙. WAC rules are not changed. */
"use strict";
const SIGI = (() => {
  const S = { base: null, ready: false, live: null, liveAt: 0, cache: new Map(), set: Object.assign({ notif: true, notifAll: false, over: {} }, store.get("awt.flow", {})), notified: store.get("awt.flowN", {}) };
  const LOCAL = ["BF", "BS"], M5 = 5 * 60e3;
  const fmtPct = (v, d = 1) => v == null ? "N/A" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d) + "%";
  const fundTxt = v => v == null ? "N/A" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(3) + "%";

  function apply() { const c = JSON.parse(JSON.stringify(S.base)); Object.assign(c, S.set.over || {}); FLOW.setConfig(c); }
  async function load() {
    for (const url of ["config/flow.json?t=" + Date.now(), REPO_RAW + "config/flow.json"]) {
      try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) { S.base = await r.json(); break; } } catch {}
    }
    if (!S.base) return false;
    apply(); S.ready = true; return true;
  }

  /* ---------- data: 5m USD buckets ---------- */
  const cached = async (key, ttl, fn) => { const h = S.cache.get(key); if (h && Date.now() - h.at < ttl) return h.v; const v = await fn(); S.cache.set(key, { at: Date.now(), v }); return v; };
  async function series(mk, coin) {
    return cached(mk + coin, 50e3, async () => {
      if (mk === "BS") {
        const k = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=5m&limit=60`);
        return k.map(x => ({ t: +x[0], buy: +x[10], sell: +x[7] - +x[10], oi: null, close: +x[4], high: +x[2] }));
      }
      const [k, oi] = await Promise.all([
        getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin}USDT&interval=5m&limit=60`),
        getJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin}USDT&period=5m&limit=60`).catch(() => [])
      ]);
      const om = new Map(oi.map(x => [+x.timestamp, +x.sumOpenInterestValue]));
      return k.map(x => ({ t: +x[0], buy: +x[10], sell: +x[7] - +x[10], oi: om.has(+x[0]) ? om.get(+x[0]) : null, close: +x[4], high: +x[2] }));
    });
  }
  async function loadLive() {
    if (Date.now() - S.liveAt < 110e3) return;
    S.liveAt = Date.now();
    try { S.live = await fetchData("data/flow-live.json"); } catch {}
  }
  function fromRecorder(s) {
    if (!S.live) return null;
    let best = null;
    for (const x of S.live.items) if (x.coin === s.coin && x.mk === s.mk && Math.abs(x.t - s.t) <= 180e3 && (!best || Math.abs(x.t - s.t) < Math.abs(best.t - s.t))) best = x;
    return best;
  }

  /* ---------- per-signal state ---------- */
  async function update(s) {
    if (s.kind === "liq") return false;
    const fi = s.fi || (s.fi = { trk: {} });
    const before = JSON.stringify(fi), now = Date.now();
    if (LOCAL.includes(s.mk)) {
      if (!fi.fl && now >= FLOW.bucketOf(s.t) + M5 + 30e3) {
        const ser = await series(s.mk, s.coin);
        const liqShort = s.mk === "BF" ? E.liqWin.filter(x => x.coin === s.coin && x.pos === "SHORT" && x.t >= FLOW.bucketOf(s.t) && x.t < FLOW.bucketOf(s.t) + M5).reduce((a, x) => a + x.v, 0) : 0;
        const fl = FLOW.classifyAt(ser, s.t, { funding: s.mk === "BF" ? (funding.has(s.coin) ? funding.get(s.coin) : null) : null, liqShort, spot: s.mk === "BS" }, now);
        if (fl) { fi.fl = fl; fi.src = "browser"; }
      }
      if (fi.fl && FLOW.TRACKED.includes(fi.fl.label)) {
        for (const cp of FLOW.cfg().checkpoints) {
          if (fi.trk[cp] || now < FLOW.bucketOf(s.t + cp * 60e3) + M5 + 30e3) continue;
          const r = FLOW.checkpoint(await series(s.mk, s.coin), s.t, fi.fl, cp, now);
          if (!r) break;
          const prev = FLOW.cfg().checkpoints.map(c => fi.trk[c]).filter(Boolean).pop();
          fi.trk[cp] = r;
          if (prev && prev.st !== r.st) alertStatus(s, fi, cp, r);
        }
      }
    } else {
      await loadLive();
      const x = fromRecorder(s);
      if (x) {
        const prevTrk = fi.trk || {};
        fi.fl = x.fl; fi.src = "perekam";
        for (const cp of FLOW.cfg().checkpoints) {
          const r = x.trk && x.trk[cp];
          if (r && !prevTrk[cp]) { const prev = FLOW.cfg().checkpoints.map(c => prevTrk[c]).filter(Boolean).pop(); fi.trk[cp] = r; if (prev && prev.st !== r.st) alertStatus(s, fi, cp, r); }
        }
      }
    }
    return JSON.stringify(fi) !== before;
  }
  function alertStatus(s, fi, cp, r) {
    const key = s.id + ":" + cp;
    if (!S.set.notif || S.notified[key] || s.hist) return;
    if (!S.set.notifAll && !["LONG_BARU", "SHORT_BARU"].includes(fi.fl.label)) return;
    S.notified[key] = Date.now();
    for (const k in S.notified) if (Date.now() - S.notified[k] > 86400e3) delete S.notified[k];
    store.set("awt.flowN", S.notified);
    const st = FLOW.STATUS[r.st], L = FLOW.LABELS[fi.fl.label];
    const body = `${L.text} · harga ${fmtPct(r.dp, 2)}${r.doi == null ? "" : ` · OI ${fmtPct(r.doi)}`} · CVD ${usd(Math.abs(r.cvd))} ${r.cvd >= 0 ? "beli" : "jual"} · ${r.why}`;
    beep(r.st !== "SUDAH_KELUAR");
    toast(`${s.coin} · T+${cp}: ${st.text}`);
    notify(`${st.icon} ${s.coin} · T+${cp}: ${st.text}`, body, "flow-" + key);
  }

  /* ---------- card block ---------- */
  function html(s) {
    if (s.kind === "liq") return "";
    const fi = s.fi || (s.fl ? { fl: s.fl, trk: s.trk || {}, src: "perekam" } : null), k = S.ready ? FLOW.cfg() : null;
    if (!S.ready) return "";
    if (!fi || !fi.fl) {
      const age = Date.now() - s.t;
      const why = (s.hist || age > 80 * 60e3) && LOCAL.includes(s.mk) ? "Label arus belum dicatat untuk sinyal ini."
        : LOCAL.includes(s.mk) ? "Label arus: menunggu candle 5 menit tutup (≤5 mnt)…"
        : age < 20 * 60e3 ? "Label arus OKX dihitung perekam 24/7 (muncul ±5–10 mnt)…" : "Perekam tidak mencatat sinyal ini (ambang berbeda) · label arus N/A.";
      return `<div class="fi-wait">${why}</div>`;
    }
    const fl = fi.fl, L = FLOW.LABELS[fl.label] || FLOW.LABELS.NETRAL;
    const parts = fl.spot ? [`Spot · OI tidak berlaku`, `Taker ${fl.ratio == null ? "N/A" : fl.ratio.toFixed(2) + "×"}`, `CVD 5m ${usd(Math.abs(fl.buy - fl.sell))} ${fl.buy >= fl.sell ? "beli" : "jual"}`]
      : [`OI ${fl.oiNA ? "N/A" : fmtPct(fl.oiPct)}`, `Funding ${fundTxt(fl.funding)}`, `Liq short ${usd(fl.liqShort || 0)}`, `Taker ${fl.ratio == null ? "N/A" : fl.ratio.toFixed(2) + "×"}`];
    const tracked = FLOW.TRACKED.includes(fl.label);
    const strip = tracked ? k.checkpoints.map(cp => {
      const r = fi.trk && fi.trk[cp];
      if (!r) return `<span class="fi-cp wait">T+${cp} ⏳</span>`;
      const st = FLOW.STATUS[r.st];
      return `<span class="fi-cp ${st.tone}" title="${esc(r.why)}">T+${cp} ${st.icon} ${st.text}</span>`;
    }).join("") : `<span class="fi-cp wait">Tidak dilacak (label netral)</span>`;
    return `<div class="fi-h"><span class="chip fi-${L.tone}">${L.icon} ${fl.label}</span>${(fl.tags || []).map(t => `<span class="chip dim" title="${esc(FLOW.TAGS[t] || "")}">${t}</span>`).join("")}<small>${fi.src === "perekam" ? "perekam" : ""}</small></div>
      <div class="fi-l">${parts.join(" · ")}</div>
      <div class="fi-cps">${strip}</div>
      <details class="why"><summary>Kenapa ${fl.label}?</summary><ul>
        <li>${esc(L.desc)}.</li>
        <li>Rasio taker beli/jual window 5 mnt: <b>${fl.ratio == null ? "N/A" : fl.ratio.toFixed(2)}</b> (beli dominan &gt; ${k.buyRatio}, jual dominan &lt; ${k.sellRatio}).</li>
        ${fl.spot ? `<li>Spot tidak punya open interest, jadi label hanya dari arus taker.</li>` : `<li>Perubahan OI selama window: <b>${fl.oiNA ? "N/A" : fmtPct(fl.oiPct, 2)}</b> (ambang ±${(k.oiPct * 100).toFixed(1)}%).</li>`}
        <li>Harga window: ${fmtPct(fl.dPrice, 2)} · turun dari high 3 jam: ${fmtPct(fl.drop3h)}.</li>
        ${(fl.tags || []).map(t => `<li><b>${t}</b>: ${esc(FLOW.TAGS[t] || "")}</li>`).join("")}
        ${tracked ? k.checkpoints.map(cp => { const r = fi.trk && fi.trk[cp]; return r ? `<li>T+${cp}: harga ${fmtPct(r.dp, 2)}${r.doi == null ? "" : ` · OI ${fmtPct(r.doi, 2)}`} · CVD ${usd(Math.abs(r.cvd))} ${r.cvd >= 0 ? "beli" : "jual"} · ${esc(r.why)}</li>` : ""; }).join("") : ""}
        ${fl.spot ? `<li>On-chain (Modul C): belum aktif, menunggu API key penyedia data.</li>` : ""}
        <li>Arus taker &amp; OI = agregat pasar, bukan identitas wallet. Label ini tidak mengubah skor WAC.</li>
      </ul></details>`;
  }
  function paint(s) { for (const el of document.querySelectorAll(`[data-fi="${CSS.escape(s.id)}"]`)) el.innerHTML = html(s); }

  /* ---------- loop over live cards ---------- */
  let busy = false;
  async function loop() {
    if (busy || !S.ready) return;
    busy = true;
    try {
      const now = Date.now();
      for (const k in FEEDS) for (const s of FEEDS[k].items) {
        if (s.kind === "liq" || s.hist || now - s.t > 75 * 60e3) continue;
        const fi = s.fi;
        if (fi && fi.fl && (!FLOW.TRACKED.includes(fi.fl.label) || FLOW.cfg().checkpoints.every(c => fi.trk && fi.trk[c]))) continue;
        try { if (await update(s)) { paint(s); dirtySave = true; } } catch {}
      }
    } finally { busy = false; }
  }

  /* ---------- Rekap: hit-rate per label (recorder data) ---------- */
  async function renderRekap() {
    const box = $("flowRekap");
    if (!box || !S.ready) return;
    let idx = null; try { idx = await fetchData("data/index.json"); } catch {}
    const tot = {};
    for (const d of (idx && idx.days) || []) for (const lab in d.flow || {}) {
      const g = (tot[lab] = tot[lab] || { n: 0, cp: {} }), x = d.flow[lab]; g.n += x.n;
      for (const c in x.cp) for (const st in x.cp[c]) { const h = (g.cp[c] = g.cp[c] || {}); h[st] = (h[st] || 0) + x.cp[c][st]; }
    }
    const labs = Object.keys(FLOW.LABELS).filter(l => tot[l]);
    if (!labs.length) { box.innerHTML = `<article class="panel"><div class="empty">Belum ada data label arus dari perekam. Data mulai terkumpul setelah perekam jalan dengan modul ini (tiap jam); kalibrasi ambang ideal setelah ±2 minggu.</div></article>`; return; }
    const pctOf = (h, st) => { const n = h ? Object.values(h).reduce((a, b) => a + b, 0) : 0; return n ? Math.round((h[st] || 0) / n * 100) + "%" : "--"; };
    const nOf = h => h ? Object.values(h).reduce((a, b) => a + b, 0) : 0;
    box.innerHTML = `<article class="panel"><div class="tblw"><table class="tbl"><thead><tr><th>Label</th><th>Sinyal</th><th>Dicek T+60</th><th>🚀 FT</th><th>✅ Di dalam</th><th>❌ Keluar</th><th>⏸️ Diam</th><th>🚀 FT T+15</th></tr></thead><tbody>
      ${labs.map(l => { const g = tot[l], h = g.cp[60], h15 = g.cp[15]; return `<tr><td>${FLOW.LABELS[l].icon} ${l}</td><td>${g.n}</td><td>${nOf(h)}</td><td>${pctOf(h, "FOLLOW_THROUGH")}</td><td>${pctOf(h, "MASIH_DI_DALAM")}</td><td>${pctOf(h, "SUDAH_KELUAR")}</td><td>${pctOf(h, "TIDAK_ADA_FT")}</td><td>${pctOf(h15, "FOLLOW_THROUGH")}</td></tr>`; }).join("")}
    </tbody></table></div>
    <div class="wac-note">Persentase dari sinyal yang sudah dicek pada checkpoint itu (rekaman perekam: OKX Futures, OKX Spot, Binance Spot · ${(idx.days || []).length} hari). Pakai ini untuk kalibrasi ambang di ⚙ setelah ±2 minggu data.</div></article>`;
  }

  /* ---------- settings ---------- */
  const FIELDS = [["buyRatio", "Taker beli dominan jika rasio >", 1, 0.05], ["sellRatio", "Taker jual dominan jika rasio <", 1, 0.01], ["oiPct", "Ambang perubahan OI (%)", 100, 0.1], ["fundingHigh", "Funding tinggi > (%)", 100, 0.005], ["fundingLow", "Funding negatif < (%)", 100, 0.005], ["bounceDrop", "BOUNCE_ZONE: turun dalam 3 jam > (%)", 100, 1], ["liqShortShare", "Likuidasi short > x% taker beli → SHORT_COVER", 100, 5], ["exitBurstShare", "Exit burst ≥ x% ukuran beli awal", 100, 5], ["ftPrice", "Follow-through: harga naik ≥ (%)", 100, 0.1]];
  function fill() {
    const k = FLOW.cfg();
    $("fl_fields").innerHTML = FIELDS.map(([key, label, mul, step]) => `<label for="fl_${key}">${label}<input id="fl_${key}" type="number" step="${step}" value="${+(k[key] * mul).toFixed(4)}"></label>`).join("") +
      `<label class="ck"><input type="checkbox" id="fl_notif"${S.set.notif ? " checked" : ""}> Notifikasi saat status T+5/15/60 berubah</label>
       <label class="ck"><input type="checkbox" id="fl_notifAll"${S.set.notifAll ? " checked" : ""}> …untuk semua label (default hanya LONG_BARU &amp; SHORT_BARU)</label>
       <small class="hint">Berlaku di browser ini. Label OKX dihitung perekam dengan config/flow.json.</small>`;
  }
  function save() {
    const over = {};
    for (const [key, , mul] of FIELDS) { const v = parseFloat($("fl_" + key).value); if (isFinite(v)) { const val = v / mul; if (Math.abs(val - S.base[key]) > 1e-9) over[key] = key === "fundingLow" ? val : val; } }
    S.set = { notif: $("fl_notif").checked, notifAll: $("fl_notifAll").checked, over };
    store.set("awt.flow", S.set);
    apply();
  }

  /* ---------- boot ---------- */
  $("btnSettings").addEventListener("click", () => { if (S.ready) fill(); });
  $("setForm").addEventListener("submit", () => { if (S.ready) save(); });
  (async () => {
    if (!(await load())) return;
    rerenderAll();
    loop(); setInterval(loop, 30e3);
    if (VIEW === "rekap") renderRekap();
  })();
  return { html, renderRekap, ready: () => S.ready };
})();
