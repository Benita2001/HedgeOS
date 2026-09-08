import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverPair } from "../src/binance/client.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

const NVDA_FUTURES_EXCHANGE_INFO = {
  symbols: [
    {
      symbol: "NVDAUSDT",
      status: "TRADING",
      contractType: "TRADIFI_PERPETUAL",
      baseAsset: "NVDA",
      underlyingType: "EQUITY",
      underlyingSubType: ["TradFi"],
      filters: [
        { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "0.01" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    },
  ],
};

const NVDA_SPOT_EXCHANGE_INFO = {
  symbols: [
    {
      symbol: "NVDABUSDT",
      status: "TRADING",
      isSpotTradingAllowed: true,
      baseAsset: "NVDAB",
      filters: [
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
        { filterType: "NOTIONAL", minNotional: "5" },
      ],
    },
  ],
};

describe("discoverPair — authoritative instrument validation (mocked network)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a real TradFi equity perpetual + matching bStock (NVDA-shaped fixture)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("fapi.binance.com/fapi/v1/exchangeInfo")) return Promise.resolve(jsonResponse(NVDA_FUTURES_EXCHANGE_INFO));
      if (url.includes("fapi.binance.com/fapi/v1/premiumIndex")) return Promise.resolve(jsonResponse({ markPrice: "233.16" }));
      if (url.includes("api.binance.com/api/v3/exchangeInfo")) return Promise.resolve(jsonResponse(NVDA_SPOT_EXCHANGE_INFO));
      if (url.includes("api.binance.com/api/v3/ticker/price")) return Promise.resolve(jsonResponse({ price: "233.00" }));
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await discoverPair("NVDA");
    expect(result.usableForProtectedDca).toBe(true);
    expect(result.spot.tradable).toBe(true);
    expect(result.futures.tradable).toBe(true);
    expect(result.spot.source).toBe("binance-public-rest");
    expect(result.spot.observedAt).toBeDefined();
  });

  it("rejects a crypto perpetual even if contractType string were ever coincidentally similar (real BTC-shaped fixture)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("fapi.binance.com/fapi/v1/exchangeInfo"))
        return Promise.resolve(
          jsonResponse({
            symbols: [
              {
                symbol: "BTCUSDT",
                status: "TRADING",
                contractType: "PERPETUAL",
                baseAsset: "BTC",
                underlyingType: "COIN",
                underlyingSubType: ["PoW"],
                filters: [],
              },
            ],
          }),
        );
      if (url.includes("api.binance.com/api/v3/exchangeInfo")) return Promise.resolve(jsonResponse({ code: -1121, msg: "Invalid symbol." }, 400));
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await discoverPair("BTC");
    expect(result.usableForProtectedDca).toBe(false);
    expect(result.futures.tradable).toBe(false);
    expect(result.futures.reason).toMatch(/not a classified TradFi equity perpetual/);
  });

  it("rejects a spot symbol matching the naming pattern but whose baseAsset is NOT the tokenized-stock identifier", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("fapi.binance.com/fapi/v1/exchangeInfo")) return Promise.resolve(jsonResponse({ symbols: [] }));
      if (url.includes("api.binance.com/api/v3/exchangeInfo"))
        return Promise.resolve(
          jsonResponse({
            symbols: [
              {
                symbol: "FOOBUSDT",
                status: "TRADING",
                isSpotTradingAllowed: true,
                baseAsset: "SOMETHING_UNRELATED", // NOT "FOOB" — a naming coincidence, not a real bStock
                filters: [],
              },
            ],
          }),
        );
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await discoverPair("FOO");
    expect(result.spot.tradable).toBe(false);
    expect(result.spot.reason).toMatch(/does not match the expected tokenized-stock identifier/);
  });

  it("refuses to pair a spot bStock and a futures TradFi contract whose underlying assets don't actually match", async () => {
    // Spot baseAsset legitimately follows the <TICKER>B convention for the
    // requested ticker (NVDAB matches NVDA), but the futures contract's own
    // baseAsset is a different company (MSFT) — a real cross-underlying
    // mismatch, not just a naming-convention failure at the first check.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("fapi.binance.com/fapi/v1/exchangeInfo"))
        return Promise.resolve(
          jsonResponse({
            symbols: [{ ...NVDA_FUTURES_EXCHANGE_INFO.symbols[0], symbol: "NVDAUSDT", baseAsset: "MSFT" }],
          }),
        );
      if (url.includes("fapi.binance.com/fapi/v1/premiumIndex")) return Promise.resolve(jsonResponse({ markPrice: "233.16" }));
      if (url.includes("api.binance.com/api/v3/exchangeInfo")) return Promise.resolve(jsonResponse(NVDA_SPOT_EXCHANGE_INFO)); // baseAsset "NVDAB"
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await discoverPair("NVDA");
    expect(result.usableForProtectedDca).toBe(false);
    expect(result.spot.reason).toMatch(/does not match futures underlying/);
  });

  it("retries once on HTTP 429 and succeeds on the retry", async () => {
    let futuresCallCount = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("fapi.binance.com/fapi/v1/exchangeInfo")) {
        futuresCallCount++;
        if (futuresCallCount === 1) return Promise.resolve(jsonResponse({ msg: "rate limited" }, 429, { "retry-after": "0" }));
        return Promise.resolve(jsonResponse(NVDA_FUTURES_EXCHANGE_INFO));
      }
      if (url.includes("fapi.binance.com/fapi/v1/premiumIndex")) return Promise.resolve(jsonResponse({ markPrice: "233.16" }));
      if (url.includes("api.binance.com/api/v3/exchangeInfo")) return Promise.resolve(jsonResponse(NVDA_SPOT_EXCHANGE_INFO));
      if (url.includes("api.binance.com/api/v3/ticker/price")) return Promise.resolve(jsonResponse({ price: "233.00" }));
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await discoverPair("NVDA");
    expect(result.usableForProtectedDca).toBe(true);
    expect(futuresCallCount).toBe(2);
  });
});
