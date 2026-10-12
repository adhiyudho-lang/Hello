/* Adapter interfaces for paid data sources. NOT INTEGRATED — nothing here fetches data.
   The WAC score treats these components as N/A (coverage drops) until an adapter is implemented.

   To add one: implement the functions below against your provider, read the key from an environment
   variable (see .env.example), and return null whenever data is missing or older than
   config/wac.json staleMinutes. Never fabricate values.

   OnChainAdapter.netWhaleFlow(coin, sinceMs) -> null | { netUsd, inUsd, outUsd, wallets, asOf, source }
     Example providers (paid): Nansen, Arkham, Glassnode, CryptoQuant, Whale Alert.
     Used by spec 5.3: when available, net whale buy must not be negative for confirmation.

   EtfAdapter.dailyFlows(coin) -> null | { days: [{ date: "YYYY-MM-DD", flow: usd, price }], asOf, source }
     The free sources already in use (CoinMarketCap web API for BTC/ETH/SOL, bitbo.io issuers) live in
     recorder/etf.cjs. Use this adapter for assets they do not cover (e.g. new spot ETFs). */
"use strict";
/* Modul C (Signal Intelligence spec): on-chain flow for SPOT signals. Not active until an API key is set.
   Plan per chain: EVM (ETH, ARB, OP, BSC, Base) via an Etherscan-family `tokentx` API (ETHERSCAN_API_KEY),
   Solana via Helius (HELIUS_API_KEY), Starknet via Voyager. Exchange hot wallets live in
   data/exchange-wallets.json and are maintained by hand from public sources (never guessed).
   classifyTransfer() is the pure part: exchange -> private = withdraw (accumulation, +1),
   private -> exchange = deposit (preparing to sell, -1), private -> private = 0. */
function classifyTransfer(from, to, wallets) {
  const ex = a => { const k = String(a || "").toLowerCase(); for (const [name, list] of Object.entries(wallets || {})) if (list.some(x => x.toLowerCase() === k)) return name; return null; };
  const f = ex(from), t = ex(to);
  if (f && !t) return { type: "WITHDRAW", exchange: f, weight: 1 };
  if (!f && t) return { type: "DEPOSIT", exchange: t, weight: -1 };
  return { type: f && t ? "EXCHANGE_INTERNAL" : "PRIVATE", exchange: f || t, weight: 0 };
}
const NotIntegrated = name => ({ name, integrated: false, async netWhaleFlow() { return null; }, async dailyFlows() { return null; } });
module.exports = {
  classifyTransfer,
  onchain: NotIntegrated(process.env.ONCHAIN_API_KEY ? "onchain (key set, adapter not implemented)" : "onchain (not configured)"),
  etf: NotIntegrated(process.env.ETF_API_KEY ? "etf (key set, adapter not implemented)" : "etf (not configured)")
};
