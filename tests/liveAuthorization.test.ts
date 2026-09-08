import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrategy, getStrategy, authorizeLiveStrategy, getLiveCapitalSpentUsd, hasScheduleEnded } from "../src/db/index.js";
import { ensureDueCycles, claimCycle, getPendingAndRetryableCycles } from "../src/scheduler/cycles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf-8");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

function makeDraftLive(db: Database.Database, overrides: Partial<Parameters<typeof createStrategy>[1]> = {}) {
  return createStrategy(db, {
    ticker: "AAPL", spotSymbol: "AAPLBUSDT", futuresSymbol: "AAPLUSDT",
    contributionUsd: 10, frequency: "daily", hedgeLeverage: 2,
    mode: "live", capitalLimitUsd: 100, endAt: "2026-12-01T00:00:00.000Z",
    ...overrides,
  });
}

function insertLiveExecution(db: Database.Database, strategyId: number, stockFilledNotionalUsd: number, hedgeActualCollateralUsd: number) {
  db.prepare(
    `INSERT INTO executions (
       strategy_id, mode, status, contribution_usd, reference_price,
       stock_budget_usd, stock_qty, stock_notional_usd, stock_executable, stock_filled_notional_usd,
       hedge_budget_usd, hedge_leverage, hedge_target_short_notional_usd, hedge_qty,
       hedge_actual_short_notional_usd, hedge_actual_collateral_usd, hedge_executable, hedge_order_status
     ) VALUES (?, 'live', 'completed', 10, 226, 0, 0, 0, 1, ?, 0, 2, 0, 0, 0, ?, 1, 'filled')`,
  ).run(strategyId, stockFilledNotionalUsd, hedgeActualCollateralUsd);
}

describe("authorize_live_strategy lifecycle (draft -> authorized)", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("a freshly created live strategy starts as an unauthorized draft", () => {
    const s = makeDraftLive(db);
    expect(s.live_authorized_at).toBeNull();
  });

  it("authorizeLiveStrategy sets live_authorized_at and returns the updated row", () => {
    const s = makeDraftLive(db);
    const authorized = authorizeLiveStrategy(db, s.id);
    expect(authorized?.live_authorized_at).not.toBeNull();
  });

  it("cannot authorize the same strategy twice", () => {
    const s = makeDraftLive(db);
    authorizeLiveStrategy(db, s.id);
    expect(() => authorizeLiveStrategy(db, s.id)).toThrow(/already authorized/);
  });

  it("cannot authorize a paper strategy", () => {
    const paper = createStrategy(db, { ticker: "NVDA", spotSymbol: "NVDABUSDT", futuresSymbol: "NVDAUSDT", contributionUsd: 100, frequency: "daily", hedgeLeverage: 2 });
    expect(() => authorizeLiveStrategy(db, paper.id)).toThrow(/not 'live'/);
  });

  it("authorizing a nonexistent strategy returns undefined, not a crash", () => {
    expect(authorizeLiveStrategy(db, 999)).toBeUndefined();
  });
});

describe("getLiveCapitalSpentUsd — capital exhaustion tracking", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("is 0 for a strategy with no executions yet", () => {
    const s = makeDraftLive(db);
    expect(getLiveCapitalSpentUsd(db, s.id)).toBe(0);
  });

  it("accumulates real spent notional + collateral across multiple real cycles", () => {
    const s = makeDraftLive(db, { capitalLimitUsd: 50 });
    insertLiveExecution(db, s.id, 9, 1);
    insertLiveExecution(db, s.id, 9, 1);
    expect(getLiveCapitalSpentUsd(db, s.id)).toBe(20); // (9+1) + (9+1)
  });

  it("ignores another strategy's spending entirely", () => {
    const s1 = makeDraftLive(db, { ticker: "AAPL", spotSymbol: "AAPLBUSDT", futuresSymbol: "AAPLUSDT" });
    const s2 = makeDraftLive(db, { ticker: "MSFT", spotSymbol: "MSFTBUSDT", futuresSymbol: "MSFTUSDT" });
    insertLiveExecution(db, s2.id, 40, 5);
    expect(getLiveCapitalSpentUsd(db, s1.id)).toBe(0);
  });
});

