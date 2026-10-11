# Hello

## Adhi Whale Terminal

Tampilan mobile-first ala app exchange: menu bawah (Beranda, Sinyal, IKUT, ETF Brief, Riwayat, Rekap), logo coin,
grafik mini 1 jam di tiap sinyal, heatmap pasar, gauge Fear & Greed, dan chart candle (TradingView
Lightweight Charts) dengan garis Entry/SL/TP serta support & resistance. File: `index.html` (tampilan),
`app.js` (logika browser), `engine.js` (deteksi sinyal), `wac.js` + `config/wac.json` (aturan WAC, dipakai juga oleh perekam), `wacui.js` (tampilan WAC).

Dashboard crypto live dalam satu file (`index.html`), mirip feed KJo Terminal:

1. **#whale-sniper**: order besar (proxy) & volume 1 menit tak biasa. Hijau = arus taker beli, merah = arus taker jual (proxy, bukan bukti whale).
2. **#liquidation-feed**: likuidasi Binance Futures & OKX. Hijau = LONG terlikuidasi, merah = SHORT terlikuidasi.
3. **#sinyal-whale**: PUMP / DUMP (harga bergerak ≥ X% dalam N menit) di Binance Futures, Binance Spot, OKX Futures, OKX Spot.
4. **#fear-greed-index**: gauge, perbandingan kemarin / 7 hari / 30 hari, grafik 30 hari, dan artinya.

Setiap sinyal punya **saran WAC untuk Adhi** (BELI SPOT / TUNGGU PULLBACK / HINDARI, skor 0–100), SPOT dulu lalu futures (lihat bagian WAC di bawah). Tombol **Tanya Claude** membuka claude.ai dengan data sinyal sudah terisi.

### Cara membuka

- **GitHub Pages**: Settings → Pages → Source "GitHub Actions" (workflow `pages.yml` men-deploy tiap push).
  Dashboard akan ada di `https://adhiyudho-lang.github.io/hello/`.
- **Lokal**: download `index.html`, buka dengan Chrome/Safari.

### Sumber data (gratis, tanpa API key)

| Data | Sumber |
|---|---|
| Harga & volume semua pair USDT | Binance Futures/Spot websocket `!miniTicker@arr`, OKX REST tickers (tiap 10 detik) |
| Transaksi besar | Binance `aggTrade` untuk 40 pair futures & 30 pair spot dengan volume terbesar |
| Likuidasi | Binance `!forceOrder@arr`, OKX `liquidation-orders` |
| Funding rate | Binance `premiumIndex` (tiap 60 detik) |
| Fear & Greed | api.alternative.me (tiap 30 menit) |

Catatan: Binance hanya mengirim maks 1 likuidasi per coin per detik, jadi total likuidasi bisa lebih kecil dari Coinglass.
Sinyal mulai muncul setelah ±1 menit dashboard dibuka (butuh riwayat harga). Threshold bisa diatur lewat tombol ⚙ Threshold.

### Menu ETF Brief (Crypto ETF Daily Brief)

Brief harian **Senin–Jumat ±07.00 WIB** (siap ±07.15). Routine Claude "Crypto ETF Daily Brief" berjalan 07.02 WIB:
`node recorder/brief-build.cjs draft` menghitung semua angka (harga, perubahan 7/30 hari, range 50 hari, EMA5/25/99,
swing high/low) dari candle harian OKX, lalu Claude meriset berita, kalender makro, event token & arus ETF dan menulis
narasinya saja. `node recorder/brief-build.cjs build narasi.json` menggabungkan, memvalidasi (zona harus dekat harga nyata,
minimal 3 sumber, dst.) dan menulis `data/brief.json`. Angka tidak pernah diketik tangan. Bila brief tidak terbit,
dashboard menampilkan peringatan "belum diperbarui".
Arus harian ETF spot BTC, ETH, SOL (CoinMarketCap) dan per penerbit BTC (bitbo.io) ada di `data/etf.json`,
diambil perekam tiap jam lewat `recorder/etf.cjs`. Tab Altcoin memakai skor fundamental framework Adhi
di `data/fundamental.json` (70%) + teknikal brief (30%). Sub-tab: Ringkasan, Arus ETF, Event, Pengingat, Teknikal BTC, Altcoin, Aksi.

### Saran IKUT = strategi WAC (Whale Accumulation Confirmation)

Sejak 11 Okt 2026 semua saran memakai aturan WAC (`wac.js`, parameter di `config/wac.json`). **SPOT prioritas**,
futures sekunder. Hanya sinyal dan notifikasi, tidak pernah menempatkan order.

- **Kejujuran data.** Volume tak biasa & arus taker hanya *proxy* order agresif di exchange (label "Arus: Taker Beli/Jual",
  "Order besar (proxy)"), bukan bukti whale membeli. Verdict (BELI SPOT / TUNGGU PULLBACK / HINDARI) hanya di blok saran.
  Komponen tanpa data = N/A; ETF untuk coin non-ETF = "tidak berlaku". Coverage & keyakinan selalu ditampilkan. Data stale → tidak ada BELI.
