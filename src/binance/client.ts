import type { SymbolFilters } from "../engine/types.js";

const SPOT_BASE = "https://api.binance.com";
const FUTURES_BASE = "https://fapi.binance.com";

interface RawSpotSymbol {
  symbol: string;
  status: string;
  isSpotTradingAllowed: boolean;
  filters: Array<Record<string, unknown>>;
}

interface RawFuturesSymbol {
  symbol: string;
  status: string;
  contractType: string;
  underlyingType?: string;
  filters: Array<Record<string, unknown>>;
}

export interface PairDiscoveryResult {
  ticker: string;
  spotSymbol: string;
  futuresSymbol: string;
  spot: { tradable: boolean; filters?: SymbolFilters; price?: number; reason?: string };
  futures: { tradable: boolean; filters?: SymbolFilters; contractType?: string; markPrice?: number; reason?: string };
  usableForProtectedDca: boolean;
}

function extractFilters(filters: Array<Record<string, unknown>>): SymbolFilters {
  const lot = filters.find((f) => f.filterType === "LOT_SIZE") as Record<string, string> | undefined;
  const notional = filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL") as
    | Record<string, string>
    | undefined;
  return {
    stepSize: lot ? Number(lot.stepSize) : 0.00000001,
    minQty: lot ? Number(lot.minQty) : 0,
    minNotional: notional ? Number(notional.minNotional ?? notional.notional) : 0,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance API error ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

/**
 * Deterministic discovery: given a ticker, checks live Binance exchangeInfo
 * for a matching bStock spot pair (<TICKER>BUSDT) and a matching TradFi
 * perpetual future (<TICKER>USDT). No LLM involved, no guessing — a symbol
 * is only usable when both legs are actually TRADING right now.
 */
export async function discoverPair(ticker: string): Promise<PairDiscoveryResult> {
  const upper = ticker.toUpperCase();
  const spotSymbol = `${upper}BUSDT`;
  const futuresSymbol = `${upper}USDT`;

  const result: PairDiscoveryResult = {
    ticker: upper,
    spotSymbol,
    futuresSymbol,
    spot: { tradable: false },
    futures: { tradable: false },
    usableForProtectedDca: false,
  };

  try {
    const spotInfo = await fetchJson<{ symbols: RawSpotSymbol[] }>(
      `${SPOT_BASE}/api/v3/exchangeInfo?symbol=${spotSymbol}`,
    );
    const sym = spotInfo.symbols[0];
    if (sym && sym.status === "TRADING" && sym.isSpotTradingAllowed) {
      const priceRes = await fetchJson<{ price: string }>(`${SPOT_BASE}/api/v3/ticker/price?symbol=${spotSymbol}`);
      result.spot = { tradable: true, filters: extractFilters(sym.filters), price: Number(priceRes.price) };
    } else {
      result.spot = { tradable: false, reason: `spot symbol ${spotSymbol} not TRADING` };
    }
  } catch {
    result.spot = { tradable: false, reason: `no spot bStock symbol ${spotSymbol}` };
  }

  try {
    const futInfo = await fetchJson<{ symbols: RawFuturesSymbol[] }>(`${FUTURES_BASE}/fapi/v1/exchangeInfo`);
    const sym = futInfo.symbols.find((s) => s.symbol === futuresSymbol);
    // Binance's own API uses this exact (unusually spelled) enum value — verified live, not a typo to "fix".
    if (sym && sym.status === "TRADING" && sym.contractType === "TRADIFI_PERPETUAL") {
      const markRes = await fetchJson<{ markPrice: string }>(
        `${FUTURES_BASE}/fapi/v1/premiumIndex?symbol=${futuresSymbol}`,
      );
      result.futures = {
        tradable: true,
        filters: extractFilters(sym.filters),
        contractType: sym.contractType,
        markPrice: Number(markRes.markPrice),
      };
    } else {
      result.futures = { tradable: false, reason: `no TRADIFI_PERPETUAL future named ${futuresSymbol}` };
    }
  } catch {
    result.futures = { tradable: false, reason: `futures lookup failed for ${futuresSymbol}` };
  }

  result.usableForProtectedDca = result.spot.tradable && result.futures.tradable;
  return result;
}

export async function getSpotPrice(symbol: string): Promise<number> {
  const res = await fetchJson<{ price: string }>(`${SPOT_BASE}/api/v3/ticker/price?symbol=${symbol}`);
  return Number(res.price);
}

export async function getFuturesMarkPrice(symbol: string): Promise<number> {
  const res = await fetchJson<{ markPrice: string }>(`${FUTURES_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`);
  return Number(res.markPrice);
}
