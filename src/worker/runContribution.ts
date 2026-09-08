import type Database from "better-sqlite3";
import { discoverPair } from "../binance/client.js";
import type { ExecutionAdapter } from "../binance/execution.js";
import { sizeDcaHedgeContribution } from "../engine/sizing.js";
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

export interface StructuredReceipt {
  executionId: number | bigint;
  status: "completed" | "unsupported_pair";
  mode: "paper" | "live";
  simulated: boolean;
  requestedContributionUsd: number;
  ticker: string;
  discovery: Awaited<ReturnType<typeof discoverPair>>;
  referencePrice?: number;
  stock?: {
    symbol: string;
    budgetUsd: number;
    simulatedFillQty: number;
    simulatedFillPrice: number;
    notionalUsd: number;
    estimatedFeeUsd: number;
    executable: boolean;
    reason?: string;
  };
  hedge?: {
    symbol: string;
    hedgeBudgetUsd: number;
    leverage: number;
    targetShortNotionalUsd: number;
    simulatedFillQty: number;
    simulatedFillPrice: number;
    actualShortNotionalUsd: number;
    actualCollateralUsd: number;
    estimatedFeeUsd: number;
    executable: boolean;
    reason?: string;
    deferredThisContributionUsd: number;
    totalDeferredBudgetUsd: number;
  };
  paperState?: ReturnType<typeof getPaperState>;
}

/**
 * Runs exactly one DCA+hedge contribution for a strategy: observe (discover
 * the live pair + fetch prices/filters) -> decide (deterministic sizing
 * engine, no LLM in this path) -> act (execution adapter) -> verify
 * (persist execution + receipts, recompute paper state from the ledger).
 * This is the one function both a scheduler and a manual demo trigger call
 * — same code path either way. If the requested ticker has no live,
 * TRADING bStock + TradFi-perpetual pair, this throws UnsupportedPairError
 * and executes nothing — it never substitutes a proxy instrument.
 */
