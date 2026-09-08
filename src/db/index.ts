import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidHedgeLeverage, DEFAULT_HEDGE_LEVERAGE } from "../engine/types.js";
import { assertValidIntervalMinutes } from "../scheduler/cadence.js";

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
  const hasIntervalMinutes = columns.some((c) => c.name === "interval_minutes");
  if (!hasIntervalMinutes) {
    // Nullable — every existing row gets interval_minutes=NULL, meaning "use the
    // daily/weekly/monthly calendar cadence," the exact behavior those rows already had.
    db.exec("ALTER TABLE strategies ADD COLUMN interval_minutes INTEGER DEFAULT NULL");
  }
  if (!columns.some((c) => c.name === "funding_mode")) {
    // Existing rows get 'prefunded' — identical to their behavior before this column existed
    // (nothing anywhere in the codebase ever attempted an automatic transfer until this change).
    db.exec("ALTER TABLE strategies ADD COLUMN funding_mode TEXT NOT NULL DEFAULT 'prefunded'");
    db.exec("ALTER TABLE strategies ADD COLUMN funding_buffer_usd REAL NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE strategies ADD COLUMN funding_per_cycle_cap_usd REAL NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE strategies ADD COLUMN funding_period_cap_usd REAL DEFAULT NULL");
  }
  if (!columns.some((c) => c.name === "mode")) {
    // Every existing strategy gets mode='paper' — identical to its actual prior behavior
    // (nothing anywhere could create a live-mode strategy record before this change).
    db.exec("ALTER TABLE strategies ADD COLUMN mode TEXT NOT NULL DEFAULT 'paper'");
    db.exec("ALTER TABLE strategies ADD COLUMN capital_limit_usd REAL DEFAULT NULL");
  }
  if (!columns.some((c) => c.name === "live_authorized_at")) {
    db.exec("ALTER TABLE strategies ADD COLUMN live_authorized_at TEXT DEFAULT NULL");
  }
  const executionsColumns = db.prepare("PRAGMA table_info(executions)").all() as Array<{ name: string }>;
  if (!executionsColumns.some((c) => c.name === "funding_step_json")) {
    db.exec("ALTER TABLE executions ADD COLUMN funding_step_json TEXT DEFAULT NULL");
  }
  const hasFundingReservations = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='funding_reservations'").get() as { name: string } | undefined) !== undefined;
  if (!hasFundingReservations) {
    db.exec(`
      CREATE TABLE funding_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id INTEGER NOT NULL REFERENCES strategies(id),
        cycle_id INTEGER NOT NULL REFERENCES cycles(id),
        amount_usd REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'released')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        UNIQUE (strategy_id, cycle_id)
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_funding_reservations_status ON funding_reservations(status)");
  }
}

/** Minutes after which a still-'pending' reservation is treated as abandoned (its cycle almost
 * certainly crashed/timed out — cycles.claimCycle's own restart-recovery path resolves the cycle
 * itself; this is the analogous staleness cutoff for the reservation row so a genuinely abandoned
 * reservation doesn't permanently and incorrectly reduce other strategies' available funding). A
 * fresh retry of the SAME cycle reuses its existing reservation row via the UNIQUE constraint,
 * never creates a second one — staleness only matters for a reservation whose cycle was abandoned
 * without ever resolving (crash before any resolution), not for a normal retry. */
export const FUNDING_RESERVATION_STALE_AFTER_MINUTES = 15;

export interface FundingReservation {
  id: number;
  strategy_id: number;
  cycle_id: number;
  amount_usd: number;
  status: "pending" | "confirmed" | "released";
  created_at: string;
  resolved_at: string | null;
}

/**
 * Atomically checks the account's real Futures balance (fetched by the
 * caller, since it's an external read) against every OTHER strategy's
 * durable commitment — confirmed collateral (`executions`) PLUS other
 * strategies' still-`pending` reservations — and, if sufficient, reserves
 * the requested amount for THIS (strategyId, cycleId) in the SAME
 * transaction. Runs under `db.transaction(...).immediate()`: better-
 * sqlite3/SQLite acquires a RESERVED lock before executing anything
 * inside, so a second process calling this concurrently for a different
 * strategy genuinely cannot interleave with the first — it blocks until
 * the first transaction commits, then reads the first's reservation as
 * already-committed fact. This is what closes the race the plain
 * sum-of-filled-collateral check could not: two concurrent callers can
 * never both observe "sufficient" for the same dollar.
 *
 * Idempotent for retries of the SAME cycle: the UNIQUE(strategy_id,
 * cycle_id) constraint means a second call for a cycle that already has a
 * reservation returns the EXISTING reservation (not a duplicate, not an
 * error) — so a scheduler retry after a crash never double-reserves.
 *
 * Residual, disclosed limitation: `futuresAvailableUsd` is a snapshot read
 * from the exchange moments before this call — a real balance change
 * between that read and this transaction (e.g. an order placed by some
 * other, non-HedgeOS process on the same account) is not, and cannot be,
 * covered by a purely local lock. What this DOES fully close is HedgeOS's
 * own concurrent strategies/processes racing each other locally.
 */
export function reserveFundingAtomically(
  db: Database.Database,
  args: { strategyId: number; cycleId: number; amountUsd: number; futuresAvailableUsd: number; reservedByOthersUsd: number },
): { reserved: boolean; reservation?: FundingReservation; reason?: string } {
  const tx = db.transaction(() => {
    const existing = db
      .prepare("SELECT * FROM funding_reservations WHERE strategy_id = ? AND cycle_id = ?")
      .get(args.strategyId, args.cycleId) as FundingReservation | undefined;
    if (existing) {
      return { reserved: existing.status !== "released", reservation: existing, reason: `reservation already exists for this cycle (status=${existing.status})` };
    }

    // Re-read what's pending from OTHER strategies INSIDE the lock — the value passed in by the
    // caller was read just before acquiring it and could already be stale relative to a
    // reservation another process committed in between; this final check is the one that's
    // actually race-free.
    const freshPendingRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM funding_reservations
         WHERE strategy_id != ? AND status = 'pending' AND created_at >= datetime('now', ?)`,
      )
      .get(args.strategyId, `-${FUNDING_RESERVATION_STALE_AFTER_MINUTES} minutes`) as { total: number };

    const unreserved = args.futuresAvailableUsd - args.reservedByOthersUsd - freshPendingRow.total;
    if (unreserved < args.amountUsd - 0.005) {
      return { reserved: false, reason: `insufficient unreserved balance at reservation time: available=${args.futuresAvailableUsd}, reservedByOthers=${args.reservedByOthersUsd}, pendingByOthers=${freshPendingRow.total}, requested=${args.amountUsd}` };
    }

    const info = db
      .prepare("INSERT INTO funding_reservations (strategy_id, cycle_id, amount_usd, status) VALUES (?, ?, ?, 'pending')")
      .run(args.strategyId, args.cycleId, args.amountUsd);
    const reservation = db.prepare("SELECT * FROM funding_reservations WHERE id = ?").get(info.lastInsertRowid) as FundingReservation;
    return { reserved: true, reservation };
  });
  return tx.immediate();
}

