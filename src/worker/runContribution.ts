import type Database from "better-sqlite3";
import { discoverPair } from "../binance/client.js";
import type { ExecutionAdapter, Fill, SizedLeg } from "../binance/execution.js";
import { sizeDcaHedgeContribution, sizeHedgeLeg } from "../engine/sizing.js";
import { assertValidHedgeLeverage } from "../engine/types.js";
import { getPaperState, type StrategyRow } from "../db/index.js";

export class UnsupportedPairError extends Error {
  constructor(
    public readonly ticker: string,
    public readonly discovery: Awaited<ReturnType<typeof discoverPair>>,
  ) {
    super(
      `${ticker} is not usable for a protected-DCA strategy: ` +
        `spot(${discovery.spotSymbol})=${discovery.spot.tradable ? "OK" : discovery.spot.reason} ` +
        `futures(${discovery.futuresSymbol})=${discovery.futures.tradable ? "OK" : discovery.futures.reason}. ` +
        `No proxy hedge or substitute instrument was used.`,
    );
  }
}

export interface LegReceipt {
  symbol: string;
  budgetUsd: number;
  requestedQty: number;
  requestedNotionalUsd: number;
  filledQty: number;
  filledNotionalUsd: number;
  orderStatus: "not_submitted" | "filled" | "partially_filled" | "rejected";
  estimatedFeeUsd: number;
  executable: boolean;
  reason?: string;
}

export interface HedgeLegReceipt extends LegReceipt {
  leverage: number;
  targetShortNotionalUsd: number;
  actualCollateralUsd: number;
  deferredThisContributionUsd: number;
  totalDeferredBudgetUsd: number;
}

export interface StructuredReceipt {
  executionId: number | bigint;
  status: "completed" | "unsupported_pair" | "partial_failure";
  mode: "paper" | "live";
  simulated: boolean;
  requestedContributionUsd: number;
  ticker: string;
  discovery: Awaited<ReturnType<typeof discoverPair>>;
  referencePrice?: number;
  stock?: LegReceipt;
  hedge?: HedgeLegReceipt;
  paperState?: ReturnType<typeof getPaperState>;
}

/**
 * Runs exactly one DCA+hedge contribution for a strategy: observe (discover
 * the live pair + fetch prices/filters) -> decide (deterministic sizing
 * engine, no LLM in this path) -> act (execution adapter) -> verify
 * (persist execution + receipts, recompute paper state from actual fills).
 * This is the one function both a scheduler and a manual demo trigger call
 * — same code path either way. If the requested ticker has no live,
 * TRADING bStock + TradFi-perpetual pair, this throws UnsupportedPairError
 * and executes nothing — it never substitutes a proxy instrument.
 *
 * A leg being "executable" (sizing cleared exchange minimums) is distinct
 * from it being "filled" (the adapter actually reports a fill). If a leg is
 * executable but its order comes back rejected, the execution is recorded
 * as status="partial_failure" — NOT silently treated as completed, and NOT
 * automatically retried by the caller, because retrying a cycle where one
 * leg already filled would double that leg's exposure. Deferred-hedge
 * accounting only applies to legs that were never executable in the first
 * place (below exchange minimums), never to a rejected order.
 */
/**
 * CRITICAL SAFETY WRAPPER — do not remove. `adapter.placeOrder` can THROW
 * (not just resolve with a status:"rejected" Fill) — e.g. an insufficient-
 * margin error, a permission failure, or a genuinely unresolved
 * ambiguous-outcome error from `LiveExecutionAdapter` (see
 * `liveExecution.ts`). Before this wrapper existed, a throw from the HEDGE
 * leg propagated straight out of `runContribution` and skipped the
 * `INSERT INTO executions`/`receipts` calls entirely — meaning a STOCK leg
 * that had genuinely, exchange-confirmed FILLED would never be recorded
 * anywhere in HedgeOS: no execution row, no receipt, invisible to
 * get_strategy_status/list_receipts/the dashboard, with a real position
 * sitting on the exchange. This wrapper ensures every call site always
 * gets back a Fill-shaped result — a thrown error becomes a synthetic
 * "rejected" Fill whose `reason` is explicitly prefixed UNRESOLVED (never
 * conflated with a confirmed exchange rejection), so the existing
 * partial_failure / never-auto-retry / manual-review path in this function
 * and in `scheduler/cycles.ts` still engages correctly, and nothing is
 * silently lost.
 */
