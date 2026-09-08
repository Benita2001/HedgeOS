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
  deferred_hedge_budget_usd REAL NOT NULL DEFAULT 0
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

  skip_reason TEXT
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