export async function runContribution(
  db: Database.Database,
  strategy: StrategyRow,
  adapter: ExecutionAdapter,
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

  const sizing = sizeDcaHedgeContribution(strategy.contribution_usd, referencePrice, spot.filters!, futures.filters!, {
    stockFraction: 0.9,
    hedgeFraction: 0.1,
    hedgeLeverage: strategy.hedge_leverage,
  });

  const insertExec = db.prepare(`
    INSERT INTO executions (
      strategy_id, mode, status, contribution_usd, reference_price,
      stock_budget_usd, stock_qty, stock_notional_usd, stock_fee_usd, stock_executable, stock_skip_reason,
      hedge_budget_usd, hedge_leverage, hedge_target_short_notional_usd, hedge_qty,
      hedge_actual_short_notional_usd, hedge_actual_collateral_usd, hedge_fee_usd,
      hedge_executable, hedge_skip_reason, hedge_deferred_budget_usd
    ) VALUES (
      @strategyId, @mode, 'completed', @contributionUsd, @referencePrice,
      @stockBudgetUsd, @stockQty, @stockNotionalUsd, @stockFeeUsd, @stockExecutable, @stockSkipReason,
      @hedgeBudgetUsd, @hedgeLeverage, @hedgeTargetShortNotionalUsd, @hedgeQty,
      @hedgeActualShortNotionalUsd, @hedgeActualCollateralUsd, @hedgeFeeUsd,
      @hedgeExecutable, @hedgeSkipReason, @hedgeDeferredBudgetUsd
    )
  `);

  const execInfo = insertExec.run({
    strategyId: strategy.id,
    mode: adapter.mode,
    contributionUsd: sizing.contributionUsd,
    referencePrice: sizing.referencePrice,
    stockBudgetUsd: sizing.stock.budgetUsd,
    stockQty: sizing.stock.quantity,
    stockNotionalUsd: sizing.stock.notionalUsd,
    stockFeeUsd: sizing.stock.estimatedFeeUsd,
    stockExecutable: sizing.stock.executable ? 1 : 0,
    stockSkipReason: sizing.stock.reason ?? null,
    hedgeBudgetUsd: sizing.hedge.hedgeBudgetUsd,
    hedgeLeverage: sizing.hedge.leverage,
    hedgeTargetShortNotionalUsd: sizing.hedge.targetShortNotionalUsd,
    hedgeQty: sizing.hedge.quantity,
    hedgeActualShortNotionalUsd: sizing.hedge.actualShortNotionalUsd,
    hedgeActualCollateralUsd: sizing.hedge.actualCollateralUsd,
    hedgeFeeUsd: sizing.hedge.estimatedFeeUsd,
    hedgeExecutable: sizing.hedge.executable ? 1 : 0,
    hedgeSkipReason: sizing.hedge.reason ?? null,
    hedgeDeferredBudgetUsd: sizing.hedge.deferredBudgetUsd,
  });
  const executionId = execInfo.lastInsertRowid;

  const insertReceipt = db.prepare(`
    INSERT INTO receipts (execution_id, leg, symbol, side, quantity, price, notional_usd, fee_usd, mode, order_id, simulated)
    VALUES (@executionId, @leg, @symbol, @side, @quantity, @price, @notionalUsd, @feeUsd, @mode, @orderId, @simulated)
  `);

  const receipt: StructuredReceipt = {
    executionId,
    status: "completed",
    mode: adapter.mode,
    simulated: adapter.mode === "paper",
    requestedContributionUsd: strategy.contribution_usd,
    ticker: strategy.ticker,
    discovery,
    referencePrice,
    stock: {
      symbol: discovery.spotSymbol,
      budgetUsd: sizing.stock.budgetUsd,
      simulatedFillQty: 0,
      simulatedFillPrice: 0,
      notionalUsd: sizing.stock.notionalUsd,
      estimatedFeeUsd: sizing.stock.estimatedFeeUsd,
      executable: sizing.stock.executable,
      reason: sizing.stock.reason,
    },
    hedge: {
      symbol: discovery.futuresSymbol,
      hedgeBudgetUsd: sizing.hedge.hedgeBudgetUsd,
      leverage: sizing.hedge.leverage,
      targetShortNotionalUsd: sizing.hedge.targetShortNotionalUsd,
      simulatedFillQty: 0,
      simulatedFillPrice: 0,
      actualShortNotionalUsd: sizing.hedge.actualShortNotionalUsd,
      actualCollateralUsd: sizing.hedge.actualCollateralUsd,
      estimatedFeeUsd: sizing.hedge.estimatedFeeUsd,
      executable: sizing.hedge.executable,
      reason: sizing.hedge.reason,
      deferredThisContributionUsd: sizing.hedge.executable ? 0 : sizing.hedge.deferredBudgetUsd,
      totalDeferredBudgetUsd: strategy.deferred_hedge_budget_usd,
    },
  };

  if (sizing.stock.executable) {
    const fill = await adapter.placeOrder(discovery.spotSymbol, "BUY", sizing.stock, spot.price!);
    insertReceipt.run({
      executionId,
      leg: "stock",
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      notionalUsd: fill.notionalUsd,
      feeUsd: sizing.stock.estimatedFeeUsd,
      mode: fill.mode,
      orderId: fill.orderId,
      simulated: fill.mode === "paper" ? 1 : 0,
    });
    receipt.stock!.simulatedFillQty = fill.quantity;
    receipt.stock!.simulatedFillPrice = fill.price;
  }

  if (sizing.hedge.executable) {
    const fill = await adapter.placeOrder(discovery.futuresSymbol, "SELL", sizing.hedge, futures.markPrice!);
    insertReceipt.run({
      executionId,
      leg: "hedge",
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      notionalUsd: fill.notionalUsd,
      feeUsd: sizing.hedge.estimatedFeeUsd,
      mode: fill.mode,
      orderId: fill.orderId,
      simulated: fill.mode === "paper" ? 1 : 0,
    });
    receipt.hedge!.simulatedFillQty = fill.quantity;
    receipt.hedge!.simulatedFillPrice = fill.price;
  } else {
    // Policy: hedge budget below what the exchange minimum / step size can
    // support is deferred (accumulated for a future contribution), never
    // dropped, never force-executed below the venue floor, and never
    // compensated for by silently increasing leverage.
    db.prepare("UPDATE strategies SET deferred_hedge_budget_usd = deferred_hedge_budget_usd + ? WHERE id = ?").run(
      sizing.hedge.deferredBudgetUsd,
      strategy.id,
    );
    receipt.hedge!.totalDeferredBudgetUsd = strategy.deferred_hedge_budget_usd + sizing.hedge.deferredBudgetUsd;
  }

  receipt.paperState = getPaperState(db, strategy.id);
  return receipt;
}
