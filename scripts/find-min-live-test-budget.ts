/**
 * Computes the smallest contribution that clears BOTH exchange minimums
 * (spot minNotional $5, futures minNotional $5) at a given hedge leverage,
 * using the real, live-verified filters (stepSize 0.001 spot / 0.01
 * futures) from `discoverPair`. Deterministic, no network call — pass the
 * current reference price as an argument. Used to derive
 * LIVE_TRADING_READINESS.md §4's minimal live-test budget instead of
 * guessing a round number.
 */
import { sizeDcaHedgeContribution } from "../src/engine/sizing.js";

const price = Number(process.argv[2] ?? 228.14);
const stockFilters = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
const hedgeFilters = { stepSize: 0.01, minQty: 0.01, minNotional: 5 };

for (const leverage of [2, 3]) {
  console.log(`\n--- hedgeLeverage=${leverage}x, reference price=${price} ---`);
  for (let c = 15; c <= 60; c += 1) {
    const r = sizeDcaHedgeContribution(c, price, stockFilters, hedgeFilters, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: leverage });
    if (r.stock.executable && r.hedge.executable) {
      console.log(`FIRST fully-executable contribution at ${leverage}x: $${c}`, {
        stock: { qty: r.stock.quantity, notional: r.stock.notionalUsd },
        hedge: { qty: r.hedge.quantity, notional: r.hedge.actualShortNotionalUsd, collateral: r.hedge.actualCollateralUsd },
      });
      break;
    }
  }
}
