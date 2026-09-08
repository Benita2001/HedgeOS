CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  spot_symbol TEXT NOT NULL,
  futures_symbol TEXT NOT NULL,
  contribution_usd REAL NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  hedge_leverage REAL NOT NULL DEFAULT 2 CHECK (hedge_leverage IN (2, 3)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  next_due_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deferred_hedge_budget_usd REAL NOT NULL DEFAULT 0,
  -- Optional generic cadence override, in whole minutes (e.g. 10 for "every 10 minutes").
  -- When set, cadence math (addCadence) uses this instead of the `frequency` column, which
  -- stays required for backward compatibility / display purposes only in that case. NULL (the
  -- default, and every pre-existing strategy's value) means "use the daily/weekly/monthly
  -- calendar cadence" — unchanged behavior. See src/scheduler/cadence.ts for the documented
  -- minimum (tied to the worker's own tick granularity, not any specific demo number).
  interval_minutes INTEGER DEFAULT NULL,
  -- Per-strategy funding policy for the hedge leg's Futures collateral. 'prefunded' (the
  -- default — identical to every strategy's behavior before this column existed) means the
  -- user tops up the Futures wallet themselves; HedgeOS only ever reports a shortfall. 'auto'
  -- additionally requires the separate assertAutoFundingGate env-var gate to actually transfer —
  -- setting funding_mode='auto' here does NOT by itself authorize a real transfer.
  funding_mode TEXT NOT NULL DEFAULT 'prefunded' CHECK (funding_mode IN ('prefunded', 'auto')),
  -- Below are only meaningful when funding_mode='auto'; NULL/0 in 'prefunded' mode (unused).
  funding_buffer_usd REAL NOT NULL DEFAULT 0,
  funding_per_cycle_cap_usd REAL NOT NULL DEFAULT 0,
  funding_period_cap_usd REAL DEFAULT NULL,
  -- Per-strategy execution mode — 'paper' (default, identical to every prior strategy's
  -- behavior) or 'live'. This is what the passive worker tick loop checks to decide
  -- whether to auto-process a due cycle at all: a 'live' strategy's due cycles are
  -- created on schedule but NEVER auto-claimed/executed by the worker — only an explicit,
  -- separately-gated operator action (trigger_live_cycle) can process one. This is
  -- deliberately independent of HEDGEOS_MODE (the process-wide env var, still checked by
  -- assertLiveTradingGate) — both a strategy marked 'live' AND the full live-trading gate
  -- must agree before any real order is placed.
  mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
  -- Total lifetime capital cap for a 'live' strategy (distinct from per-cycle contribution_usd) —
  -- required and enforced only when mode='live'; NULL for paper strategies.
  capital_limit_usd REAL DEFAULT NULL,
  -- NULL = draft (created but not authorized — the worker will never auto-execute it,
  -- regardless of status/mode). Set (an ISO timestamp) by the SEPARATE authorize_live_strategy
  -- MCP call = authorized. This is what turns "a live strategy exists" into "the worker may
  -- actually place real orders for it" — deliberately a second, explicit step from creation,
  -- never implied by create_live_strategy alone. Irrelevant for mode='paper' (always NULL).
  live_authorized_at TEXT DEFAULT NULL,
  -- Optional ISO timestamp: the scheduler creates no new cycle whose scheduled_for is after this
  -- (a cycle scheduled exactly at end_at is still created — inclusive boundary). NULL (the default,
  -- and the only value every strategy created before this column existed has) means "runs
  -- indefinitely" — the exact prior behavior, unchanged. Ending a schedule never touches positions,
  -- executions, or receipts; it only stops new cycles from being created.
  end_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id),
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'unsupported_pair', 'partial_failure', 'failed')),
  contribution_usd REAL NOT NULL,
  reference_price REAL NOT NULL,

  -- stock leg: "qty"/"notional" are the sizing engine's REQUESTED amount (post-filter-rounding);
  -- "filled_qty"/"filled_notional" are what the execution adapter actually reports as filled —
  -- these can differ (partial fill) and paper-state accounting always uses the filled values.
  stock_budget_usd REAL NOT NULL,
  stock_qty REAL NOT NULL,
  stock_notional_usd REAL NOT NULL,
  stock_filled_qty REAL NOT NULL DEFAULT 0,
  stock_filled_notional_usd REAL NOT NULL DEFAULT 0,
  stock_order_status TEXT NOT NULL DEFAULT 'not_submitted' CHECK (stock_order_status IN ('not_submitted', 'filled', 'partially_filled', 'rejected')),
  stock_fee_usd REAL NOT NULL DEFAULT 0,
  stock_executable INTEGER NOT NULL,
  stock_skip_reason TEXT,

  -- hedge leg: budget/collateral, notional, and leverage tracked as distinct values, never conflated
  hedge_budget_usd REAL NOT NULL,
  hedge_leverage REAL NOT NULL,
  hedge_target_short_notional_usd REAL NOT NULL,
  hedge_qty REAL NOT NULL,
  hedge_actual_short_notional_usd REAL NOT NULL,
  hedge_filled_qty REAL NOT NULL DEFAULT 0,
  hedge_filled_notional_usd REAL NOT NULL DEFAULT 0,
  hedge_order_status TEXT NOT NULL DEFAULT 'not_submitted' CHECK (hedge_order_status IN ('not_submitted', 'filled', 'partially_filled', 'rejected')),
  hedge_actual_collateral_usd REAL NOT NULL,
  hedge_fee_usd REAL NOT NULL DEFAULT 0,
  hedge_executable INTEGER NOT NULL,
  hedge_skip_reason TEXT,
  hedge_deferred_budget_usd REAL NOT NULL DEFAULT 0,

  -- paper-only accounting; NOT populated/authoritative for live mode in P0
  unrealized_pnl_usd REAL NOT NULL DEFAULT 0,
  strategy_nav_usd REAL,

  skip_reason TEXT,

  -- Automatic-funding step outcome for this cycle, as JSON (FundingStepResult — plan + transfer
  -- receipt, or null if no funding step ran, e.g. paper mode or the hedge leg was deferred).
  -- NULL for every execution before this column existed and for every paper-mode execution.
  funding_step_json TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL REFERENCES executions(id),
  leg TEXT NOT NULL CHECK (leg IN ('stock', 'hedge')),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  notional_usd REAL NOT NULL,
  fee_usd REAL NOT NULL DEFAULT 0,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  order_id TEXT,
  status TEXT NOT NULL DEFAULT 'filled' CHECK (status IN ('filled', 'partially_filled', 'rejected')),
  reason TEXT,
  simulated INTEGER NOT NULL DEFAULT 1,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per due contribution slot for a strategy. This is the