/** Marks a reservation resolved — 'confirmed' once the transfer is verified credited, 'released' if it never happened (deferred, insufficient, gate closed, or the transfer itself failed). Never left 'pending' forever by any code path that reaches a final outcome. */
export function resolveFundingReservation(db: Database.Database, reservationId: number, outcome: "confirmed" | "released"): void {
  db.prepare("UPDATE funding_reservations SET status = ?, resolved_at = datetime('now') WHERE id = ?").run(outcome, reservationId);
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
  /** Whole minutes or null. Null (the default) means "use the daily/weekly/monthly frequency column." Non-null overrides it — generic cadence, e.g. 10 for "every 10 minutes." */
  interval_minutes: number | null;
  funding_mode: "prefunded" | "auto";
  funding_buffer_usd: number;
  funding_per_cycle_cap_usd: number;
  funding_period_cap_usd: number | null;
  /** 'paper' (default) or 'live'. See the schema's own doc comment — this, not HEDGEOS_MODE, is what the passive worker checks per-strategy before auto-processing a due cycle. */
  mode: "paper" | "live";
  /** Total lifetime capital cap for a 'live' strategy. Required (and enforced by createStrategy) when mode='live'; null for paper. */
  capital_limit_usd: number | null;
  /** NULL = draft/unauthorized (worker will never auto-execute). Set by authorize_live_strategy. */
  live_authorized_at: string | null;
}

