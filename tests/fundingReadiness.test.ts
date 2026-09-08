import { describe, expect, it } from "vitest";
import { evaluateFundingReadiness } from "../src/binance/fundingReadiness.js";
import { sizeDcaHedgeContribution } from "../src/engine/sizing.js";
import type { SymbolFilters } from "../src/engine/types.js";

const SPOT_FILTERS: SymbolFilters = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
const HEDGE_FILTERS: SymbolFilters = { stepSize: 0.01, minQty: 0.01, minNotional: 5 };
const PRICE = 226.16;

function sizingFor(contributionUsd: number, leverage = 2) {
  return sizeDcaHedgeContribution(contributionUsd, PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: leverage });
}

describe("evaluateFundingReadiness — generic across ticker/amount/account balances", () => {
  it("reports ready when both wallets have enough for the actual sized requirement (not the raw 90/10 split)", () => {
    const sizing = sizingFor(40);
    const report = evaluateFundingReadiness({ ticker: "AAPL", sizing, spotAvailableUsd: 100, futuresAvailableUsd: 20 });
    expect(report.overallReady).toBe(true);
    expect(report.spot.sufficient).toBe(true);
    expect(report.futures.sufficient).toBe(true);
    expect(report.spot.requiredUsd).toBeLessThan(40); // required is the actually-sized notional+fee, not the raw budget
  });

  it("matches this session's real preflight finding: $0 in both wallets against a real requirement is NOT ready", () => {
    const sizing = sizingFor(40);
    const report = evaluateFundingReadiness({ ticker: "NVDA", sizing, spotAvailableUsd: 0, futuresAvailableUsd: 0 });
    expect(report.overallReady).toBe(false);
    expect(report.spot.sufficient).toBe(false);
    expect(report.futures.sufficient).toBe(false);
    expect(report.spot.shortfallUsd).toBeCloseTo(report.spot.requiredUsd, 2);
    expect(report.notes.some((n) => n.includes("Spot USDT shortfall"))).toBe(true);
    expect(report.notes.some((n) => n.includes("Futures margin shortfall"))).toBe(true);
  });

  it("reports a partial shortfall — spot funded, futures not", () => {
    const sizing = sizingFor(40);
    const report = evaluateFundingReadiness({ ticker: "TSLA", sizing, spotAvailableUsd: 100, futuresAvailableUsd: 0 });
    expect(report.spot.sufficient).toBe(true);
    expect(report.futures.sufficient).toBe(false);
    expect(report.overallReady).toBe(false);
  });

  it("a below-minimum contribution (hedge deferred, not executable) requires $0 futures margin, not a false shortfall", () => {
    const sizing = sizingFor(10); // too small for the hedge leg to clear minNotional
    const report = evaluateFundingReadiness({ ticker: "NVDA", sizing, spotAvailableUsd: 5, futuresAvailableUsd: 0 });
    expect(sizing.hedge.executable).toBe(false);
    expect(report.futures.requiredUsd).toBe(0);
    expect(report.futures.sufficient).toBe(true); // $0 required, $0 available — trivially sufficient
    expect(report.notes.some((n) => n.includes("deferred"))).toBe(true);
  });

  it("scales with contribution size — generic across $40/$100/$500, no hardcoded threshold", () => {
    for (const amount of [40, 100, 500]) {
      const sizing = sizingFor(amount);
      const readyReport = evaluateFundingReadiness({ ticker: "AAPL", sizing, spotAvailableUsd: amount, futuresAvailableUsd: amount * 0.15 });
      expect(readyReport.overallReady).toBe(true);
      const shortReport = evaluateFundingReadiness({ ticker: "AAPL", sizing, spotAvailableUsd: 1, futuresAvailableUsd: 0 });
      expect(shortReport.overallReady).toBe(false);
    }
  });
});
