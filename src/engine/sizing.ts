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

/**
 * Snaps a raw quantity down to the exchange's stepSize using integer arithmetic
 * on the step's decimal precision, avoiding binary floating-point drift
 * (e.g. 0.1 + 0.2 !== 0.3) that is unacceptable in an order-sizing path.
 * Always rounds toward zero (down) — HedgeOS never rounds up past a budget.
 */
export function snapDownToStep(rawQty: number, stepSize: number): number {
  if (stepSize <= 0) return rawQty;
  const decimals = decimalPlaces(stepSize);
  // The epsilon only cancels binary floating-point representation noise
  // (e.g. 0.3/0.1 landing on 2.9999999996 instead of 3) — it must never be
  // large enough to bump a genuinely-fractional unit count up to the next
  // integer, or this would round UP, which is unacceptable in order sizing.
  const steppedUnits = Math.floor(rawQty / stepSize + 1e-9);
  return round(steppedUnits * stepSize, decimals);
}

function decimalPlaces(n: number): number {
  const s = n.toString();
  if (s.includes("e-")) {
    return Number(s.split("e-")[1]);
  }
  const parts = s.split(".");
  return parts.length > 1 ? parts[1].length : 0;
}

function round(n: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/**
 * Sizes the stock leg deterministically: no LLM, no external call, pure
 * function of budget/price/filters. Returns executable=false rather than
 * silently trading below exchange minimums or rounding up past budget.
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
  const rawQty = budgetUsd / referencePrice;
  const snappedQty = snapDownToStep(rawQty, filters.stepSize);
  const notionalUsd = round(snappedQty * referencePrice, 2);

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
    estimatedFeeUsd: round(notionalUsd * ESTIMATED_SPOT_TAKER_FEE_RATE, 4),
    executable: true,
  };
}

/**
 * Sizes the hedge leg deterministically. The $X hedge allocation is treated
 * as collateral (margin) posted at a fixed leverage (2x default, 3x max in
 * P0) — the target short notional is hedgeBudgetUsd * leverage, snapped down
 * to the exchange's real filters. If even the smallest permitted order would
 * exceed the notional the budget can support, or the snapped notional falls
 * under the exchange minimum, the leg is not executed and the full budget is
 * reported as deferred — it is never dropped, never oversized past budget,
 * and leverage is never silently increased to force an execution.
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

  const targetShortNotionalUsd = round(hedgeBudgetUsd * leverage, 2);
  const rawQty = targetShortNotionalUsd / referencePrice;
  const snappedQty = snapDownToStep(rawQty, filters.stepSize);
  const actualShortNotionalUsd = round(snappedQty * referencePrice, 2);
  const actualCollateralUsd = round(actualShortNotionalUsd / leverage, 2);

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
    // Defensive: should be unreachable given rounding-down above, but the
    // hedge must never use more collateral than its allocated budget.
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
    estimatedFeeUsd: round(actualShortNotionalUsd * ESTIMATED_TRADFI_PERP_TAKER_FEE_RATE, 4),
    executable: true,
    deferredBudgetUsd: round(hedgeBudgetUsd - actualCollateralUsd, 2),
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

  const stockBudget = round(contributionUsd * policy.stockFraction, 2);
  const hedgeBudget = round(contributionUsd * policy.hedgeFraction, 2);

  const stock = sizeStockLeg(stockBudget, referencePrice, stockFilters);
  const hedge = sizeHedgeLeg(hedgeBudget, policy.hedgeLeverage, referencePrice, hedgeFilters);

  return { contributionUsd, referencePrice, stock, hedge };
}
