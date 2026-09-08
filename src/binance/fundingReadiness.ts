import type { DcaHedgeSizingResult } from "../engine/types.js";

/**
 * Funding-readiness layer (P0 scope): compares what a contribution actually
 * requires — computed by the same deterministic sizing engine every
 * execution path uses — against a user's own real account balances, for
 * BOTH legs independently (Spot USDT for the stock leg, Futures USDT
 * margin for the hedge leg). Pure function: takes numbers in, returns a
 * structured report, no network/DB access, fully unit-testable and fully
 * generic to any ticker/contribution/account.
 *
 * P0 explicitly does NOT move money between wallets — see
 * docs/FUNDING_READINESS.md for why, and what a future auto-transfer
 * workflow would need (explicit per-cycle authorization, destination
 * restrictions, reconciliation) before it could be built responsibly.
 */
export interface FundingLegReadiness {
  requiredUsd: number;
  availableUsd: number;
  shortfallUsd: number;
  sufficient: boolean;
}

export interface FundingReadinessReport {
  ticker: string;
  contributionUsd: number;
  hedgeLeverage: number;
  spot: FundingLegReadiness;
  futures: FundingLegReadiness;
  overallReady: boolean;
  notes: string[];
}

export function evaluateFundingReadiness(args: {
  ticker: string;
  sizing: DcaHedgeSizingResult;
  spotAvailableUsd: number;
  futuresAvailableUsd: number;
}): FundingReadinessReport {
  const { ticker, sizing, spotAvailableUsd, futuresAvailableUsd } = args;
  const notes: string[] = [];

  // Required = the budget the sizing engine actually allocated to each leg
  // (not the raw 90%/10% split before exchange-minimum checks) plus its
  // own estimated fee — this is what would actually be drawn from the
  // wallet, not an idealized pre-filter number.
  const spotRequired = sizing.stock.executable ? Math.round((sizing.stock.notionalUsd + sizing.stock.estimatedFeeUsd) * 100) / 100 : 0;
  const futuresRequired = sizing.hedge.executable
    ? Math.round((sizing.hedge.actualCollateralUsd + sizing.hedge.estimatedFeeUsd) * 100) / 100
    : 0;

  if (!sizing.stock.executable) {
    notes.push(`stock leg is not executable at this contribution/price (${sizing.stock.reason}) — no Spot USDT requirement to check yet`);
  }
  if (!sizing.hedge.executable) {
    notes.push(`hedge leg is not executable at this contribution/price (${sizing.hedge.reason}) — its budget of $${sizing.hedge.hedgeBudgetUsd} is deferred, not funded now`);
  }

  const spot: FundingLegReadiness = {
    requiredUsd: spotRequired,
    availableUsd: spotAvailableUsd,
    shortfallUsd: Math.max(0, Math.round((spotRequired - spotAvailableUsd) * 100) / 100),
    sufficient: spotAvailableUsd >= spotRequired,
  };
  const futures: FundingLegReadiness = {
    requiredUsd: futuresRequired,
    availableUsd: futuresAvailableUsd,
    shortfallUsd: Math.max(0, Math.round((futuresRequired - futuresAvailableUsd) * 100) / 100),
    sufficient: futuresAvailableUsd >= futuresRequired,
  };

  if (!spot.sufficient) notes.push(`Spot USDT shortfall: need $${spot.shortfallUsd} more (have $${spotAvailableUsd}, need $${spotRequired})`);
  if (!futures.sufficient) notes.push(`Futures margin shortfall: need $${futures.shortfallUsd} more (have $${futuresAvailableUsd}, need $${futuresRequired})`);

  return {
    ticker,
    contributionUsd: sizing.contributionUsd,
    hedgeLeverage: sizing.hedge.leverage,
    spot,
    futures,
    overallReady: spot.sufficient && futures.sufficient,
    notes,
  };
}