async function placeOrderCapturingThrow(
  adapter: ExecutionAdapter,
  symbol: string,
  side: "BUY" | "SELL",
  leg: SizedLeg,
  referencePrice: number,
  idempotencyContext: { strategyId: number; cycleId: number; leg: "stock" | "hedge" } | undefined,
): Promise<Fill> {
  try {
    return await adapter.placeOrder(symbol, side, leg, referencePrice, idempotencyContext);
  } catch (err) {
    return {
      symbol,
      side,
      quantity: 0,
      price: 0,
      notionalUsd: 0,
      mode: adapter.mode,
      orderId: "unresolved",
      status: "rejected",
      reason:
        `UNRESOLVED — order placement threw and did NOT return a confirmed exchange response. This is NOT a confirmed rejection: ` +
        `the order may have partially or fully filled on the exchange despite this error. Do not assume zero exposure — manually verify ` +
        `actual exchange state (GET positionRisk / openOrders / userTrades for ${symbol}) before taking any further action on this strategy. ` +
        `Original error: ${(err as Error).message}`,
    };
  }
}

export async function runContribution(
  db: Database.Database,
  strategy: StrategyRow,
  adapter: ExecutionAdapter,
  /**
   * The due-cycle row id this contribution is running for. Required to
   * derive a stable per-leg clientOrderId for the live adapter (see
   * `liveExecution.ts`) — the paper adapter ignores it. Omitted only by
   * manual/preview call sites that never reach a live adapter.
   */
  cycleId?: number,
): Promise<StructuredReceipt> {
  assertValidHedgeLeverage(strategy.hedge_leverage);

  const discovery = await discoverPair(strategy.ticker);
  if (!discovery.usableForProtectedDca) {
    const insertUnsupported = db.prepare(`
      INSERT INTO executions (
        strategy_id, mode, status, contribution_usd, reference_price,
        stock_budget_usd, stock_qty, stock_notional_usd, stock_fee_usd, stock_executable, stock_skip_reason,
        hedge_budget_usd, hedge_leverage, hedge_target_short_notional_usd, hedge_qty,
        hedge_actual_short_notional_usd, hedge_actual_collateral_usd, hedge_fee_usd,
        hedge_executable, hedge_skip_reason, hedge_deferred_budget_usd, skip_reason
      ) VALUES (
        @strategyId, @mode, 'unsupported_pair', @contributionUsd, 0,
        0, 0, 0, 0, 0, @stockSkipReason,
        0, @hedgeLeverage, 0, 0,
        0, 0, 0,
        0, @hedgeSkipReason, 0, @skipReason
      )
    `);
    const info = insertUnsupported.run({
      strategyId: strategy.id,
      mode: adapter.mode,
      contributionUsd: strategy.contribution_usd,
      hedgeLeverage: strategy.hedge_leverage,
      stockSkipReason: discovery.spot.reason ?? null,
      hedgeSkipReason: discovery.futures.reason ?? null,
      skipReason: `unsupported pair: ${strategy.ticker}`,
    });

    return {
      executionId: info.lastInsertRowid,
      status: "unsupported_pair",
      mode: adapter.mode,
      simulated: adapter.mode === "paper",
      requestedContributionUsd: strategy.contribution_usd,
      ticker: strategy.ticker,
      discovery,
    };
  }

  const { spot, futures } = discovery;
  const referencePrice = spot.price!;
  const policy = { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: strategy.hedge_leverage };

  const sizing = sizeDcaHedgeContribution(strategy.contribution_usd, referencePrice, spot.filters!, futures.filters!, policy);

  let stockFill: Fill | undefined;
  if (sizing.stock.executable) {
    stockFill = await placeOrderCapturingThrow(
      adapter,
      discovery.spotSymbol,
      "BUY",
      sizing.stock,
      spot.price!,
      cycleId !== undefined ? { strategyId: strategy.id, cycleId, leg: "stock" } : undefined,
    );
  }

  // Stock leg always runs first, so a stock-side rejection is known before
  // any futures-side state (leverage/margin config, an open order) is
  // touched — the safer default sequencing.
  //
  // Live mode only: re-derive the hedge budget from the STOCK LEG'S ACTUAL
  // FILLED NOTIONAL (not the pre-trade budgeted target), preserving the same
  // 90/10 ratio applied to real, realized dollars — a market order can fill
  // at a slightly different notional than budgeted, and the hedge should
  // track the exposure that actually exists, not the exposure that was
  // planned. Paper mode is deliberately left untouched (still sizes the
  // hedge from the nominal contribution split) so none of the 56 existing
  // paper-mode tests or demo behavior change.
  let hedgeSizing = sizing.hedge;
  if (adapter.mode === "live" && stockFill && stockFill.status !== "rejected" && stockFill.notionalUsd > 0) {
    const actualHedgeBudgetUsd = Math.round(stockFill.notionalUsd * (policy.hedgeFraction / policy.stockFraction) * 100) / 100;
    hedgeSizing = sizeHedgeLeg(actualHedgeBudgetUsd, policy.hedgeLeverage, futures.markPrice!, futures.filters!);
  }
  sizing.hedge = hedgeSizing;

  let hedgeFill: Fill | undefined;
  if (sizing.hedge.executable) {
    hedgeFill = await placeOrderCapturingThrow(
      adapter,
      discovery.futuresSymbol,
      "SELL",
      sizing.hedge,
      futures.markPrice!,
      cycleId !== undefined ? { strategyId: strategy.id, cycleId, leg: "hedge" } : undefined,
    );
  }

  const stockOrderStatus = stockFill?.status ?? "not_submitted";
  const hedgeOrderStatus = hedgeFill?.status ?? "not_submitted";
  const stockRejected = sizing.stock.executable && stockOrderStatus === "rejected";
  const hedgeRejected = sizing.hedge.executable && hedgeOrderStatus === "rejected";
  const overallStatus: StructuredReceipt["status"] = stockRejected || hedgeRejected ? "partial_failure" : "completed";

  const insertExec = db.prepare(`
    INSERT INTO executions (
      strategy_id, mode, status, contribution_usd, reference_price,
      stock_budget_usd, stock_qty, stock_notional_usd, stock_filled_qty, stock_filled_notional_usd,
      stock_order_status, stock_fee_usd, stock_executable, stock_skip_reason,
      hedge_budget_usd, hedge_leverage, hedge_target_short_notional_usd, hedge_qty,
      hedge_actual_short_notional_usd, hedge_filled_qty, hedge_filled_notional_usd, hedge_order_status,
      hedge_actual_collateral_usd, hedge_fee_usd,
      hedge_executable, hedge_skip_reason, hedge_deferred_budget_usd, skip_reason
    ) VALUES (
      @strategyId, @mode, @overallStatus, @contributionUsd, @referencePrice,
      @stockBudgetUsd, @stockQty, @stockNotionalUsd, @stockFilledQty, @stockFilledNotionalUsd,
      @stockOrderStatus, @stockFeeUsd, @stockExecutable, @stockSkipReason,
      @hedgeBudgetUsd, @hedgeLeverage, @hedgeTargetShortNotionalUsd, @hedgeQty,
      @hedgeActualShortNotionalUsd, @hedgeFilledQty, @hedgeFilledNotionalUsd, @hedgeOrderStatus,
      @hedgeActualCollateralUsd, @hedgeFeeUsd,
      @hedgeExecutable, @hedgeSkipReason, @hedgeDeferredBudgetUsd, @skipReason
    )
  `);

  const execInfo = insertExec.run({
    strategyId: strategy.id,
    mode: adapter.mode,
    overallStatus,
    contributionUsd: sizing.contributionUsd,
    referencePrice: sizing.referencePrice,
    stockBudgetUsd: sizing.stock.budgetUsd,
    stockQty: sizing.stock.quantity,
    stockNotionalUsd: sizing.stock.notionalUsd,
    stockFilledQty: stockFill?.quantity ?? 0,
    stockFilledNotionalUsd: stockFill?.notionalUsd ?? 0,
    stockOrderStatus,
    stockFeeUsd: sizing.stock.estimatedFeeUsd,
    stockExecutable: sizing.stock.executable ? 1 : 0,
    stockSkipReason: sizing.stock.reason ?? null,
    hedgeBudgetUsd: sizing.hedge.hedgeBudgetUsd,
    hedgeLeverage: sizing.hedge.leverage,
    hedgeTargetShortNotionalUsd: sizing.hedge.targetShortNotionalUsd,
    hedgeQty: sizing.hedge.quantity,
    hedgeActualShortNotionalUsd: sizing.hedge.actualShortNotionalUsd,
    hedgeFilledQty: hedgeFill?.quantity ?? 0,
    hedgeFilledNotionalUsd: hedgeFill?.notionalUsd ?? 0,
    hedgeOrderStatus,
    hedgeActualCollateralUsd: sizing.hedge.actualCollateralUsd,
    hedgeFeeUsd: sizing.hedge.estimatedFeeUsd,
    hedgeExecutable: sizing.hedge.executable ? 1 : 0,
    hedgeSkipReason: sizing.hedge.reason ?? null,
    hedgeDeferredBudgetUsd: sizing.hedge.deferredBudgetUsd,
    skipReason:
      stockRejected || hedgeRejected
        ? `partial cycle failure — stock:${stockOrderStatus}${stockFill?.reason ? ` (${stockFill.reason})` : ""}, hedge:${hedgeOrderStatus}${hedgeFill?.reason ? ` (${hedgeFill.reason})` : ""}`
        : null,
  });
  const executionId = execInfo.lastInsertRowid;

  const insertReceipt = db.prepare(`
    INSERT INTO receipts (execution_id, leg, symbol, side, quantity, price, notional_usd, fee_usd, mode, order_id, status, reason, simulated)
    VALUES (@executionId, @leg, @symbol, @side, @quantity, @price, @notionalUsd, @feeUsd, @mode, @orderId, @status, @reason, @simulated)
  `);

  if (stockFill) {
    insertReceipt.run({
      executionId,
      leg: "stock",
      symbol: stockFill.symbol,
      side: stockFill.side,
      quantity: stockFill.quantity,
      price: stockFill.price,
      notionalUsd: stockFill.notionalUsd,
      feeUsd: sizing.stock.estimatedFeeUsd,
      mode: stockFill.mode,
      orderId: stockFill.orderId,
      status: stockFill.status,
      reason: stockFill.reason ?? null,
      simulated: stockFill.mode === "paper" ? 1 : 0,
    });
  }
  if (hedgeFill) {
    insertReceipt.run({
      executionId,
      leg: "hedge",
      symbol: hedgeFill.symbol,
      side: hedgeFill.side,
      quantity: hedgeFill.quantity,
      price: hedgeFill.price,
      notionalUsd: hedgeFill.notionalUsd,
      feeUsd: sizing.hedge.estimatedFeeUsd,
      mode: hedgeFill.mode,
      orderId: hedgeFill.orderId,
      status: hedgeFill.status,
      reason: hedgeFill.reason ?? null,
      simulated: hedgeFill.mode === "paper" ? 1 : 0,
    });
  }

  // Deferred-budget accounting applies only when the hedge was never
  // executable in the first place (below exchange minimums) — a policy
  // outcome, not a failure. A rejected order is a different, more serious
  // condition surfaced via overallStatus="partial_failure" above, and is
  // never silently folded into the deferred-budget bucket.
  if (!sizing.hedge.executable) {
    db.prepare("UPDATE strategies SET deferred_hedge_budget_usd = deferred_hedge_budget_usd + ? WHERE id = ?").run(
      sizing.hedge.deferredBudgetUsd,
      strategy.id,
    );
  }

  const receipt: StructuredReceipt = {
    executionId,
    status: overallStatus,
    mode: adapter.mode,
    simulated: adapter.mode === "paper",
    requestedContributionUsd: strategy.contribution_usd,
    ticker: strategy.ticker,
    discovery,
    referencePrice,
    stock: {
      symbol: discovery.spotSymbol,
      budgetUsd: sizing.stock.budgetUsd,
      requestedQty: sizing.stock.quantity,
      requestedNotionalUsd: sizing.stock.notionalUsd,
      filledQty: stockFill?.quantity ?? 0,
      filledNotionalUsd: stockFill?.notionalUsd ?? 0,
      orderStatus: stockOrderStatus,
      estimatedFeeUsd: sizing.stock.estimatedFeeUsd,
      executable: sizing.stock.executable,
      reason: sizing.stock.reason ?? stockFill?.reason,
    },
    hedge: {
      symbol: discovery.futuresSymbol,
      budgetUsd: sizing.hedge.hedgeBudgetUsd,
      requestedQty: sizing.hedge.quantity,
      requestedNotionalUsd: sizing.hedge.actualShortNotionalUsd,
      filledQty: hedgeFill?.quantity ?? 0,
      filledNotionalUsd: hedgeFill?.notionalUsd ?? 0,
      orderStatus: hedgeOrderStatus,
      estimatedFeeUsd: sizing.hedge.estimatedFeeUsd,
      executable: sizing.hedge.executable,
      reason: sizing.hedge.reason ?? hedgeFill?.reason,
      leverage: sizing.hedge.leverage,
      targetShortNotionalUsd: sizing.hedge.targetShortNotionalUsd,
      actualCollateralUsd: sizing.hedge.actualCollateralUsd,
      deferredThisContributionUsd: sizing.hedge.executable ? 0 : sizing.hedge.deferredBudgetUsd,
      totalDeferredBudgetUsd: sizing.hedge.executable
        ? strategy.deferred_hedge_budget_usd
        : strategy.deferred_hedge_budget_usd + sizing.hedge.deferredBudgetUsd,
    },
  };

  receipt.paperState = getPaperState(db, strategy.id);
  return receipt;
}
