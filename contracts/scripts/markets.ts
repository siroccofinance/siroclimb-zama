/**
 * The market list shared with the front (js/chain/markets.json), and live seed prices for a
 * deployment: Yahoo Finance chart API for stocks and FX, Binance spot for gold and crypto.
 */
import { readFileSync } from "fs";
import { join } from "path";

export interface Market {
  id: string;
  name: string;
  ticker: string;
  kind: string;
  hours: string;
  pyth: string;
  yahoo?: string;
  binance?: string;
  kraken?: string;
  token: { symbol: string; origin: "zama" | "mirror"; sepolia?: string; underlying?: { name: string; symbol: string; decimals: number; mainnet: string } };
}

const file = JSON.parse(readFileSync(join(__dirname, "..", "..", "js", "chain", "markets.json"), "utf8")) as {
  markets: Market[];
  roundMarkets: string[];
};
export const MARKETS = file.markets;
export const ROUND_MARKETS = file.roundMarkets.map((id) => MARKETS.findIndex((m) => m.id === id));

export function toFixed10(v: number | string): bigint {
  const s = typeof v === "number" ? v.toFixed(12) : v;
  const [i, f = ""] = s.split(".");
  return BigInt(i + (f + "0".repeat(10)).slice(0, 10));
}

async function yahoo(symbol: string): Promise<number> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`, {
    headers: { "user-agent": "Mozilla/5.0" },
  });
  const d = (await res.json()) as { chart: { result: { meta: { regularMarketPrice: number }; indicators: { quote: { close: (number | null)[] }[] } }[] } };
  const r = d.chart.result[0];
  const closes = r.indicators.quote[0].close.filter((x): x is number => x != null);
  return closes.length ? closes[closes.length - 1] : r.meta.regularMarketPrice;
}

async function kraken(pair: string): Promise<number> {
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  const d = (await res.json()) as { result: Record<string, { c: string[] }> };
  return Number(Object.values(d.result)[0].c[0]);
}

async function binance(symbol: string): Promise<number> {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  return Number(((await res.json()) as { price: string }).price);
}

/** Seed prices, 10 decimals, in market order. */
export async function seedPrices(): Promise<bigint[]> {
  const out: bigint[] = [];
  for (const m of MARKETS) out.push(toFixed10(m.yahoo ? await yahoo(m.yahoo) : m.kraken ? await kraken(m.kraken) : await binance(m.binance!)));
  return out;
}
