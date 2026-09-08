import type {
  AllocationPolicy,
  DcaHedgeSizingResult,
  HedgeLegSizingResult,
  StockLegSizingResult,
  SymbolFilters,
} from "./types.js";
import {
  DEFAULT_POLICY,
  ESTIMATED_SPOT_TAKER_FEE_RATE,
  ESTIMATED_TRADFI_PERP_TAKER_FEE_RATE,
  assertValidHedgeLeverage,
} from "./types.js";
import { fromScaled, floorToStep, mulScaled, divScaledFloor, toScaled } from "./decimal.js";

/**
 * Snaps a raw quantity down to the exchange's stepSize using exact BigInt
 * fixed-point arithmetic (see decimal.ts) — never rounds up, and never
 * accumulates binary-float error the way `Math.floor(a/b)` on native
 * numbers can (that was a real, fixed bug in Milestone 1).
 */
export function snapDownToStep(rawQty: number, stepSize: number): number {
  if (stepSize <= 0) return rawQty;
  const snapped = floorToStep(toScaled(rawQty), toScaled(stepSize));
  return fromScaled(snapped);
}

/**
 * Sizes the stock leg deterministically: no LLM, no external call, pure
 * function of budget/price/filters, exact fixed-point math throughout.
 * Returns executable=false rather than silently trading below exchange
 * minimums or rounding up past budget.
 */
export function sizeStockLeg(budgetUsd: number, referencePrice: number, filters: SymbolFilters): StockLegSizingResult {
  if (referencePrice <= 0) {
    return {
      budgetUsd,
      quantity: 0,
      notionalUsd: 0,
      estimatedFeeUsd: 0,
      executable: false,
      reason: "invalid reference price",
    };
  }

  const budgetScaled = toScaled(budgetUsd);
  const priceScaled = toScaled(referencePrice);
  const stepScaled = toScaled(filters.stepSize);

  const rawQtyScaled = divScaledFloor(budgetScaled, priceScaled);
  const snappedQtyScaled = floorToStep(rawQtyScaled, stepScaled);
  const notionalScaled = mulScaled(snappedQtyScaled, priceScaled);

  const snappedQty = fromScaled(snappedQtyScaled);
  const notionalUsd = Math.round(fromScaled(notionalScaled) * 100) / 100;

  if (snappedQty <= 0 || snappedQty < filters.minQty) {
    return {
      budgetUsd,
      quantity: 0,
      notionalUsd: 0,
      estimatedFeeUsd: 0,
      executable: false,
      reason: `snapped quantity ${snappedQty} is below exchange minQty ${filters.minQty}`,
    };
  }
  if (notionalUsd < filters.minNotional) {
    return {
      budgetUsd,
      quantity: 0,
      notionalUsd: 0,
      estimatedFeeUsd: 0,
      executable: false,
      reason: `notional $${notionalUsd} is below exchange minNotional $${filters.minNotional}`,
    };
  }
  return {
    budgetUsd,
    quantity: snappedQty,
    notionalUsd,
    estimatedFeeUsd: Math.round(notionalUsd * ESTIMATED_SPOT_TAKER_FEE_RATE * 10000) / 10000,
    executable: true,
  };
}

/**
 * Sizes the hedge leg deterministically, exact fixed-point math throughout.
 * The hedge collateral budget is posted margin at a fixed leverage (2x
 * default, 3x max in P0) — target short notional is hedgeBudgetUsd *
 * leverage, snapped down to the exchange's real filters. If even the
 * smallest permitted order would exceed what the budget supports, or the
 * snapped notional falls under the exchange minimum, the leg does not
 * execute and the full budget is reported as deferred — never dropped,
 * never oversized past budget, and leverage is never silently increased to
 * force an execution through.
 */
