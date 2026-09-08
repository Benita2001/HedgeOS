import type { PaperState, StrategyRow } from "../db/index.js";

export type RiskLevel = "info" | "warning" | "critical";

export interface RiskAlert {
  level: RiskLevel;
  code: string;
  message: string;
}

export interface LatestExecutionSummary {
  ts: string;
  status: "completed" | "unsupported_pair" | "partial_failure";
  hedge_filled_qty: number;
  hedge_actual_short_notional_usd: number;
  hedge_actual_collateral_usd: number;
  stock_filled_qty: number;
  stock_filled_notional_usd: number;
  stock_notional_usd: number;
}

const CADENCE_MS: Record<StrategyRow["frequency"], number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Deterministic, explainable risk checks — no LLM judgment, no automatic
 * action. These surface conditions for a human (or a future, separately
 * approved policy) to act on; they never themselves trigger a rebalance,
 * a leverage change, or a hedge re-size. Intentionally modest: this does
 * NOT claim real-time liquidation-proximity monitoring, because that would
 * require an ongoing mark-to-market price feed against open positions,
 * which HedgeOS does not yet run. Flagging that gap explicitly rather than
 * faking a check that isn't backed by live position tracking.
 */
export function evaluateRiskAlerts(
  strategy: StrategyRow,
  paperState: PaperState,
  latestExecution: LatestExecutionSummary | undefined,
  now: Date = new Date(),
): RiskAlert[] {
  const alerts: RiskAlert[] = [];

  if (strategy.status === "active" && paperState.deferredHedgeBudgetUsd > 0 && paperState.cumulativeStockNotionalUsd > 0) {
    alerts.push({
      level: "warning",
      code: "missing_hedge_exposure",
      message: `$${paperState.deferredHedgeBudgetUsd.toFixed(2)} of hedge budget has accumulated without ever clearing the exchange minimum — stock exposure of $${paperState.cumulativeStockNotionalUsd.toFixed(2)} is currently running with less hedge coverage than the policy targets. This is a known, policy-compliant outcome (deferred, not dropped), not a bug — but it means real hedge exposure is below the 2x/3x target until the deferred budget clears a minimum.`,
    });
  }

  if (strategy.status === "active") {
    const lastRunMs = latestExecution ? new Date(latestExecution.ts.replace(" ", "T") + "Z").getTime() : undefined;
    const expectedIntervalMs = CADENCE_MS[strategy.frequency];
    if (!lastRunMs || now.getTime() - lastRunMs > expectedIntervalMs * 2) {
      alerts.push({
        level: "warning",
        code: "stale_schedule",
        message: lastRunMs
          ? `Last successful contribution was ${(((now.getTime() - lastRunMs) / expectedIntervalMs).toFixed(1))}x the strategy's own ${strategy.frequency} interval ago — the schedule may be stalled.`
          : "No successful contribution has ever been recorded for this active strategy.",
      });
    }
  }

  if (latestExecution && latestExecution.status === "completed") {
    const stockNotionalDrift = Math.abs(latestExecution.stock_filled_notional_usd - latestExecution.stock_notional_usd);
    if (latestExecution.stock_filled_qty > 0 && stockNotionalDrift > 0.5) {
      alerts.push({
        level: "critical",
        code: "reconciliation_discrepancy",
        message: `Stock leg's filled notional ($${latestExecution.stock_filled_notional_usd.toFixed(2)}) differs from its planned notional ($${latestExecution.stock_notional_usd.toFixed(2)}) by more than $0.50 — reconcile before trusting this execution's accounting.`,
      });
    }
  }

  // Static, documented informational note — not a live liquidation check.
  const maintenanceMarginPercentEstimate = 0.025; // matches the NVDAUSDT contract spec observed in Phase 0 validation; not re-verified live per strategy
  const headroomAtConfiguredLeverage = 1 / strategy.hedge_leverage - maintenanceMarginPercentEstimate;
  alerts.push({
    level: "info",
    code: "static_leverage_headroom",
    message: `At ${strategy.hedge_leverage}x hedge leverage, posted margin sits ~${(headroomAtConfiguredLeverage * 100).toFixed(1)}% of notional above the exchange's typical ~2.5% maintenance margin threshold (a static calculation using Phase 0's observed contract spec, not a live mark-to-market check — HedgeOS does not yet track live price movement against open positions).`,
  });

  return alerts;
}