-- idempotency boundary: (strategy_id, scheduled_for) — and therefore
-- idempotency_key — can exist at most once, so a repeated scheduler tick,
-- a process restart, or a retried claim can never create a second row for
-- the same due slot. status is a state machine:
--   pending -> in_progress -> completed
--                          -> failed_terminal   (won't succeed by retrying)
--                          -> failed_retryable  (safe to claim again later)
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id),
  scheduled_for TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed_retryable', 'failed_terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  execution_id INTEGER REFERENCES executions(id),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cycles_strategy_status ON cycles(strategy_id, status);

-- A durable, atomically-claimed reservation against the shared Futures wallet, created
-- BEFORE a transfer is attempted (not just inferred afterward from a filled execution).
-- UNIQUE(strategy_id, cycle_id) makes reserving for the same due cycle twice a no-op —
-- the same idempotency guarantee `cycles.idempotency_key` gives the cycle-claim path.
-- 'pending' = reserved, transfer not yet confirmed; 'confirmed' = the transfer completed
-- (the real execution row is now the durable record; kept for audit); 'released' = the
-- funding step did not end up transferring (deferred/insufficient/gate closed) — the
-- amount is no longer spoken for.
CREATE TABLE IF NOT EXISTS funding_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id),
  cycle_id INTEGER NOT NULL REFERENCES cycles(id),
  amount_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'released')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE (strategy_id, cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_funding_reservations_status ON funding_reservations(status);
