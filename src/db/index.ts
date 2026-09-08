import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidHedgeLeverage, DEFAULT_HEDGE_LEVERAGE } from "../engine/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Additive, backward-compatible migrations for databases created before a
 * column existed. `CREATE TABLE IF NOT EXISTS` (schema.sql) only affects
 * brand-new databases — an already-existing `strategies` table (this
 * project's local dev DB, the deployed VPS DB, anyone's existing install)
 * needs an explicit `ALTER TABLE ADD COLUMN` to pick up a new column.
 * Every migration here must be a no-op on a DB that already has the
 * column, and must never touch existing rows' data.
 */
function runMigrations(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(strategies)").all() as Array<{ name: string }>;
  const hasEndAt = columns.some((c) => c.name === "end_at");
  if (!hasEndAt) {
    // Nullable, no default beyond NULL — every existing row gets end_at=NULL,
    // which means "runs indefinitely," the exact behavior those rows already had.
    db.exec("ALTER TABLE strategies ADD COLUMN end_at TEXT DEFAULT NULL");
  }
}

export function openDb(path = process.env.HEDGEOS_DB_PATH ?? "./data/hedgeos.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
  runMigrations(db);
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
  /** ISO timestamp or null. Null (the default, and every pre-existing strategy's value) means "runs indefinitely." */
  end_at: string | null;
}

/**
 * True once the strategy's schedule has genuinely ended — its next
 * occurrence would fall after `end_at`, so the scheduler will create no
 * further cycles for it. This is a derived fact, not a stored status: a
 * strategy with an ended schedule stays `status: 'active'` in the DB
 * (never auto-transitioned to any other state, and never triggers
 * liquidation of accumulated positions) — this function exists so
 * operators/UIs can surface "this schedule is done" without needing a new
 * status value or a schema CHECK-constraint migration.
 */
export function hasScheduleEnded(strategy: Pick<StrategyRow, "next_due_at" | "end_at">, now: Date = new Date()): boolean {
  if (!strategy.end_at) return false;
  const next = new Date(strategy.next_due_at.replace(" ", "T") + (strategy.next_due_at.endsWith("Z") ? "" : "Z"));
  const end = new Date(strategy.end_at);
  return next.getTime() > end.getTime();
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
    /** Optional ISO timestamp. Omitted/undefined = runs indefinitely (unchanged default behavior). The caller (an AI operator interpreting "for six months," or a human) is responsible for turning a duration into a concrete date — HedgeOS itself never guesses a duration from vague language. */
    endAt?: string;
  },
): StrategyRow {
  const hedgeLeverage = args.hedgeLeverage ?? DEFAULT_HEDGE_LEVERAGE;
  assertValidHedgeLeverage(hedgeLeverage);
  if (args.endAt !== undefined && Number.isNaN(new Date(args.endAt).getTime())) {
    throw new Error(`endAt "${args.endAt}" is not a valid ISO timestamp`);
  }

  const stmt = db.prepare(
    `INSERT INTO strategies (ticker, spot_symbol, futures_symbol, contribution_usd, frequency, hedge_leverage, next_due_at, end_at)
     VALUES (@ticker, @spotSymbol, @futuresSymbol, @contributionUsd, @frequency, @hedgeLeverage, COALESCE(@firstDueAt, datetime('now')), @endAt)`,
  );
  const info = stmt.run({
    ticker: args.ticker,
    spotSymbol: args.spotSymbol,
    futuresSymbol: args.futuresSymbol,
    contributionUsd: args.contributionUsd,
    frequency: args.frequency,
    hedgeLeverage,
    firstDueAt: args.firstDueAt ?? null,
    endAt: args.endAt ?? null,
  });
  return db.prepare("SELECT * FROM strategies WHERE id = ?").get(info.lastInsertRowid) as StrategyRow;
}

export function listActiveStrategies(db: Database.Database): StrategyRow[] {
  return db.prepare("SELECT * FROM strategies WHERE status = 'active' ORDER BY id").all() as StrategyRow[];
}

/** Pauses a strategy: the scheduler's ensureDueCycles/listActiveStrategies will skip it entirely — no new cycles are created while paused. Cycles already pending/in_progress are unaffected (they still resolve normally). */
export function pauseStrategy(db: Database.Database, id: number): StrategyRow | undefined {
  db.prepare("UPDATE strategies SET status = 'paused' WHERE id = ?").run(id);
  return getStrategy(db, id);
}

export function resumeStrategy(db: Database.Database, id: number): StrategyRow | undefined {
  db.prepare("UPDATE strategies SET status = 'active' WHERE id = ?").run(id);
  return getStrategy(db, id);
}

export function getLatestExecution(db: Database.Database, strategyId: number) {
  return db.prepare("SELECT * FROM executions WHERE strategy_id = ? ORDER BY id DESC LIMIT 1").get(strategyId) as
    | Record<string, unknown>
    | undefined;
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
  // Aggregates from ACTUAL FILLED quantities/notional, not the sizing
  // engine's requested amounts — a partial fill or a rejected leg (status
  // partial_failure) must never be over-reported as fully executed.
  // Includes every execution row (even a partial_failure or an
  // unsupported_pair row, which simply contributes zeros) so whatever
  // genuinely filled is always counted, regardless of the other leg's fate.
  const row = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') AS contributionsCount,
         COALESCE(SUM(stock_filled_qty), 0) AS cumulativeStockQty,
         COALESCE(SUM(stock_filled_notional_usd), 0) AS cumulativeStockNotionalUsd,
         COALESCE(SUM(hedge_filled_qty), 0) AS cumulativeHedgeQty,
         COALESCE(SUM(CASE WHEN hedge_order_status IN ('filled','partially_filled') THEN hedge_actual_collateral_usd ELSE 0 END), 0) AS cumulativeHedgeCollateralUsd,
         COALESCE(SUM(stock_fee_usd) + SUM(hedge_fee_usd), 0) AS cumulativeFeesUsd
       FROM executions WHERE strategy_id = ?`,
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
