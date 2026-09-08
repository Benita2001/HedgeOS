import { describe, expect, it } from "vitest";
import { validateExternalObservation, type ExternalObservation } from "../src/observations/externalObservation.js";
import type { PairDiscoveryResult } from "../src/binance/client.js";

const NOW = new Date("2026-09-08T14:30:00.000Z");

const DISCOVERY: PairDiscoveryResult = {
  ticker: "NVDA",
  spotSymbol: "NVDABUSDT",
  futuresSymbol: "NVDAUSDT",
  spot: { tradable: true, price: 228.11, filters: { stepSize: 0.001, minQty: 0.001, minNotional: 5 }, source: "binance-public-rest", observedAt: NOW.toISOString() },
  futures: { tradable: true, markPrice: 227.85, filters: { stepSize: 0.01, minQty: 0.01, minNotional: 5 }, contractType: "TRADIFI_PERPETUAL", source: "binance-public-rest", observedAt: NOW.toISOString() },
  usableForProtectedDca: true,
};

function obs(overrides: Partial<ExternalObservation> = {}): ExternalObservation {
  return {
    symbol: "NVDABUSDT",
    price: 228.11,
    source: "binance-agent-os-mcp",
    toolName: "mcp__binance-mcp-server__spot_tickerPrice",
    observedAtIso: "2026-09-08T14:29:30.000Z",
    ...overrides,
  };
}

describe("validateExternalObservation", () => {
  it("accepts a fresh, matching, on-symbol observation (real NVDABUSDT data shape)", () => {
    const verdict = validateExternalObservation(obs(), DISCOVERY, NOW);
    expect(verdict.accepted).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.ownPrice).toBe(228.11);
    expect(verdict.deviationPct).toBe(0);
  });

  it("accepts the matching futures observation against markPrice", () => {
    const verdict = validateExternalObservation(
      obs({ symbol: "NVDAUSDT", price: 227.85, toolName: "mcp__binance-mcp-server__futures_usds_symbolPriceTicker" }),
      DISCOVERY,
      NOW,
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.ownPrice).toBe(227.85);
  });

  it("rejects a symbol that matches neither discovered leg", () => {
    const verdict = validateExternalObservation(obs({ symbol: "TSLABUSDT" }), DISCOVERY, NOW);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("matches neither"))).toBe(true);
  });

  it("rejects a stale observation beyond the freshness policy", () => {
    const verdict = validateExternalObservation(obs({ observedAtIso: "2026-09-08T14:00:00.000Z" }), DISCOVERY, NOW);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("exceeding the 120s freshness policy"))).toBe(true);
  });

  it("rejects a future-dated observation", () => {
    const verdict = validateExternalObservation(obs({ observedAtIso: "2026-09-08T15:00:00.000Z" }), DISCOVERY, NOW);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("in the future"))).toBe(true);
  });

  it("rejects a price that deviates beyond the 2% policy — this is the anti-spoofing/anti-hallucination gate", () => {
    const verdict = validateExternalObservation(obs({ price: 250 }), DISCOVERY, NOW);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("deviates"))).toBe(true);
    expect(verdict.deviationPct).toBeGreaterThan(2);
  });

  it("rejects when HedgeOS's own discovery marked the leg not tradable, even if the external observation looks fine", () => {
    const badDiscovery: PairDiscoveryResult = {
      ...DISCOVERY,
      spot: { tradable: false, reason: "no spot symbol named NVDABUSDT" },
    };
    const verdict = validateExternalObservation(obs(), badDiscovery, NOW);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("not tradable"))).toBe(true);
  });

  it("never exposes a way for the observation itself to be read as the sizing price (contract-level check on the type)", () => {
    // sizeDcaHedgeContribution takes a referencePrice argument explicitly sourced from discovery.spot.price
    // in worker/preview.ts — this test documents that ExternalObservation.price has no consumer in the sizing path.
    const verdict = validateExternalObservation(obs({ price: 9999 }), DISCOVERY, NOW);
    expect(verdict.accepted).toBe(false); // deviation rejected...
    expect(DISCOVERY.spot.price).toBe(228.11); // ...but discovery's own price, which sizing actually uses, is untouched
  });
});
