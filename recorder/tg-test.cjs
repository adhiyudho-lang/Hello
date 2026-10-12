/* Sends one test message with the TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets (never printed). */
"use strict";
(async () => {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { console.log(`Secret belum lengkap: TELEGRAM_BOT_TOKEN ${tok ? "ada" : "KOSONG"}, TELEGRAM_CHAT_ID ${chat ? "ada" : "KOSONG"}`); process.exit(1); }
  const n = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "../config/notify.json"), "utf8"));
  const on = Object.entries(n).filter(([k, v]) => k[0] !== "_" && v).map(([k]) => ({ wac: "sinyal WAC", regime: "rezim BTC", flow: "label arus", whale: "whale Hyperliquid" }[k] || k));
  const text = `✅ Adhi Whale Terminal terhubung ke Telegram.\nNotifikasi aktif: ${on.join(", ")}.\nWhale Hyperliquid: posisi ≥ $1 jt, deposit/tarik ≥ $500 rb.`;
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text }) });
  const j = await r.json().catch(() => ({}));
  if (j.ok) { console.log("Pesan tes terkirim. Cek Telegram."); return; }
  console.log(`Gagal (${r.status}): ${j.description || "tidak diketahui"}. Pastikan kamu sudah menekan Start di bot dan TELEGRAM_CHAT_ID benar.`);
  process.exit(1);
})();
