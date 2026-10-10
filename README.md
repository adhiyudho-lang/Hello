# Hello

## Adhi Whale Terminal

Tampilan mobile-first ala app exchange: menu bawah (Beranda, Sinyal, IKUT, Riwayat, Rekap), logo coin,
grafik mini 1 jam di tiap sinyal, heatmap pasar, gauge Fear & Greed, dan chart candle (TradingView
Lightweight Charts) dengan garis Entry/SL/TP serta support & resistance. File: `index.html` (tampilan),
`app.js` (logika browser), `engine.js` (aturan sinyal, dipakai juga oleh perekam).

Dashboard crypto live dalam satu file (`index.html`), mirip feed KJo Terminal:

1. **#whale-sniper**: transaksi besar (market order whale) & volume 1 menit tak biasa. Hijau = beli, merah = jual.
2. **#liquidation-feed**: likuidasi Binance Futures & OKX. Hijau = LONG terlikuidasi, merah = SHORT terlikuidasi.
3. **#sinyal-whale**: PUMP / DUMP (harga bergerak ≥ X% dalam N menit) di Binance Futures, Binance Spot, OKX Futures, OKX Spot.
4. **#fear-greed-index**: gauge, perbandingan kemarin / 7 hari / 30 hari, grafik 30 hari, dan artinya.

Setiap sinyal punya **saran untuk Adhi** (IKUT / TUNGGU / HINDARI, skor 0–100) versi futures dan spot,
dihitung dengan aturan profil konservatif: konfirmasi antar-sinyal, likuiditas, risiko mengejar, tren BTC 1 jam,
Fear & Greed, dan funding rate. Tombol **Tanya Claude** membuka claude.ai dengan data sinyal sudah terisi.

### Cara membuka

- **GitHub Pages**: Settings → Pages → Source "Deploy from a branch" → pilih branch dan folder `/ (root)`.
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

### Menu ETF Brief (Crypto ETF Weekly Brief)

Isi brief mingguan dari artifact claude.ai (`data/brief.json`, disinkronkan tiap Sabtu pagi oleh Routine Claude
lewat `recorder/brief-extract.cjs`) ditambah arus harian ETF Bitcoin spot per penerbit (`data/etf.json`, diambil
dari bitbo.io oleh perekam tiap jam lewat `recorder/etf.cjs`). Sub-tab: Ringkasan, Arus ETF, Event, Pengingat,
Teknikal BTC, Altcoin, Aksi.

### Tab Saran IKUT

Semua sinyal dengan saran IKUT dari 60 menit terakhir, dicek ulang tiap 30 detik dengan candle 15 menit dan 1 jam:
entry (zona), stop loss, TP1/TP2, support & resistance, tren 1 jam (bullish/bearish), RSI 14, MACD, EMA 20/50/200.
Status **BISA DIIKUTI** muncul (plus bunyi & notifikasi) kalau harga masih di zona entry dan semua syarat terpenuhi;
**TUNGGU KONFIRMASI**, **TERLEWAT**, **BATAL** atau **KEDALUWARSA** kalau tidak.

### Rekaman 24 jam (Riwayat & Ringkasan harian)

File `.github/workflows/recorder.yml` menjalankan `recorder/record.cjs` di GitHub Actions **setiap jam**.
Perekam memakai aturan yang sama dengan dashboard (`engine.js`) dan menyimpan:

- `data/days/YYYY-MM-DD.json`: semua sinyal per hari (tanggal WIB) + total likuidasi long/short hari itu
- `data/index.json`: ringkasan per hari + akurasi saran (IKUT/TUNGGU/HINDARI)

Setiap sinyal diberi **hasil harga** 1, 4 dan 24 jam kemudian, supaya kelihatan apakah saran IKUT terbukti.
Data lebih dari 30 hari dihapus otomatis. Di dashboard, buka tab **Riwayat** (pilih tanggal & jam) atau **Ringkasan harian**.

Syarat:
- Repo harus **public** (GitHub Actions gratis tanpa batas menit untuk repo public).
- Workflow jalan dari **branch default** repo (jadwal GitHub Actions hanya jalan dari situ). Dashboard membaca data dari branch default yang sama.
- Server GitHub ada di Amerika, jadi Binance Futures biasanya diblokir. Rekaman 24 jam berisi **Binance Spot + OKX** (termasuk likuidasi OKX).
- Jalankan manual pertama kali: tab **Actions** → *Rekam data whale* → **Run workflow**.

Bukan nasihat keuangan.
