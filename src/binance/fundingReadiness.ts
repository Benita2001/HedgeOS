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

// ---------------------------------------------------------------------------
// Deterministic funding PLANNER: extends the readiness check above with the
// exact permitted Spot->Futures transfer amount, honoring a per-strategy
// funding policy. Still a pure function — no network/DB access here; the
// caller supplies real balances and the real "already reserved by other
// strategies" figure. This is what makes automatic funding safe to reason
// about: the transfer amount is a deterministic function of (sizing,
// balances, reservations, policy), never a guess and never "whatever's in
// the wallet."
// ---------------------------------------------------------------------------

export type FundingMode = "prefunded" | "auto";

export interface FundingPolicy {
  mode: FundingMode;
  /** Extra USDT transferred beyond the bare collateral requirement, to absorb price drift/fees before the hedge order executes. Explicit, configured — never inferred. */
  bufferUsd: number;
  /** Hard ceiling on a single cycle's transfer, independent of and smaller than the strategy's own contribution budget — a bug can transfer at most this much in one cycle, ever. */
  perCycleCapUsd: number;
  /** Optional rolling-window ceiling across many cycles (e.g. per day) — undefined means no additional limit beyond the per-cycle cap. */
  periodCapUsd?: number;
  /** Amount already transferred within the current period window, tracked by the caller (e.g. summed from transfer receipts) — required to enforce periodCapUsd; ignored if periodCapUsd is undefined. */
  periodTransferredUsd?: number;
}

export type FundingAction = "none_sufficient" | "transfer_required" | "top_up_required" | "hedge_deferred_no_funding_needed" | "capped_still_insufficient";

export interface FundingPlan {
  ticker: string;
  contributionUsd: number;
  fundingMode: FundingMode;
  futuresRequiredUsd: number; // bare collateral + fee the hedge leg needs
  bufferUsd: number;
  futuresTargetUsd: number; // futuresRequiredUsd + bufferUsd — what the planner tries to ensure is available
  futuresAvailableUsd: number; // raw account-level balance, as reported by the exchange
  reservedFuturesUsd: number; // already earmarked by OTHER strategies sharing this account/wallet — never double-counted as available
  unreservedFuturesAvailableUsd: number; // max(0, futuresAvailableUsd - reservedFuturesUsd)
  futuresShortfallUsd: number; // max(0, futuresTargetUsd - unreservedFuturesAvailableUsd)
  transferAmountUsd: number; // exact amount the planner would request a transfer for — 0 unless mode="auto" and a shortfall exists
  action: FundingAction;
  notes: string[];
}