/** Sums the real USDT actually committed by a live strategy's completed/partial executions — stock notional actually filled plus hedge collateral actually posted. This, not the requested/budgeted amounts, is what's compared against capital_limit_usd before another cycle may run. */
export function getLiveCapitalSpentUsd(db: Database.Database, strategyId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(stock_filled_notional_usd), 0) + COALESCE(SUM(CASE WHEN hedge_order_status IN ('filled','partially_filled') THEN hedge_actual_collateral_usd ELSE 0 END), 0) AS spent
       FROM executions WHERE strategy_id = ? AND mode = 'live'`,
    )
    .get(strategyId) as { spent: number };
  return Math.round(row.spent * 100) / 100;
}

/** The explicit, separate second step that turns a draft live strategy into one the worker may actually execute. Re-confirms (does not change) capitalLimitUsd/endAt so the caller can verify they're authorizing what they think they're authorizing. */
export function authorizeLiveStrategy(db: Database.Database, strategyId: number): StrategyRow | undefined {
  const strategy = getStrategy(db, strategyId);
  if (!strategy) return undefined;
  if (strategy.mode !== "live") throw new Error(`strategy ${strategyId} is mode='${strategy.mode}', not 'live' — only live strategies can be authorized`);
  if (strategy.live_authorized_at) throw new Error(`strategy ${strategyId} is already authorized (at ${strategy.live_authorized_at}) — re-authorization is not needed; pause/resume or create a new strategy for a new authorization`);
  db.prepare("UPDATE strategies SET live_authorized_at = datetime('now') WHERE id = ?").run(strategyId);
  return getStrategy(db, strategyId);
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
    /** Optional whole-minute cadence override (e.g. 10 for "every 10 minutes"). Omitted/undefined = use `frequency`'s daily/weekly/monthly calendar cadence (unchanged default behavior). Must be >= MIN_INTERVAL_MINUTES. */
    intervalMinutes?: number;
    /** Funding policy for the hedge leg's collateral. Omitted = 'prefunded' (default, unchanged prior behavior — user tops up Futures themselves). 'auto' additionally requires the separate runtime `assertAutoFundingGate` env-var gate to actually transfer real funds; setting this alone never does. */
    fundingMode?: "prefunded" | "auto";
    /** Extra USDT transferred beyond the bare collateral requirement (price-drift/fee buffer). Only meaningful when fundingMode='auto'. Default 0. */
    fundingBufferUsd?: number;
    /** Hard per-cycle transfer ceiling. Only meaningful when fundingMode='auto'. Default 0 (i.e. 'auto' with no cap configured transfers nothing — must be set explicitly to enable real transfers). */
    fundingPerCycleCapUsd?: number;
    /** Optional rolling-period (e.g. daily) transfer ceiling, independent of the per-cycle cap. */
    fundingPeriodCapUsd?: number;
    /** 'paper' (default, unchanged prior behavior) or 'live'. A 'live' strategy's due cycles are created on schedule but never auto-processed by the passive worker — only an explicit trigger_live_cycle call, itself gated by assertLiveTradingGate, can execute one. */
    mode?: "paper" | "live";
    /** Required, positive, when mode='live' — the strategy's total lifetime spending cap, independent of and in addition to the per-cycle contribution and funding caps. Refusing to create an unbounded live strategy. */
    capitalLimitUsd?: number;
  },
): StrategyRow {
  const hedgeLeverage = args.hedgeLeverage ?? DEFAULT_HEDGE_LEVERAGE;
  assertValidHedgeLeverage(hedgeLeverage);
  if (args.endAt !== undefined && Number.isNaN(new Date(args.endAt).getTime())) {
    throw new Error(`endAt "${args.endAt}" is not a valid ISO timestamp`);
  }
  if (args.intervalMinutes !== undefined) {
    assertValidIntervalMinutes(args.intervalMinutes);
  }
  const fundingMode = args.fundingMode ?? "prefunded";
  if (fundingMode === "auto" && (args.fundingPerCycleCapUsd === undefined || args.fundingPerCycleCapUsd <= 0)) {
    throw new Error(`fundingMode="auto" requires an explicit, positive fundingPerCycleCapUsd — refusing to enable automatic transfers with no configured limit.`);
  }
  const mode = args.mode ?? "paper";
  if (mode === "live") {
    if (args.capitalLimitUsd === undefined || args.capitalLimitUsd <= 0) {
      throw new Error(`mode="live" requires an explicit, positive capitalLimitUsd — refusing to create an unbounded live strategy.`);
    }
    if (args.endAt === undefined) {
      throw new Error(`mode="live" requires an explicit endAt (finite duration) — refusing to create an unattended, indefinitely-recurring live strategy. Pass an end date, or plan to pause it yourself.`);
    }
  }

  const stmt = db.prepare(
    `INSERT INTO strategies (ticker, spot_symbol, futures_symbol, contribution_usd, frequency, hedge_leverage, next_due_at, end_at, interval_minutes, funding_mode, funding_buffer_usd, funding_per_cycle_cap_usd, funding_period_cap_usd, mode, capital_limit_usd)
     VALUES (@ticker, @spotSymbol, @futuresSymbol, @contributionUsd, @frequency, @hedgeLeverage, COALESCE(@firstDueAt, datetime('now')), @endAt, @intervalMinutes, @fundingMode, @fundingBufferUsd, @fundingPerCycleCapUsd, @fundingPeriodCapUsd, @mode, @capitalLimitUsd)`,
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
    intervalMinutes: args.intervalMinutes ?? null,
    fundingMode,
    fundingBufferUsd: args.fundingBufferUsd ?? 0,
    fundingPerCycleCapUsd: args.fundingPerCycleCapUsd ?? 0,
    fundingPeriodCapUsd: args.fundingPeriodCapUsd ?? null,
    mode,
    capitalLimitUsd: args.capitalLimitUsd ?? null,
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
/**
 * How much of the account's Futures wallet is already spoken for by OTHER
 * strategies sharing it — real collateral currently held in an open
 * position (or partially filled), not a caller-supplied guess. Used by
 * `planFunding` (via `LiveExecutionAdapter.prepareFunding`) so one
 * strategy's funding decision can never double-count collateral another
 * strategy is already relying on.
 *
 * Deliberately includes PAUSED strategies too — pausing stops new cycles
 * from being scheduled, it does not release an already-open position's
 * collateral back to the wallet. Only strategy_id itself is excluded (a
 * strategy never "reserves against" its own prior collateral — that's
 * already reflected in the real account balance `prepareFunding` reads
 * fresh from the exchange).
 *
 * Known, disclosed limitation: this reflects durable, already-persisted
 * executions only. A transfer or order for ANOTHER strategy that is
 * in-flight in the same instant (already sent to the exchange, not yet
 * reconciled/persisted) is not reflected here — a narrow race window, not
 * eliminated by this fix. Recomputed fresh on every call (never cached),
 * so it is at most one concurrent-cycle-width stale, never structurally
 * wrong the way a caller-supplied constant could be.
 */
export function getReservedFuturesUsd(db: Database.Database, excludeStrategyId: number): number {
  const confirmedRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN hedge_order_status IN ('filled','partially_filled') THEN hedge_actual_collateral_usd ELSE 0 END), 0) AS reserved
       FROM executions WHERE strategy_id != ? AND mode = 'live'`,
    )
    .get(excludeStrategyId) as { reserved: number };
  // Also count OTHER strategies' still-pending (not yet transferred/confirmed) reservations —
  // this is what makes the figure fed into planFunding consistent with what
  // reserveFundingAtomically will itself re-check inside its own lock; without this, a strategy
  // could see "sufficient" here and only discover the real conflict at reservation time (still
  // safe — reserveFundingAtomically is the actual source of truth — but this keeps the two checks
  // in agreement rather than routinely disagreeing).
  const pendingRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS pending FROM funding_reservations
       WHERE strategy_id != ? AND status = 'pending' AND created_at >= datetime('now', ?)`,
    )
    .get(excludeStrategyId, `-${FUNDING_RESERVATION_STALE_AFTER_MINUTES} minutes`) as { pending: number };
  return Math.round((confirmedRow.reserved + pendingRow.pending) * 100) / 100;
}

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