export function sizeHedgeLeg(
  hedgeBudgetUsd: number,
  leverage: number,
  referencePrice: number,
  filters: SymbolFilters,
): HedgeLegSizingResult {
  assertValidHedgeLeverage(leverage);

  if (referencePrice <= 0) {
    return {
      hedgeBudgetUsd,
      leverage,
      targetShortNotionalUsd: 0,
      quantity: 0,
      actualShortNotionalUsd: 0,
      actualCollateralUsd: 0,
      estimatedFeeUsd: 0,
      executable: false,
      reason: "invalid reference price",
      deferredBudgetUsd: hedgeBudgetUsd,
    };
  }

  const budgetScaled = toScaled(hedgeBudgetUsd);
  const leverageScaled = toScaled(leverage);
  const priceScaled = toScaled(referencePrice);
  const stepScaled = toScaled(filters.stepSize);

  const targetNotionalScaled = mulScaled(budgetScaled, leverageScaled);
  const targetShortNotionalUsd = Math.round(fromScaled(targetNotionalScaled) * 100) / 100;

  const rawQtyScaled = divScaledFloor(targetNotionalScaled, priceScaled);
  const snappedQtyScaled = floorToStep(rawQtyScaled, stepScaled);
  const actualNotionalScaled = mulScaled(snappedQtyScaled, priceScaled);

  const snappedQty = fromScaled(snappedQtyScaled);
  const actualShortNotionalUsd = Math.round(fromScaled(actualNotionalScaled) * 100) / 100;
  const actualCollateralUsd = Math.round((actualShortNotionalUsd / leverage) * 100) / 100;

  const base = { hedgeBudgetUsd, leverage, targetShortNotionalUsd };

  if (snappedQty <= 0 || snappedQty < filters.minQty) {
    return {
      ...base,
      quantity: 0,
      actualShortNotionalUsd: 0,
      actualCollateralUsd: 0,
      estimatedFeeUsd: 0,
      executable: false,
      reason: `snapped hedge quantity ${snappedQty} is below exchange minQty ${filters.minQty}`,
      deferredBudgetUsd: hedgeBudgetUsd,
    };
  }
  if (actualShortNotionalUsd < filters.minNotional) {
    return {
      ...base,
      quantity: 0,
      actualShortNotionalUsd: 0,
      actualCollateralUsd: 0,
      estimatedFeeUsd: 0,
      executable: false,
      reason: `hedge notional $${actualShortNotionalUsd} is below exchange minNotional $${filters.minNotional}`,
      deferredBudgetUsd: hedgeBudgetUsd,
    };
  }
  if (actualCollateralUsd > hedgeBudgetUsd + 1e-6) {
    // Defensive: should be unreachable given exact floor-rounding above, but
    // the hedge must never use more collateral than its allocated budget.
    return {
      ...base,
      quantity: 0,
      actualShortNotionalUsd: 0,
      actualCollateralUsd: 0,
      estimatedFeeUsd: 0,
      executable: false,
      reason: "computed collateral would exceed hedge budget",
      deferredBudgetUsd: hedgeBudgetUsd,
    };
  }

  return {
    ...base,
    quantity: snappedQty,
    actualShortNotionalUsd,
    actualCollateralUsd,
    estimatedFeeUsd: Math.round(actualShortNotionalUsd * ESTIMATED_TRADFI_PERP_TAKER_FEE_RATE * 10000) / 10000,
    executable: true,
    deferredBudgetUsd: Math.round((hedgeBudgetUsd - actualCollateralUsd) * 100) / 100,
  };
}

/**
 * Computes the full protected-DCA sizing for one contribution: the split is
 * always applied to the new contribution amount, never to account balance
 * or portfolio NAV, per HedgeOS product policy. This function is stateless
 * with respect to any existing position or portfolio value — it never reads
 * prior NAV, so ordinary price movement between contributions cannot, by
 * construction, trigger a routine rebalancing recompute here.
 */
export function sizeDcaHedgeContribution(
  contributionUsd: number,
  referencePrice: number,
  stockFilters: SymbolFilters,
  hedgeFilters: SymbolFilters,
  policy: AllocationPolicy = DEFAULT_POLICY,
): DcaHedgeSizingResult {
  if (Math.abs(policy.stockFraction + policy.hedgeFraction - 1) > 1e-9) {
    throw new Error("AllocationPolicy fractions must sum to 1");
  }
  assertValidHedgeLeverage(policy.hedgeLeverage);

  const stockBudget = Math.round(contributionUsd * policy.stockFraction * 100) / 100;
  const hedgeBudget = Math.round(contributionUsd * policy.hedgeFraction * 100) / 100;

  const stock = sizeStockLeg(stockBudget, referencePrice, stockFilters);
  const hedge = sizeHedgeLeg(hedgeBudget, policy.hedgeLeverage, referencePrice, hedgeFilters);

  return { contributionUsd, referencePrice, stock, hedge };
}
