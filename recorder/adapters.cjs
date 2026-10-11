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
const NotIntegrated = name => ({ name, integrated: false, async netWhaleFlow() { return null; }, async dailyFlows() { return null; } });
module.exports = {
  onchain: NotIntegrated(process.env.ONCHAIN_API_KEY ? "onchain (key set, adapter not implemented)" : "onchain (not configured)"),
  etf: NotIntegrated(process.env.ETF_API_KEY ? "etf (key set, adapter not implemented)" : "etf (not configured)")
};