- **Skor WAC 0–100.** Aset ETF (`etfAssets`: BTC, ETH, SOL): ETF 35 · arus 35 · teknikal 20 · rezim 10.
  Non-ETF: arus 54 · teknikal 31 · rezim 15. Kelas: ≥80 STRONG ACCUMULATION, 65–79 ACCUMULATION, 50–64 WATCH,
  35–49 DISTRIBUTION RISK, <35 DISTRIBUTION. Coverage < 50% → maksimal WATCH. Proxy tidak pernah STRONG.
- **Siklus sinyal bernomor (#N)** dicatat perekam 24/7 di `data/wac.json`:
  WATCH → CONFIRMED → ENTRY READY → POSITION (virtual) → TP1 → EXIT, cabang BATAL / KEDALUWARSA (72 jam).
  Sinyal baru di coin yang sama ditautkan "lanjutan dari #N".
- **Jangan kejar:** naik 24 jam > 20%, close 4h > EMA20 × 1,10 atau > 2 ATR, RSI 4h > 75 → maksimal WATCH / TUNGGU PULLBACK.
- **Konfirmasi (4h close):** close > EMA20, volume > 1,3× rata-rata 20, rezim BTC bukan BEARISH/RISK-OFF, taker beli positif.
  Pola A breakout di atas high 20 candle; **Pola B pullback (utama)**: harga masuk zona lalu candle 1h hijau close di atas zona
  dengan volume jual menurun → ENTRY READY.
- **Rencana:** SL = entry − max(1,5 ATR, 5%), tolak bila > 9%; TP1 +9% (jual 50%, SL ke entry), TP2 +18%, R:R ≥ 2;
  time stop 72 jam; entry 40/30/30, tanpa average down. Ukuran = 1% equity ÷ jarak SL, maks 25% equity per coin,
  maks 3 posisi, risiko portofolio 3%. Rezim BEARISH: skor minimal +10 dan ukuran ½; RISK-OFF: tidak ada entry baru.
- **Futures:** LONG hanya saat spot ENTRY READY; leverage maks = ⌊50% ÷ jarak SL⌋ (diturunkan bila likuidasi < 1,5× jarak SL);
  SHORT hanya saat DISTRIBUTION + rezim tidak bullish + konfirmasi bearish. Funding N/A bila tidak ada.
- **Pengingat:** WATCH, pullback mendekati zona, masuk zona, entry ready, batal, kedaluwarsa, TP/exit. Selalu menyebut
  nomor sinyal, tanpa duplikat (jeda `cooldownMin`). Di browser selama dashboard terbuka; 24/7 via Telegram bila secret diisi.

**Pengaturan (⚙):** equity, risiko 0,5–1%, batas leverage, ambang jangan-kejar, jeda pengingat, saklar notifikasi per tipe
(disimpan di browser). Parameter lain di `config/wac.json` (mis. tambah aset ke `etfAssets` → profil ETF).

**Telegram (opsional):** buat bot lewat @BotFather, lalu isi repo Settings → Secrets and variables → Actions:
`TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` (lihat `.env.example`). Tanpa secret, perekam tetap jalan tanpa kirim pesan.

**Data berbayar:** on-chain whale & ETF tambahan hanya berupa interface di `recorder/adapters.cjs` (belum terintegrasi).

**Tes:** `node --test tests/wac.test.cjs`. **Backtest:** `node backtest/run.cjs` → `data/backtest.json`, tampil di tab Rekap
(acak, buy & hold, CHASE, teknikal saja, WAC A, WAC B, WAC + rezim; train/validasi/test, biaya 2×). Bila kriteria
(t-stat test ≥ 2, positif dengan biaya 2×, tidak bergantung satu coin/trade) gagal → **BELUM TERBUKTI**.

Tab **IKUT** punya legend arti status (Watch, Terkonfirmasi, Entry ready, Posisi (virtual) = simulasi, bukan order, dst.);
ketuk lingkaran skor untuk rincian bobot, skor per komponen, coverage dan filter. Tab **Rekap** berisi statistik WAC live dan backtest.

### Rekaman 24 jam (Riwayat)

File `.github/workflows/recorder.yml` menjalankan `recorder/record.cjs` di GitHub Actions **setiap jam**.
Perekam memakai aturan yang sama dengan dashboard (`engine.js`) dan menyimpan:

- `data/days/YYYY-MM-DD.json`: semua sinyal per hari (tanggal WIB) + total likuidasi long/short hari itu
- `data/index.json`: ringkasan per hari

Setiap sinyal diberi **hasil harga** 1, 4 dan 24 jam kemudian.
Data lebih dari 30 hari dihapus otomatis. Di dashboard, buka tab **Riwayat** (pilih tanggal & jam, plus timeline sinyal WAC per nomor).

Syarat:
- Repo harus **public** (GitHub Actions gratis tanpa batas menit untuk repo public).
- Workflow jalan dari **branch default** repo (jadwal GitHub Actions hanya jalan dari situ). Dashboard membaca data dari branch default yang sama.
- Server GitHub ada di Amerika, jadi Binance Futures biasanya diblokir. Rekaman 24 jam berisi **Binance Spot + OKX** (termasuk likuidasi OKX).
- Jalankan manual pertama kali: tab **Actions** → *Rekam data whale* → **Run workflow**.

Bukan nasihat keuangan.
