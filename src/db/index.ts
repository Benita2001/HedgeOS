import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidHedgeLeverage, DEFAULT_HEDGE_LEVERAGE } from "../engine/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(path = process.env.HEDGEOS_DB_PATH ?? "./data/hedgeos.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}

export interface StrategyRow {
  id: number;
  ticker: string;
  spot_symbol: string;
  futures_symbol: string;
  contribution_usd: number;
  frequency: "daily" | "weekly" | "monthly";
  hedge_leverage: number;
  status: "active" | "paused";
  next_due_at: string;
  created_at: string;
  deferred_hedge_budget_usd: number;
}

export function createStrategy(
  db: Database.Database,
  args: {
    ticker: string;
    spotSymbol: string;
    futuresSymbol: string;
    contributionUsd: number;
    frequency: "daily" | "weekly" | "monthly";
    hedgeLeverage?: number;
    /** ISO timestamp of the first due contribution. Defaults to now (due immediately) — mainly for demo/testing. */
    firstDueAt?: string;
  },
): StrategyRow {
  const hedgeLeverage = args.hedgeLeverage ?? DEFAULT_HEDGE_LEVERAGE;
  assertValidHedgeLeverage(hedgeLeverage);

  const stmt = db.prepare(
    `INSERT INTO strategies (ticker, spot_symbol, futures_symbol, contribution_usd, frequency, hedge_leverage, next_due_at)
     VALUES (@ticker, @spotSymbol, @futuresSymbol, @contributionUsd, @frequency, @hedgeLeverage, COALESCE(@firstDueAt, datetime('now')))`,
  );
  const info = stmt.run({
    ticker: args.ticker,
    spotSymbol: args.spotSymbol,
    futuresSymbol: args.futuresSymbol,
    contributionUsd: args.contributionUsd,
    frequency: args.frequency,
    hedgeLeverage,
    firstDueAt: args.firstDueAt ?? null,
  });
  return db.prepare("SELECT * FROM strategies WHERE id = ?").get(info.lastInsertRowid) as StrategyRow;
}

export function listActiveStrategies(db: Database.Database): StrategyRow[] {
  return db.prepare("SELECT * FROM strategies WHERE status = 'active' ORDER BY id").all() as StrategyRow[];
}

export interface PaperState {
  strategyId: number;
  contributionsCount: number;
  cumulativeStockQty: number;
  cumulativeStockNotionalUsd: number;
  cumulativeHedgeQty: number;
  cumulativeHedgeCollateralUsd: number;
  cumulativeFeesUsd: number;
  deferredHedgeBudgetUsd: number;
}

/**
 * Aggregates the paper-mode position purely from persisted executions —
 * never recomputed from an LLM guess, never inferred from account balance.
 */
export function getPaperState(db: Database.Database, strategyId: number): PaperState {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS contributionsCount,
         COALESCE(SUM(stock_qty), 0) AS cumulativeStockQty,
         COALESCE(SUM(stock_notional_usd), 0) AS cumulativeStockNotionalUsd,
         COALESCE(SUM(hedge_qty), 0) AS cumulativeHedgeQty,
         COALESCE(SUM(hedge_actual_collateral_usd), 0) AS cumulativeHedgeCollateralUsd,
         COALESCE(SUM(stock_fee_usd) + SUM(hedge_fee_usd), 0) AS cumulativeFeesUsd
       FROM executions WHERE strategy_id = ? AND status = 'completed'`,
    )
    .get(strategyId) as Omit<PaperState, "strategyId" | "deferredHedgeBudgetUsd">;

  const strategy = getStrategy(db, strategyId);
  return {
    strategyId,
    ...row,
    deferredHedgeBudgetUsd: strategy?.deferred_hedge_budget_usd ?? 0,
  };
}

export function listStrategies(db: Database.Database): StrategyRow[] {
  return db.prepare("SELECT * FROM strategies ORDER BY id").all() as StrategyRow[];
}

export function getStrategy(db: Database.Database, id: number): StrategyRow | undefined {
  return db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as StrategyRow | undefined;
}

export function listExecutions(db: Database.Database, strategyId?: number) {
  if (strategyId) {
    return db.prepare("SELECT * FROM executions WHERE strategy_id = ? ORDER BY id DESC").all(strategyId);
  }
  return db.prepare("SELECT * FROM executions ORDER BY id DESC").all();
}

export function listReceipts(db: Database.Database, executionId?: number) {
  if (executionId) {
    return db.prepare("SELECT * FROM receipts WHERE execution_id = ? ORDER BY id").all(executionId);
  }
  return db.prepare("SELECT * FROM receipts ORDER BY id DESC LIMIT 200").all();
}
