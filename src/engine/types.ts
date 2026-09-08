export interface SymbolFilters {
  /** smallest allowed increment for quantity */
  stepSize: number;
  /** smallest tradable quantity */
  minQty: number;
  /** minimum notional (qty * price) accepted by the exchange */
  minNotional: number;
}

/** Approved P0 hedge leverage policy: default 2x, optional 3x, nothing above 3x. */
export const DEFAULT_HEDGE_LEVERAGE = 2;
export const ALLOWED_HEDGE_LEVERAGES = [2, 3] as const;
export type HedgeLeverage = (typeof ALLOWED_HEDGE_LEVERAGES)[number];

export function assertValidHedgeLeverage(leverage: number): asserts leverage is HedgeLeverage {
  if (!(ALLOWED_HEDGE_LEVERAGES as readonly number[]).includes(leverage)) {
    throw new Error(
      `Unsupported hedge leverage ${leverage}x. Approved P0 policy only permits ${ALLOWED_HEDGE_LEVERAGES.join("x or ")}x.`,
    );
  }
}

export interface AllocationPolicy {
  /** fraction of each contribution allocated to the stock leg, e.g. 0.9 */
  stockFraction: number;
  /** fraction allocated to the hedge collateral budget, e.g. 0.1. Must sum to 1 with stockFraction. */
  hedgeFraction: number;
  /** hedge leverage applied to the hedge budget to derive target short notional. 2x default, 3x max in P0. */
  hedgeLeverage: number;
}

export const DEFAULT_POLICY: AllocationPolicy = {
  stockFraction: 0.9,
  hedgeFraction: 0.1,
  hedgeLeverage: DEFAULT_HEDGE_LEVERAGE,
};

/** Rough, non-authoritative fee estimates used only to populate paper-mode receipts. Not a live fee-tier lookup. */
export const ESTIMATED_SPOT_TAKER_FEE_RATE = 0.001; // standard Binance spot taker fee; bStock promotional fee status unconfirmed
export const ESTIMATED_TRADFI_PERP_TAKER_FEE_RATE = 0.0005; // standard TradFi perpetual taker fee per Binance announcement; promo periods may lower this

export interface StockLegSizingResult {
  /** USD amount allocated to this leg from the contribution, before snapping */
  budgetUsd: number;
  /** quantity actually sized, snapped down to exchange filters */
  quantity: number;
  /** quantity * referencePrice, i.e. the real notional after snapping */
  notionalUsd: number;
  /** estimated taker fee for this fill, in USD (paper estimate, not an authoritative fee-tier lookup) */
  estimatedFeeUsd: number;
  /** false if the exchange minimums could not be met and this leg must be skipped */
  executable: boolean;
  reason?: string;
}

export interface HedgeLegSizingResult {
  /** USD collateral allocated to the hedge from the contribution (10% of contribution) */
  hedgeBudgetUsd: number;
  /** leverage applied to the hedge budget, 2x or 3x in P0 */
  leverage: number;
  /** target short notional = hedgeBudgetUsd * leverage, before snapping to exchange filters */
  targetShortNotionalUsd: number;
  /** quantity actually sized, snapped down to exchange filters */
  quantity: number;
  /** quantity * referencePrice, i.e. the real short notional after snapping (<= targetShortNotionalUsd) */
  actualShortNotionalUsd: number;
  /** collateral actually required for the snapped position: actualShortNotionalUsd / leverage (<= hedgeBudgetUsd) */
  actualCollateralUsd: number;
  /** estimated taker fee for this fill, in USD (paper estimate, not an authoritative fee-tier lookup) */
  estimatedFeeUsd: number;
  /** false if the exchange minimums could not be met; budget must be deferred, never dropped, oversized, or leveraged-up to compensate */
  executable: boolean;
  reason?: string;
  /** amount of hedgeBudgetUsd that could not be executed this cycle and must be carried forward */
  deferredBudgetUsd: number;
}

export interface DcaHedgeSizingResult {
  contributionUsd: number;
  referencePrice: number;
  stock: StockLegSizingResult;
  hedge: HedgeLegSizingResult;
}