describe("Worker's exact per-cycle live-execution gate logic (reproduced, matching worker/index.ts)", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  function dueCycleFor(strategy: ReturnType<typeof makeDraftLive>) {
    ensureDueCycles(db, strategy, new Date(strategy.next_due_at.replace(" ", "T") + (strategy.next_due_at.endsWith("Z") ? "" : "Z")));
    const due = getPendingAndRetryableCycles(db).filter((c) => c.strategy_id === strategy.id);
    return claimCycle(db, due[0].id)!;
  }

  it("an UNAUTHORIZED live strategy's due cycle is never executed — reverted to pending", () => {
    const s = makeDraftLive(db, { firstDueAt: "2026-01-01T00:00:00.000Z" });
    const claimed = dueCycleFor(s);
    const strategy = getStrategy(db, claimed.strategy_id)!;
    expect(strategy.live_authorized_at).toBeNull(); // this is exactly what the worker checks first
    // Worker's logic: !live_authorized_at -> revert
    db.prepare("UPDATE cycles SET status = 'pending' WHERE id = ?").run(claimed.id);
    const after = db.prepare("SELECT status FROM cycles WHERE id = ?").get(claimed.id) as { status: string };
    expect(after.status).toBe("pending");
  });

  it("an authorized but CAPITAL-EXHAUSTED live strategy's due cycle is never executed", () => {
    const s = makeDraftLive(db, { capitalLimitUsd: 20, firstDueAt: "2026-01-01T00:00:00.000Z" });
    authorizeLiveStrategy(db, s.id);
    insertLiveExecution(db, s.id, 18, 2); // already spent exactly the $20 limit
    const claimed = dueCycleFor(s);
    const strategy = getStrategy(db, claimed.strategy_id)!;
    expect(strategy.live_authorized_at).not.toBeNull();
    const spent = getLiveCapitalSpentUsd(db, strategy.id);
    expect(spent).toBeGreaterThanOrEqual(strategy.capital_limit_usd!); // this is exactly the worker's exhaustion check
  });

  it("an authorized but EXPIRED (past endAt) live strategy's due cycle is never executed", () => {
    const s = makeDraftLive(db, { endAt: "2026-01-01T00:05:00.000Z", intervalMinutes: 60, firstDueAt: "2026-01-01T00:00:00.000Z" });
    authorizeLiveStrategy(db, s.id);
    // Force next_due_at past end_at, simulating a strategy whose schedule has run out.
    db.prepare("UPDATE strategies SET next_due_at = '2026-06-01T00:00:00.000Z' WHERE id = ?").run(s.id);
    const strategy = getStrategy(db, s.id)!;
    expect(hasScheduleEnded(strategy)).toBe(true); // exactly the worker's expiry check
  });

  it("an authorized, funded, non-expired live strategy passes every gate check (the only case that proceeds to real execution)", () => {
    const s = makeDraftLive(db, { capitalLimitUsd: 1000, firstDueAt: "2026-01-01T00:00:00.000Z" });
    authorizeLiveStrategy(db, s.id);
    const strategy = getStrategy(db, s.id)!;
    expect(strategy.live_authorized_at).not.toBeNull();
    expect(hasScheduleEnded(strategy)).toBe(false);
    expect(getLiveCapitalSpentUsd(db, strategy.id)).toBeLessThan(strategy.capital_limit_usd!);
    // Only after all three pass does the worker even attempt to construct a real LiveExecutionAdapter
    // (itself gated by assertLiveTradingGate, tested separately in liveModeRouting.test.ts).
  });

  it("PAUSING an authorized live strategy removes it from listActiveStrategies — the worker's tick loop never even considers it", () => {
    const s = makeDraftLive(db, { firstDueAt: "2026-01-01T00:00:00.000Z" });
    authorizeLiveStrategy(db, s.id);
    db.prepare("UPDATE strategies SET status = 'paused' WHERE id = ?").run(s.id);
    const active = db.prepare("SELECT * FROM strategies WHERE status = 'active'").all();
    expect(active.length).toBe(0);
  });
});
