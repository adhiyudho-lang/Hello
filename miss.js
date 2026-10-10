/* Rekap: why IKUT calls miss. Loads the recorded day files, takes every IKUT signal with a
   price outcome (4 jam, else 1 jam), tags each with the traits that tend to make it fail,
   and shows per trait how many misses carry it and how IKUT with vs without it performed.
   Uses helpers from app.js (fetchData, esc, pct, logo, $). */
"use strict";
const MISS = { at: 0, html: "" };

const TRAITS = [
  { key: "short", name: "SHORT melawan pasar", icon: "▼",
    test: s => s.dir === "down" && !(s.reco.reasons || []).some(r => /Searah tren BTC \(turun/.test(r)),
    why: "Sinyal jual/SHORT muncul saat BTC tidak sedang turun dan sentimen masih serakah, jadi harga cenderung kembali naik.",
    fix: "Matikan IKUT untuk SHORT kecuali tren BTC 1 jam turun DAN Fear & Greed < 55. Pakai SHORT hanya sebagai info." },
  { key: "chase", name: "Mengejar harga", icon: "⇡",
    test: s => s.kind === "pump" || (s.dir === "up" ? (s.chg24 || 0) > 0.10 : (s.chg24 || 0) < -0.10),
    why: "Harga sudah bergerak jauh (pump atau >10% dalam 24 jam) sebelum sinyal; sisa tenaganya kecil dan rawan koreksi.",
    fix: "Jangan beri IKUT kalau harga sudah bergerak >10% searah dalam 24 jam; tunggu pullback ke zona entry (status BISA DIIKUTI di tab IKUT)." },
  { key: "cluster", name: "Konfirmasi semu (coin sama berulang)", icon: "⟳",
    test: (s, ctx) => ctx.sameCoin(s) >= 3,
    why: "Coin yang sama memicu banyak sinyal di beberapa exchange dalam 1 jam. Skor ‘sinyal lain searah’ naik padahal sumbernya satu pergerakan yang sama.",
    fix: "Hitung konfirmasi hanya dari jenis sinyal berbeda (misal volume + likuidasi), bukan exchange berbeda untuk gerakan yang sama. Batasi 1 IKUT per coin per jam." },
  { key: "trade", name: "Satu order besar", icon: "◉",
    test: s => s.kind === "trade",
    why: "Satu market order besar bisa berupa hedging, rebalancing atau market maker, bukan awal tren.",
    fix: "Tunggu follow-through 5–15 menit: harga harus bertahan di atas (beli) / di bawah (jual) harga order sebelum IKUT." },
  { key: "taker", name: "Arah dari taker flow 1 menit", icon: "⇄",
    test: s => s.kind === "volume" && /^taker/.test(s.how || ""),
    why: "Taker beli/jual besar dalam 1 menit sering diserap order limit (absorpsi), jadi harga justru berbalik.",
    fix: "Wajibkan konfirmasi candle 15 menit ditutup searah sinyal dan di atas/bawah EMA20 sebelum IKUT." },
  { key: "fade", name: "Benar sebentar lalu berbalik", icon: "↺",
    test: s => s.o && s.o[1] != null && s.o[4] != null && dirRet(s, 1) > 0 && dirRet(s, 4) <= 0,
    why: "Arah sinyal benar di 1 jam pertama lalu berbalik sebelum 4 jam.",
    fix: "Ambil sebagian profit di TP1 dan geser stop ke entry; pakai batas waktu posisi 2–4 jam untuk sinyal whale jangka pendek." },
  { key: "noise", name: "Gerak terlalu kecil (noise)", icon: "≈",
    test: (s, ctx) => Math.abs(ctx.ret(s)) < 0.004,
    why: "Harga hampir tidak bergerak (<0,4%), jadi benar/salah ditentukan oleh noise, bukan sinyal.",
    fix: "Naikkan ambang volume/transaksi besar dan nilai sinyal berdasarkan TP/SL tersentuh, bukan arah di jam tertentu." },
  { key: "edge", name: "Skor pas di batas (75–79)", icon: "75",
    test: s => s.reco.score < 80,
    why: "Sinyal lolos IKUT dengan skor tepat di ambang 75, belum cukup kuat.",
    fix: "Naikkan ambang IKUT menjadi 80, atau anggap skor 75–79 sebagai TUNGGU sampai tab IKUT menyatakan BISA DIIKUTI." }
];
function dirRet(s, h) { const r = s.o && s.o[h]; return r == null ? null : (s.dir === "up" ? r : -r); }

async function openMiss(days) {
  const box = $("missBox");
  if (!box) return;
  if (MISS.html && Date.now() - MISS.at < 10 * 60000) { box.innerHTML = MISS.html; return; }
  box.innerHTML = `<div class="empty">Menganalisa sinyal IKUT yang meleset…</div>`;
  const want = days.slice(0, 14);
  const files = await Promise.all(want.map(d => fetchData(`data/days/${d.date}.json`).catch(() => null)));
  const all = files.filter(Boolean).flatMap(f => f.items || []);
  const ik = all.filter(s => s.reco && s.reco.verdict === "IKUT" && (s.dir === "up" || s.dir === "down"));
  // horizon: 4 jam when known, else 1 jam
  const ret = s => { const r4 = dirRet(s, 4); return r4 != null ? r4 : dirRet(s, 1); };
  const scored = ik.filter(s => ret(s) != null);
  if (scored.length < 5) { box.innerHTML = `<article class="panel"><div class="empty">Belum cukup sinyal IKUT yang sudah punya hasil harga (perlu ≥ 5, sekarang ${scored.length}). Cek lagi beberapa jam lagi.</div></article>`; return; }
  const byCoin = new Map();
  for (const s of ik) (byCoin.get(s.coin) || byCoin.set(s.coin, []).get(s.coin)).push(s.t);
  const ctx = { ret, sameCoin: s => (byCoin.get(s.coin) || []).filter(t => Math.abs(t - s.t) <= 3600e3).length };
  const miss = scored.filter(s => ret(s) <= 0), hit = scored.length - miss.length;
  const avgMiss = miss.reduce((a, s) => a + ret(s), 0) / (miss.length || 1);

  const rows = TRAITS.map(t => {
    const withT = scored.filter(s => t.test(s, ctx)), without = scored.filter(s => !t.test(s, ctx));
    const missT = miss.filter(s => t.test(s, ctx));
    const wr = a => a.length ? a.filter(s => ret(s) > 0).length / a.length : null;
    const coins = {}; for (const s of missT) coins[s.coin] = (coins[s.coin] || 0) + 1;
    return { t, nMiss: missT.length, share: missT.length / (miss.length || 1), wrWith: wr(withT), nWith: withT.length, wrWithout: wr(without), nWithout: without.length, coins: Object.entries(coins).sort((a, b) => b[1] - a[1]).slice(0, 4) };
  }).filter(r => r.nMiss > 0);
  // traits that really lower the hit rate first, then by how many misses they explain
  const worseOf = r => r.wrWith != null && r.wrWithout != null && r.wrWith < r.wrWithout ? 0 : 1;
  rows.sort((a, b) => worseOf(a) - worseOf(b) || b.nMiss - a.nMiss);

  const pctTxt = v => v == null ? "--" : Math.round(v * 100) + "%";
  const card = r => {
    const worse = r.wrWith != null && r.wrWithout != null && r.wrWith < r.wrWithout;
    return `<article class="miss-card${worse ? " bad" : ""}">
      <div class="miss-h"><span class="miss-ic">${r.t.icon}</span><div style="flex:1;min-width:0"><b>${esc(r.t.name)}</b><div class="foot">${r.nMiss} dari ${miss.length} sinyal meleset (${pctTxt(r.share)})</div></div></div>
      <div class="miss-bar"><i style="width:${(r.share * 100).toFixed(0)}%"></i></div>
      <div class="miss-cmp"><span>Dengan ciri ini <b class="${worse ? "down" : "up"}">${pctTxt(r.wrWith)} tepat</b> <small>(${r.nWith})</small></span><span>Tanpa <b>${pctTxt(r.wrWithout)}</b> <small>(${r.nWithout})</small></span></div>
      <p>${esc(r.t.why)}</p>
      ${r.coins.length ? `<div class="miss-coins">${r.coins.map(([c, n]) => `${logo(c, "sm")}<span>${esc(c)} ${n}×</span>`).join("")}</div>` : ""}
      <div class="lane up"><em>Perbaikan</em><span>${esc(r.t.fix)}</span></div>
    </article>`;
  };

  // segment table: which slices of IKUT hit or miss most
  const seg = (label, keyf, names) => {
    const g = {};
    for (const s of scored) { const k = keyf(s); (g[k] = g[k] || []).push(ret(s)); }
    return Object.entries(g).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => {
      const w = v.filter(x => x > 0).length / v.length, avg = v.reduce((a, x) => a + x, 0) / v.length;
      return `<tr><td>${label}</td><td><b>${esc((names && names[k]) || k)}</b></td><td class="n">${v.length}</td><td class="n ${w >= 0.55 ? "up" : w < 0.45 ? "down" : ""}">${Math.round(w * 100)}%</td><td class="n ${avg >= 0 ? "up" : "down"}">${pct(avg)}</td></tr>`;
    }).join("");
  };
  const kindN = { trade: "Order besar", volume: "Volume tak biasa", pump: "Pump/Dump", liq: "Likuidasi" };
  const dirN = { up: "LONG / beli", down: "SHORT / jual" };
  const top = rows.filter(r => r.wrWith != null && r.wrWithout != null && r.wrWith < r.wrWithout && r.nWith >= 3).slice(0, 3);

  // rules v1 vs v2: v1 = signals recorded before the new rules (reco.rules missing);
  // "simulasi" replays the v2 gates over the v1 IKUT calls to estimate the effect right away
  const v2gate = s => {
    if (s.reco.score < 80) return false;
    if (s.dir === "down" && !((s.reco.reasons || []).some(r => /Searah tren BTC \(turun/.test(r)) && (s.fng || 100) < 55)) return false;
    const moved = s.dir === "up" ? Math.max(s.chg24 || 0, s.kind === "pump" ? s.chg : 0) : -Math.min(s.chg24 || 0, s.kind === "pump" ? s.chg : 0);
    if (moved > 0.10) return false;
    if (s.kind === "volume" && /^taker/.test(s.how || "")) return false;
    return true;
  };
  const firstPerHour = list => { const last = {}; return list.slice().sort((a, b) => a.t - b.t).filter(s => { const k = s.coin + s.dir; if (last[k] && s.t - last[k] < 3600e3) return false; last[k] = s.t; return true; }); };
  const v1 = scored.filter(s => !s.reco.rules), v2 = scored.filter(s => s.reco.rules >= 2);
  const sim = firstPerHour(v1.filter(v2gate));
  const stat = (label, list, note) => {
    const n = list.length, w = n ? list.filter(s => ret(s) > 0).length / n : null;
    const tp = list.filter(s => s.o && s.o.tp != null), tpw = tp.length ? tp.filter(s => s.o.tp === 1).length / tp.length : null, slw = tp.length ? tp.filter(s => s.o.tp === -1).length / tp.length : null;
    return `<tr><td><b>${label}</b><div class="foot">${note}</div></td><td class="num">${n}</td><td class="num ${w == null ? "" : w >= 0.55 ? "up" : w < 0.45 ? "down" : ""}">${pctTxt(w)}</td><td class="num">${tp.length ? `<span class="up">${pctTxt(tpw)}</span> / <span class="down">${pctTxt(slw)}</span>` : "--"}</td></tr>`;
  };
  const cmpHtml = `<div class="sec-h"><h2>Aturan lama vs baru</h2><small>IKUT yang sudah punya hasil</small></div>
  <div class="tblwrap"><table class="t"><thead><tr><th>Aturan</th><th class="num">IKUT</th><th class="num">Tepat 4j</th><th class="num">TP1 / SL dulu</th></tr></thead><tbody>
    ${stat("Lama (v1)", v1, "ambang 75, semua sinyal")}
    ${stat("Simulasi aturan baru", sim, "v1 yang lolos aturan v2")}
    ${stat("Baru (v2, live)", v2, v2.length ? "sejak aturan baru aktif" : "belum ada hasil, tunggu beberapa jam")}
  </tbody></table></div>
  <div class="foot">TP1 / SL dulu = mana yang tersentuh lebih dulu dalam 4 jam memakai level di rencana sinyal (dicek perekam tiap jam, hanya untuk sinyal baru).</div>`;

  MISS.html = cmpHtml + `
  <article class="panel">
    <div class="tiles" style="margin-bottom:10px">
      <div class="tile w3"><div class="tx"><b>${scored.length}</b><small>IKUT dengan hasil harga</small></div></div>
      <div class="tile w3"><div class="tx"><b class="down">${miss.length}</b><small>meleset · rata-rata ${pct(avgMiss)}</small></div></div>
    </div>
    <div class="foot">Dinilai pada 4 jam setelah sinyal (1 jam bila 4 jam belum ada), dari ${files.filter(Boolean).length} hari rekaman. Satu sinyal bisa punya lebih dari satu ciri. Sampel masih kecil, jadi angka akan lebih stabil setelah beberapa hari.</div>
  </article>
  <div class="sec-h"><h2>Kelompok penyebab</h2><small>diurutkan dari yang paling sering</small></div>
  <div class="miss-grid">${rows.map(card).join("")}</div>
  <div class="sec-h"><h2>Bagian mana yang tepat / meleset</h2></div>
  <div class="tblwrap"><table class="t"><thead><tr><th>Kelompok</th><th>Nilai</th><th class="num">IKUT</th><th class="num">Tepat</th><th class="num">Rata-rata</th></tr></thead><tbody>
    ${seg("Jenis sinyal", s => s.kind, kindN)}${seg("Arah", s => s.dir, dirN)}${seg("Exchange", s => EX[s.mk] || s.mk)}${seg("Skor", s => s.reco.score >= 80 ? "80+" : "75–79")}
  </tbody></table></div>
  <div class="sec-h"><h2>Pendekatan yang disarankan</h2></div>
  <article class="panel glow"><ol class="miss-plan">
    ${top.map(r => `<li><b>${esc(r.t.name)}:</b> ${esc(r.t.fix)} <span class="foot">(dengan ciri ini ${pctTxt(r.wrWith)} tepat vs ${pctTxt(r.wrWithout)} tanpa)</span></li>`).join("")}
    <li><b>Masuk hanya saat BISA DIIKUTI.</b> Jadikan status di tab IKUT (harga di zona entry + RSI, MACD, EMA dan tren setuju) sebagai syarat masuk, bukan label IKUT saat sinyal pertama muncul.</li>
    <li><b>Nilai dengan TP/SL, bukan arah di jam tertentu.</b> Sinyal dianggap berhasil kalau TP1 tersentuh sebelum SL; ini lebih dekat dengan cara kamu benar-benar trading.</li>
    <li><b>Kelola posisi:</b> ambil 50% di TP1, geser stop ke entry, dan tutup sisanya maksimal 4 jam kalau target belum tercapai.</li>
  </ol>
  <div class="foot">Perbaikan aturan belum diterapkan otomatis. Bilang "terapkan perbaikan IKUT" kalau ingin aturan di atas dipakai mesin sinyal, lalu bandingkan akurasinya minggu depan.</div></article>`;
  MISS.at = Date.now();
  if ($("missBox")) $("missBox").innerHTML = MISS.html;
}
