import { discoverPair } from "../binance/client.js";
import { sizeDcaHedgeContribution } from "../engine/sizing.js";
import { assertValidHedgeLeverage } from "../engine/types.js";

/**
 * Dry-run: discovery + deterministic sizing against live market data, with
 * NO database writes and NO order placement of any kind — used by the
 * "preview a strategy" MCP tool so a user can see exactly what a
 * contribution would do before committing to it.
 */
export async function previewContribution(ticker: string, contributionUsd: number, hedgeLeverage: number) {
  assertValidHedgeLeverage(hedgeLeverage);
  const discovery = await discoverPair(ticker);
  if (!discovery.usableForProtectedDca) {
    return { ticker: ticker.toUpperCase(), discovery, sizing: undefined };
  }
  const sizing = sizeDcaHedgeContribution(
    contributionUsd,
    discovery.spot.price!,
    discovery.spot.filters!,
    discovery.futures.filters!,
    { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage },
  );
  return { ticker: ticker.toUpperCase(), discovery, sizing };
}