export function planFunding(args: {
  ticker: string;
  sizing: DcaHedgeSizingResult;
  futuresAvailableUsd: number;
  reservedFuturesUsd?: number;
  policy: FundingPolicy;
}): FundingPlan {
  const { ticker, sizing, futuresAvailableUsd, policy } = args;
  const reservedFuturesUsd = Math.max(0, args.reservedFuturesUsd ?? 0);
  const notes: string[] = [];

  if (!sizing.hedge.executable) {
    return {
      ticker,
      contributionUsd: sizing.contributionUsd,
      fundingMode: policy.mode,
      futuresRequiredUsd: 0,
      bufferUsd: policy.bufferUsd,
      futuresTargetUsd: 0,
      futuresAvailableUsd,
      reservedFuturesUsd,
      unreservedFuturesAvailableUsd: Math.max(0, futuresAvailableUsd - reservedFuturesUsd),
      futuresShortfallUsd: 0,
      transferAmountUsd: 0,
      action: "hedge_deferred_no_funding_needed",
      notes: [`hedge leg is not executable at this contribution/price (${sizing.hedge.reason}) — its budget of $${sizing.hedge.hedgeBudgetUsd} is deferred; nothing to fund this cycle`],
    };
  }

  const futuresRequiredUsd = Math.round((sizing.hedge.actualCollateralUsd + sizing.hedge.estimatedFeeUsd) * 100) / 100;
  const futuresTargetUsd = Math.round((futuresRequiredUsd + policy.bufferUsd) * 100) / 100;
  const unreservedFuturesAvailableUsd = Math.max(0, Math.round((futuresAvailableUsd - reservedFuturesUsd) * 100) / 100);
  const futuresShortfallUsd = Math.max(0, Math.round((futuresTargetUsd - unreservedFuturesAvailableUsd) * 100) / 100);

  if (reservedFuturesUsd > 0) {
    notes.push(`$${reservedFuturesUsd} of the account's Futures balance is reserved by other strategies sharing this wallet — excluded from what's available here`);
  }

  if (futuresShortfallUsd === 0) {
    return {
      ticker, contributionUsd: sizing.contributionUsd, fundingMode: policy.mode,
      futuresRequiredUsd, bufferUsd: policy.bufferUsd, futuresTargetUsd, futuresAvailableUsd,
      reservedFuturesUsd, unreservedFuturesAvailableUsd, futuresShortfallUsd: 0,
      transferAmountUsd: 0, action: "none_sufficient", notes,
    };
  }

  if (policy.mode === "prefunded") {
    notes.push(`Futures wallet short $${futuresShortfallUsd} (need $${futuresTargetUsd} incl. $${policy.bufferUsd} buffer, have $${unreservedFuturesAvailableUsd} unreserved). Funding mode is "prefunded" — top up the Futures wallet yourself before the next cycle; no transfer will be attempted automatically.`);
    return {
      ticker, contributionUsd: sizing.contributionUsd, fundingMode: policy.mode,
      futuresRequiredUsd, bufferUsd: policy.bufferUsd, futuresTargetUsd, futuresAvailableUsd,
      reservedFuturesUsd, unreservedFuturesAvailableUsd, futuresShortfallUsd,
      transferAmountUsd: 0, action: "top_up_required", notes,
    };
  }

  // mode === "auto": propose transferring exactly the shortfall, capped by policy — never the full account balance.
  let transferAmountUsd = Math.min(futuresShortfallUsd, policy.perCycleCapUsd);
  if (transferAmountUsd < futuresShortfallUsd) {
    notes.push(`Shortfall is $${futuresShortfallUsd} but the per-cycle transfer cap is $${policy.perCycleCapUsd} — capping the transfer at the policy limit rather than exceeding it.`);
  }
  if (policy.periodCapUsd !== undefined) {
    const alreadyTransferred = policy.periodTransferredUsd ?? 0;
    const periodRemaining = Math.max(0, Math.round((policy.periodCapUsd - alreadyTransferred) * 100) / 100);
    if (transferAmountUsd > periodRemaining) {
      notes.push(`Period transfer cap $${policy.periodCapUsd} reached ($${alreadyTransferred} already transferred this period) — reducing this cycle's transfer to the $${periodRemaining} remaining.`);
      transferAmountUsd = periodRemaining;
    }
  }
  transferAmountUsd = Math.max(0, Math.round(transferAmountUsd * 100) / 100);

  const stillInsufficientAfterTransfer = transferAmountUsd < futuresShortfallUsd;
  if (stillInsufficientAfterTransfer) {
    notes.push(`Even after transferring $${transferAmountUsd} (the policy-permitted amount), the hedge leg would still be short $${Math.round((futuresShortfallUsd - transferAmountUsd) * 100) / 100} — this cycle's hedge will likely still defer. Never overspending the configured limit to force it through.`);
  }

  return {
    ticker, contributionUsd: sizing.contributionUsd, fundingMode: policy.mode,
    futuresRequiredUsd, bufferUsd: policy.bufferUsd, futuresTargetUsd, futuresAvailableUsd,
    reservedFuturesUsd, unreservedFuturesAvailableUsd, futuresShortfallUsd,
    transferAmountUsd,
    action: stillInsufficientAfterTransfer ? "capped_still_insufficient" : "transfer_required",
    notes,
  };
}
