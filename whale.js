/* Whale Hyperliquid tab. Reads data/hl.json from the 24/7 recorder (top 10 account size + top 10 PnL 30d +
   Adhi's wallets from config/hl-watch/) and, while the tab is open, refreshes positions straight from the public
   Hyperliquid API (CORS-friendly) every minute, turning changes into live events.
   "Pantau & beri nama" opens GitHub with config/hl-watch/<address>.json pre-filled: one Commit and the
   recorder watches that wallet 24/7. Until then the wallet is kept in this browser as "menunggu commit". */
"use strict";
const HLW = (() => {
  const REPO = "https://github.com/adhiyudho-lang/Hello", BR = "claude/crypto-whale-dashboard";
  const S = { data: null, at: 0, seg: store.get("awt.hlSeg", "size"), coin: null, live: new Map(), liveEv: [], busy: false, open: new Set(),
    local: store.get("awt.hlWatch", {}), seenEv: store.get("awt.hlSeen", 0), set: Object.assign({ notif: true, minUsd: 250000 }, store.get("awt.hlSet", {})) };
  const M = v => usd(Math.abs(v || 0));
  const pnlTxt = v => v == null ? "--" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : "−"}${M(v)}</span>`;
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} mnt lalu` : m < 1440 ? `${Math.floor(m / 60)} jam lalu` : `${Math.floor(m / 1440)} hari lalu`; };

  async function load(force) {
    if (!force && S.data && Date.now() - S.at < 110e3) return;
    try { S.data = await fetchData("data/hl.json"); S.at = Date.now(); } catch {}
    // a wallet committed to the repo no longer needs the local "pending" copy
    for (const c of (S.data && S.data.custom) || []) if (S.local[c.addr] && S.local[c.addr].name === c.name) { delete S.local[c.addr]; store.set("awt.hlWatch", S.local); }
  }
  const custom = () => { const m = new Map(((S.data && S.data.custom) || []).map(c => [c.addr, { name: c.name, repo: true }])); for (const [a, x] of Object.entries(S.local)) m.set(a, { name: x.name, repo: m.has(a), pending: true }); return m; };
  function wallet(addr) { return Object.assign({ addr }, (S.data && S.data.wallets[addr]) || {}, S.live.get(addr) || {}); }
  function label(addr) {
    const c = custom().get(addr); if (c && c.name) return c.name;
    const t = (S.data && S.data.top) || { size: [], pnl: [] }, i = t.size.indexOf(addr), j = t.pnl.indexOf(addr), w = wallet(addr);
    return w.lbName || (i >= 0 ? `Top akun #${i + 1}` : j >= 0 ? `Top PnL #${j + 1}` : HL.short(addr));
  }
  const list = () => {
    const t = (S.data && S.data.top) || { size: [], pnl: [] };
    const xs = S.seg === "size" ? t.size : S.seg === "pnl" ? t.pnl : [...custom().keys()];
    return S.coin ? xs.filter(a => (wallet(a).positions || []).some(p => p.coin === S.coin)) : xs;
  };

  /* ---------- live refresh while the tab is open ---------- */
  async function info(body) { const r = await fetch(HL.API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(r.status); return r.json(); }
  async function refreshLive() {
    if (S.busy || VIEW !== "whale") return;
    S.busy = true;
    try {
      const addrs = new Set([...list(), ...Object.keys(S.local)]);
      for (const a of addrs) {
        if (VIEW !== "whale") break;
        try {
          const st = await info({ type: "clearinghouseState", user: a });
          const pos = HL.positions(st), prev = wallet(a).positions, known = !!(S.live.get(a) || (S.data && S.data.wallets[a]));
          if (known && prev) for (const e of HL.diff(prev, pos, S.set.minUsd, { t: Date.now(), addr: a })) liveEvent(e);
          S.live.set(a, Object.assign({}, HL.summary(st), { positions: pos, at: Date.now() }));
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }
      render();
    } finally { S.busy = false; }
  }
  function liveEvent(e) {
    e.who = label(e.addr); e.live = true;
    if (S.liveEv.some(x => x.addr === e.addr && x.coin === e.coin && x.type === e.type && Math.abs(x.t - e.t) < 120e3)) return;
    S.liveEv.unshift(e); S.liveEv.length = Math.min(S.liveEv.length, 100);
    notifyEv(e);
  }
  function notifyEv(e) {
    if (!S.set.notif) return;
    const txt = evText(e);
    beep(e.side !== "SHORT");
    toast(`🐋 ${txt}`);
    notify(`🐋 Whale Hyperliquid`, txt, "hl-" + e.addr + e.coin + e.t);
  }
  const evText = e => e.type === "DEPOSIT" || e.type === "WITHDRAW" ? `${e.who} ${HL.EVENT_TEXT[e.type]} ${M(e.usd)}` : `${e.who} ${HL.EVENT_TEXT[e.type]} ${e.side} ${e.coin} ${M(e.usd)}${e.lev ? ` · ${e.lev}x` : ""}${e.liq ? ` · likuidasi ${px(e.liq)}` : ""}`;

  /* one activity row: Tanggal | Jam | Akun | Arah | Coin | Deskripsi */
  const DAY = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", weekday: "short", day: "2-digit", month: "short" });
  const HMS = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const ACT = { OPEN: ["Buka", "buy"], ADD: ["Tambah", "buy"], REDUCE: ["Kurangi", "neu"], CLOSE: ["Tutup", "dim"], FLIP: ["Balik arah", "neu"], DEPOSIT: ["Deposit USDC", "buy"], WITHDRAW: ["Tarik USDC", "sell"] };
  function acct(addr) {
    const c = custom().get(addr), t = (S.data && S.data.top) || { size: [], pnl: [] }, i = t.size.indexOf(addr), j = t.pnl.indexOf(addr);
    if (c && c.name) return `<b>${esc(c.name)}</b><small>${HL.short(addr)}</small>`;
    if (i >= 0) return `<b>#${i + 1}</b><small>Top akun</small>`;
    if (j >= 0) return `<b>#${j + 1}</b><small>Top PnL 30h</small>`;
    return `<b>${HL.short(addr)}</b><small>wallet</small>`;
  }
  function evRow(e) {
    const d = new Date(e.t), [act, tone] = ACT[e.type] || [e.type, "dim"], flow = e.type === "DEPOSIT" || e.type === "WITHDRAW";
    const side = flow ? `<span class="chip dim">—</span>` : `<span class="chip ${e.side === "LONG" ? "buy" : "sell"}">${e.side === "LONG" ? "▲ LONG" : "▼ SHORT"}</span>`;
    const bits = [`<b>${M(e.usd)}</b>`];
    if (!flow) {
      if (e.lev) bits.push(`${e.lev}x`);
      if (e.price) bits.push(`harga ${px(e.price)}`);
      if (e.liq) bits.push(`likuidasi ${px(e.liq)}`);
      if (e.type === "CLOSE" && e.pnl != null) bits.push(`PnL ${pnlTxt(e.pnl)}`);
      if (e.type === "FLIP" && e.from) bits.push(`dari ${e.from}`);
    } else bits.push(e.type === "DEPOSIT" ? "modal masuk untuk trading" : "modal ditarik keluar");
    return `<tr><td>${DAY.format(d)}</td><td class="mono">${HMS.format(d).replace(/\./g, ":")}${e.live ? `<small class="live">live</small>` : ""}</td><td class="acct">${acct(e.addr)}</td><td${flow ? ' class="na"' : ""}>${side}</td><td${e.coin ? "" : ' class="na"'}>${e.coin ? `<span class="coin">${logo(e.coin, "sm")}${esc(e.coin)}</span>` : "—"}</td><td class="desc"><span class="chip ${tone}">${act}</span> ${bits.join(" · ")}</td></tr>`;
  }

  /* ---------- rendering ---------- */
  function render() {
    if (VIEW !== "whale") return;
    const d = S.data;
    $("hlUpd").textContent = d && d.updated ? `perekam ${ago(d.updated)}` : "belum ada data perekam";
    // per-coin long vs short over the watched wallets (live where available)
    const all = [...new Set([...(d ? [...d.top.size, ...d.top.pnl] : []), ...custom().keys()])].map(wallet);
    const coins = Object.entries(HL.coins(all)).map(([c, v]) => ({ c, ...v, tot: v.long + v.short }));
    const focus = new Set(typeof FOCUS !== "undefined" ? FOCUS : []);
    coins.sort((a, b) => (focus.has(b.c) - focus.has(a.c)) || b.tot - a.tot);
    const rows = coins.filter(x => x.tot >= 1e6).slice(0, 14);
    $("hlCoins").innerHTML = rows.length ? `<article class="panel">${rows.map(x => `<button type="button" class="hl-coin" data-hlcoin="${esc(x.c)}" aria-pressed="${S.coin === x.c}">
        <b>${logo(x.c, "sm")}${esc(x.c)}</b>
        <div><div class="bar"><i style="width:${(x.long / x.tot * 100).toFixed(1)}%;background:var(--buy)"></i><i style="width:${(x.short / x.tot * 100).toFixed(1)}%;background:var(--sell)"></i></div>
        <small><span class="up">L ${M(x.long)} · ${x.nLong}</span><span class="down">S ${M(x.short)} · ${x.nShort}</span></small></div></button>`).join("")}</article>`
      : `<article class="panel"><div class="empty">Belum ada posisi whale. Data muncul setelah perekam jalan (tiap jam).</div></article>`;
    // events: recorder + live, newest first
    const evsAll = [...S.liveEv, ...((d && d.events) || []).slice().reverse()].filter(e => !S.coin || e.coin === S.coin);
    const evs = evsAll.slice(0, S.evShown || 30);
    $("hlEvents").innerHTML = `<article class="panel">${evs.length ? `<div class="tblw"><table class="hl-evt"><thead><tr><th>Tanggal</th><th>Jam</th><th>Akun</th><th>Arah</th><th>Coin</th><th>Deskripsi</th></tr></thead><tbody>${evs.map(evRow).join("")}</tbody></table></div>
      ${evsAll.length > evs.length ? `<button type="button" class="btn ghost morebtn" data-hlevmore>Tampilkan lagi (${evsAll.length - evs.length})</button>` : ""}`
      : `<div class="empty">Belum ada aktivitas ≥ ${M((d && d.cfg && d.cfg.minEventUsd) || S.set.minUsd)}${S.coin ? ` untuk ${esc(S.coin)}` : ""}.</div>`}</article>`;
    for (const b of $("hlSeg").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.hl === S.seg);
    $("hlFilt").innerHTML = S.coin ? `filter ${esc(S.coin)} · <a href="#" data-hlcoin="">hapus</a>` : "";
    const xs = list();
    $("hlList").innerHTML = xs.length ? xs.map(card).join("") : `<article class="panel"><div class="empty">${S.seg === "mine" ? "Belum ada wallet pilihanmu. Ketuk “Pantau & beri nama” di kartu wallet, atau tempel alamat di atas." : "Belum ada data."}</div></article>`;
    const n = ((d && d.events) || []).filter(e => e.t > S.seenEv).length;
    $("hlBadge").hidden = true;
    if (n) { S.seenEv = Math.max(...d.events.map(e => e.t)); store.set("awt.hlSeen", S.seenEv); }
  }
  function card(addr) {
    const w = wallet(addr), c = custom().get(addr), t = (S.data && S.data.top) || { size: [], pnl: [] };
    const i = t.size.indexOf(addr), j = t.pnl.indexOf(addr), m = w.perf && w.perf.month;
    const pos = (w.positions || []).filter(p => !S.coin || p.coin === S.coin), showAll = S.open.has(addr), shown = showAll ? pos : pos.slice(0, 6);
    return `<article class="ik hl-w">
      <div class="ik-h"><div class="id"><b>${esc(label(addr))}</b><small class="addr">${HL.short(addr)} · <a href="https://app.hyperliquid.xyz/explorer/address/${addr}" target="_blank" rel="noopener">explorer ↗</a>${w.at ? ` · posisi ${ago(w.at)}` : ""}</small></div></div>
      <div class="hl-tags">${i >= 0 ? `<span class="chip dim">Top akun #${i + 1}</span>` : ""}${j >= 0 ? `<span class="chip dim">Top PnL 30h #${j + 1}</span>` : ""}${c ? `<span class="chip ${c.repo ? "buy" : "neu"}">${c.repo ? "Dipantau 24/7" : "Menunggu commit"}</span>` : ""}</div>
      <div class="lv">
        <div><small>Nilai akun</small><span>${w.accountValue ? M(w.accountValue) : w.perpValue ? M(w.perpValue) : "--"}</span></div>
        <div><small>Margin perp</small><span>${w.perpValue != null ? M(w.perpValue) : "--"}</span></div>
        <div><small>PnL 30 hari</small><span>${m ? pnlTxt(m.pnl) : "--"}${m && m.roi ? ` <small style="display:inline">(${(m.roi * 100).toFixed(1)}%)</small>` : ""}</span></div>
        <div><small>Total posisi</small><span>${M(pos.reduce((a, p) => a + p.ntl, 0))} · ${pos.length}</span></div>
        <div><small>Long / Short</small><span><span class="up">${M(pos.filter(p => p.side === "LONG").reduce((a, p) => a + p.ntl, 0))}</span> / <span class="down">${M(pos.filter(p => p.side === "SHORT").reduce((a, p) => a + p.ntl, 0))}</span></span></div>
      </div>
      ${pos.length ? `<div class="tblw"><table class="hl-pos"><thead><tr><th>Coin</th><th>Arah</th><th>Posisi</th><th>Entry</th><th>Lev</th><th>Likuidasi</th><th>uPnL</th></tr></thead><tbody>
        ${shown.map(p => `<tr><td>${esc(p.coin)}</td><td><span class="chip ${p.side === "LONG" ? "buy" : "sell"}">${p.side === "LONG" ? "▲ LONG" : "▼ SHORT"}</span></td><td>${M(p.ntl)}</td><td>${px(p.entry)}</td><td>${p.lev || "--"}x</td><td>${p.liq ? px(p.liq) : "--"}</td><td>${pnlTxt(p.upnl)}</td></tr>`).join("")}
      </tbody></table></div>${pos.length > 6 ? `<button type="button" class="btn ghost" data-hlmore="${addr}">${showAll ? "Ringkas" : `Lihat semua ${pos.length} posisi`}</button>` : ""}` : `<div class="wac-note">Tidak ada posisi terbuka${S.coin ? ` di ${esc(S.coin)}` : ""}.</div>`}
      <div class="acts">${c ? `<button type="button" data-hlname="${addr}">Ubah nama</button><button type="button" data-hlstop="${addr}">Berhenti pantau</button>` : `<button type="button" class="pri" data-hlwatch="${addr}">Pantau &amp; beri nama</button>`}</div>
    </article>`;
  }

  /* ---------- watch / rename / stop (GitHub pre-filled pages, one Commit) ---------- */
  function watch(addr, name) {
    addr = addr.toLowerCase();
    S.local[addr] = { name, at: Date.now() }; store.set("awt.hlWatch", S.local);
    const body = JSON.stringify({ address: addr, name }, null, 2) + "\n";
    window.open(`${REPO}/new/${BR}?filename=${encodeURIComponent(`config/hl-watch/${addr}.json`)}&value=${encodeURIComponent(body)}`, "_blank", "noopener");
    toast("GitHub terbuka: tekan “Commit changes” agar perekam memantau 24/7");
    render();
  }
  function ask(addr, cur) { const n = prompt(`Nama untuk wallet ${HL.short(addr)}`, cur || ""); return n == null ? null : n.trim().slice(0, 40) || HL.short(addr); }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-hlevmore]")) { S.evShown = (S.evShown || 30) + 50; render(); return; }
    const b = e.target.closest("[data-hlwatch],[data-hlname],[data-hlstop],[data-hlmore],[data-hlcoin],#hlSeg button,#hlAddBtn");
    if (!b) return;
    if (b.matches("#hlSeg button")) { S.seg = b.dataset.hl; store.set("awt.hlSeg", S.seg); render(); refreshLive(); return; }
    if (b.dataset.hlcoin !== undefined) { e.preventDefault(); S.coin = b.dataset.hlcoin && S.coin !== b.dataset.hlcoin ? b.dataset.hlcoin : null; render(); return; }
    if (b.dataset.hlmore) { const a = b.dataset.hlmore; if (S.open.has(a)) S.open.delete(a); else S.open.add(a); render(); return; }
    if (b.id === "hlAddBtn") {
      const a = $("hlAddr").value.trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return toast("Alamat harus 0x + 40 karakter heksadesimal");
      const n = ask(a); if (n == null) return;
      $("hlAddr").value = ""; S.seg = "mine"; store.set("awt.hlSeg", S.seg); watch(a, n); refreshLive(); return;
    }
    if (b.dataset.hlwatch) { const a = b.dataset.hlwatch, n = ask(a, label(a).startsWith("Top ") ? "" : label(a)); if (n != null) watch(a, n); return; }
    if (b.dataset.hlname) {
      const a = b.dataset.hlname, c = custom().get(a), n = ask(a, c && c.name); if (n == null) return;
      if (c && c.repo) { S.local[a] = { name: n, at: Date.now() }; store.set("awt.hlWatch", S.local); window.open(`${REPO}/edit/${BR}/config/hl-watch/${a}.json`, "_blank", "noopener"); toast(`Ganti "name" menjadi "${n}" lalu Commit`); render(); }
      else watch(a, n);
      return;
    }
    if (b.dataset.hlstop) {
      const a = b.dataset.hlstop, c = custom().get(a);
      delete S.local[a]; store.set("awt.hlWatch", S.local);
      if (c && c.repo) { window.open(`${REPO}/delete/${BR}/config/hl-watch/${a}.json`, "_blank", "noopener"); toast("Tekan “Commit changes” untuk berhenti memantau 24/7"); }
      render();
    }
  });

  /* ---------- signal-card context (feature 3) ---------- */
  function cardLine(coin) {
    const d = S.data; if (!d || !d.coins || !d.coins[coin]) return "";
    const x = d.coins[coin], tot = x.long + x.short; if (tot < 1e6) return "";
    const tone = x.long > x.short * 1.5 ? "up" : x.short > x.long * 1.5 ? "down" : "";
    return `<div class="fi-hl">🐋 Whale Hyperliquid: <span class="up">long ${M(x.long)}</span> · <span class="down">short ${M(x.short)}</span> (${x.nLong + x.nShort} posisi) <a href="#whale" data-go="whale" class="${tone}">lihat</a></div>`;
  }

  /* ---------- notifications from recorder events (while the page is open) ---------- */
  let lastEv = store.get("awt.hlLastEv", Date.now());
  async function poll() {
    await load();
    const evs = ((S.data && S.data.events) || []).filter(e => e.t > lastEv);
    if (evs.length) {
      lastEv = Math.max(...evs.map(e => e.t)); store.set("awt.hlLastEv", lastEv);
      for (const e of evs.slice(-3)) notifyEv(e);
      if (VIEW !== "whale") { $("hlBadge").hidden = false; $("hlBadge").textContent = evs.length; }
    }
    if (VIEW === "whale") render();
  }
  $("btnSettings").addEventListener("click", () => { $("hl_notif").checked = !!S.set.notif; $("hl_min").value = S.set.minUsd; });
  $("setForm").addEventListener("submit", () => { const v = parseFloat($("hl_min").value); S.set = { notif: $("hl_notif").checked, minUsd: isFinite(v) && v >= 10000 ? v : 250000 }; store.set("awt.hlSet", S.set); });
  (async () => { await load(true); if (VIEW === "whale") open(); rerenderAll(); setInterval(poll, 120e3); setInterval(refreshLive, 60e3); })();
  async function open() { await load(); render(); refreshLive(); }
  return { open, cardLine, render };
})();
