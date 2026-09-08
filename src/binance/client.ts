import type { SymbolFilters } from "../engine/types.js";

const SPOT_BASE = "https://api.binance.com";
const FUTURES_BASE = "https://fapi.binance.com";
const FETCH_TIMEOUT_MS = 10_000;

export type ObservationSource = "binance-public-rest";

interface RawSpotSymbol {
  symbol: string;
  status: string;
  isSpotTradingAllowed: boolean;
  baseAsset: string;
  filters: Array<Record<string, unknown>>;
}

interface RawFuturesSymbol {
  symbol: string;
  status: string;
  contractType: string;
  baseAsset: string;
  underlyingType?: string;
  underlyingSubType?: string[];
  filters: Array<Record<string, unknown>>;
}

export interface PairDiscoveryResult {
  ticker: string;
  spotSymbol: string;
  futuresSymbol: string;
  spot: { tradable: boolean; filters?: SymbolFilters; price?: number; reason?: string; source?: ObservationSource; observedAt?: string };
  futures: {
    tradable: boolean;
    filters?: SymbolFilters;
    contractType?: string;
    markPrice?: number;
    reason?: string;
    source?: ObservationSource;
    observedAt?: string;
  };
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

/**
 * Fetches JSON with an explicit timeout and a single retry on HTTP 429
 * (honoring Retry-After when present) — Binance's public endpoints are rate
 * limited, and a bare `fetch` with no timeout can hang a scheduled cycle
 * indefinitely instead of surfacing a retryable error to the scheduler's
 * own classifyError logic.
 */
async function fetchJson<T>(url: string, attempt = 0): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429 && attempt === 0) {
      const retryAfterSec = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(Math.max(retryAfterSec, 1), 5) * 1000));
      return fetchJson<T>(url, attempt + 1);
    }
    if (!res.ok) {
      throw new Error(`Binance API error ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Binance API request timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministic discovery: given a ticker, checks live Binance exchangeInfo
 * for a matching bStock spot pair (<TICKER>BUSDT) and a matching TradFi
 * perpetual future (<TICKER>USDT). No LLM involved, no guessing.
 *
 * Identity validation (not just naming pattern): a symbol matching the
 * constructed string is NOT accepted on name alone. The spot leg is only
 * accepted if its exchangeInfo `baseAsset` is exactly `<TICKER>B` — the
 * actual tokenized-asset identifier Binance's own Tokenized Stocks API uses
 * (underlyingAsset "AAPL" -> tokenizedAsset "AAPLB"), not an assumption that
 * any symbol ending in the letter B is a bStock. The futures leg is only
 * accepted if Binance's own classification fields say so directly:
 * `underlyingType: "EQUITY"` and `underlyingSubType` including `"TradFi"`.
 * Both legs' `baseAsset` are cross-checked against each other (spot base
 * minus its trailing "B" must equal the futures base) so a coincidental
 * symbol collision can't silently pair two unrelated instruments.
 */
export async function discoverPair(ticker: string): Promise<PairDiscoveryResult> {
  const upper = ticker.toUpperCase();
  const spotSymbol = `${upper}BUSDT`;
  const futuresSymbol = `${upper}USDT`;
  const expectedSpotBaseAsset = `${upper}B`;

  const result: PairDiscoveryResult = {
    ticker: upper,
    spotSymbol,
    futuresSymbol,
    spot: { tradable: false },
    futures: { tradable: false },
    usableForProtectedDca: false,
  };

  let futuresBaseAsset: string | undefined;

  try {
    const futInfo = await fetchJson<{ symbols: RawFuturesSymbol[] }>(`${FUTURES_BASE}/fapi/v1/exchangeInfo`);
    const sym = futInfo.symbols.find((s) => s.symbol === futuresSymbol);
    const isRealTradFiEquityContract =
      !!sym &&
      sym.status === "TRADING" &&
      // Binance's own API uses this exact (unusually spelled) enum value — verified live, not a typo to "fix".
      sym.contractType === "TRADIFI_PERPETUAL" &&
      sym.underlyingType === "EQUITY" &&
      Array.isArray(sym.underlyingSubType) &&
      sym.underlyingSubType.includes("TradFi");

    if (isRealTradFiEquityContract && sym) {
      futuresBaseAsset = sym.baseAsset;
      const markRes = await fetchJson<{ markPrice: string }>(
        `${FUTURES_BASE}/fapi/v1/premiumIndex?symbol=${futuresSymbol}`,
      );
      result.futures = {
        tradable: true,
        filters: extractFilters(sym.filters),
        contractType: sym.contractType,
        markPrice: Number(markRes.markPrice),
        source: "binance-public-rest",
        observedAt: new Date().toISOString(),
      };
    } else if (sym) {
      result.futures = {
        tradable: false,
        reason: `${futuresSymbol} exists but is not a classified TradFi equity perpetual (contractType=${sym.contractType}, underlyingType=${sym.underlyingType}, underlyingSubType=${JSON.stringify(sym.underlyingSubType)})`,
      };
    } else {
      result.futures = { tradable: false, reason: `no futures symbol named ${futuresSymbol}` };
    }
  } catch (err) {
    result.futures = { tradable: false, reason: `futures lookup failed for ${futuresSymbol}: ${(err as Error).message}` };
  }

  try {
    const spotInfo = await fetchJson<{ symbols: RawSpotSymbol[] }>(
      `${SPOT_BASE}/api/v3/exchangeInfo?symbol=${spotSymbol}`,
    );
    const sym = spotInfo.symbols[0];
    const baseAssetMatchesTokenizedConvention = !!sym && sym.baseAsset === expectedSpotBaseAsset;
    const baseAssetMatchesFuturesUnderlying =
      !!sym && !!futuresBaseAsset && sym.baseAsset === `${futuresBaseAsset}B`;

    if (sym && sym.status === "TRADING" && sym.isSpotTradingAllowed && baseAssetMatchesTokenizedConvention) {
      if (futuresBaseAsset && !baseAssetMatchesFuturesUnderlying) {
        // Both legs exist and look individually plausible, but they don't
        // actually reference the same underlying — refuse rather than pair
        // two coincidentally-named but unrelated instruments.
        result.spot = {
          tradable: false,
          reason: `spot baseAsset ${sym.baseAsset} does not match futures underlying ${futuresBaseAsset} — refusing to pair unrelated instruments`,
        };
      } else {
        const priceRes = await fetchJson<{ price: string }>(`${SPOT_BASE}/api/v3/ticker/price?symbol=${spotSymbol}`);
        result.spot = {
          tradable: true,
          filters: extractFilters(sym.filters),
          price: Number(priceRes.price),
          source: "binance-public-rest",
          observedAt: new Date().toISOString(),
        };
      }
    } else if (sym) {
      result.spot = {
        tradable: false,
        reason: `${spotSymbol} exists but baseAsset ${sym.baseAsset} does not match the expected tokenized-stock identifier ${expectedSpotBaseAsset} (or is not TRADING)`,
      };
    } else {
      result.spot = { tradable: false, reason: `no spot symbol named ${spotSymbol}` };
    }
  } catch (err) {
    result.spot = { tradable: false, reason: `spot lookup failed for ${spotSymbol}: ${(err as Error).message}` };
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
