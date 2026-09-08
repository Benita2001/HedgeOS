import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

vi.mock("../src/binance/client.js", () => ({
  discoverPair: vi.fn(),
}));

import { discoverPair } from "../src/binance/client.js";
import { createStrategy, getStrategy } from "../src/db/index.js";
import { PaperExecutionAdapter } from "../src/binance/execution.js";
import {
  ensureDueCycles,
  claimCycle,
  processCycle,
  reconcileInProgressCycles,
  getPendingAndRetryableCycles,
  classifyError,
  MAX_CATCHUP_CYCLES,
  type CycleRow,
} from "../src/scheduler/cycles.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  const schema = readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}

const SUPPORTED_DISCOVERY = {
  ticker: "NVDA",
  spotSymbol: "NVDABUSDT",
  futuresSymbol: "NVDAUSDT",
  spot: { tradable: true, filters: { stepSize: 0.001, minQty: 0.001, minNotional: 5 }, price: 233 },
  futures: {
    tradable: true,
    filters: { stepSize: 0.01, minQty: 0.01, minNotional: 5 },
    contractType: "TRADIFI_PERPETUAL",
    markPrice: 233.2,
  },
  usableForProtectedDca: true,
};

const UNSUPPORTED_DISCOVERY = {
  ticker: "ZZZZ",
  spotSymbol: "ZZZZBUSDT",
  futuresSymbol: "ZZZZUSDT",
  spot: { tradable: false, reason: "no spot bStock symbol" },
  futures: { tradable: false, reason: "no TRADIFI_PERPETUAL future" },
  usableForProtectedDca: false,
};

let db: Database.Database;

beforeEach(() => {
  db = freshDb();
  vi.mocked(discoverPair).mockReset();
});
afterEach(() => db.close());

function makeStrategy(overrides: Partial<Parameters<typeof createStrategy>[1]> = {}) {
  return createStrategy(db, {
    ticker: "NVDA",
    spotSymbol: "NVDABUSDT",
    futuresSymbol: "NVDAUSDT",
    contributionUsd: 100,
    frequency: "daily",
    hedgeLeverage: 2,
    firstDueAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("ensureDueCycles — idempotent due-slot creation", () => {
  it("creates exactly one cycle for a strategy that is due now, even if called twice (duplicate tick)", () => {
    const strategy = makeStrategy();
    const now = new Date(strategy.next_due_at);

    const firstTick = ensureDueCycles(db, strategy, now);
    const strategyAfter = getStrategy(db, strategy.id)!;
    const secondTick = ensureDueCycles(db, strategyAfter, now); // simulates an overlapping/duplicate tick

    expect(firstTick.length).toBe(1);
    expect(secondTick.length).toBe(0); // nothing new — already exists for that slot

    const cycles = db.prepare("SELECT * FROM cycles WHERE strategy_id = ?").all(strategy.id) as CycleRow[];
    expect(cycles.length).toBe(1);
  });

  it("caps catch-up for a badly missed schedule instead of creating unbounded backlog", () => {
    const farPast = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days ago, daily cadence
    const strategy = makeStrategy({ frequency: "daily", firstDueAt: farPast });

    const created = ensureDueCycles(db, strategy, new Date());
    expect(created.length).toBe(MAX_CATCHUP_CYCLES);

    const strategyAfter = getStrategy(db, strategy.id)!;
    // next_due_at advanced past the created slots but the schedule is still catching up (not yet at "now")
    expect(new Date(strategyAfter.next_due_at).getTime()).toBeGreaterThan(new Date(farPast).getTime());
  });
});

describe("claimCycle — restart / concurrency safety", () => {
  it("only one of two concurrent claim attempts on the same cycle succeeds", () => {
    const strategy = makeStrategy();
    ensureDueCycles(db, strategy, new Date(strategy.next_due_at));
    const [cycle] = db.prepare("SELECT * FROM cycles WHERE strategy_id = ?").all(strategy.id) as CycleRow[];

    const claim1 = claimCycle(db, cycle.id);
    const claim2 = claimCycle(db, cycle.id); // simulates a second tick racing on the same row

    expect(claim1).not.toBeNull();
    expect(claim2).toBeNull();
  });
});

describe("processCycle — success and failure classification", () => {
  it("marks a cycle completed on a successful paper execution", async () => {
    vi.mocked(discoverPair).mockResolvedValue(SUPPORTED_DISCOVERY as never);
    const strategy = makeStrategy();
    ensureDueCycles(db, strategy, new Date(strategy.next_due_at));
    const [cycle] = db.prepare("SELECT * FROM cycles WHERE strategy_id = ?").all(strategy.id) as CycleRow[];
    const claimed = claimCycle(db, cycle.id)!;

    const receipt = await processCycle(db, claimed, strategy, new PaperExecutionAdapter());
    expect(receipt.status).toBe("completed");

    const row = db.prepare("SELECT * FROM cycles WHERE id = ?").get(cycle.id) as CycleRow;
    expect(row.status).toBe("completed");
    expect(row.execution_id).toBe(Number(receipt.executionId));
  });

  it("marks a cycle failed_terminal (not retryable) for an unsupported instrument", async () => {
    vi.mocked(discoverPair).mockResolvedValue(UNSUPPORTED_DISCOVERY as never);
    const strategy = makeStrategy({ ticker: "ZZZZ", spotSymbol: "ZZZZBUSDT", futuresSymbol: "ZZZZUSDT" });
    ensureDueCycles(db, strategy, new Date(strategy.next_due_at));
    const [cycle] = db.prepare("SELECT * FROM cycles WHERE strategy_id = ?").all(strategy.id) as CycleRow[];
    const claimed = claimCycle(db, cycle.id)!;

    const receipt = await processCycle(db, claimed, strategy, new PaperExecutionAdapter());
    expect(receipt.status).toBe("unsupported_pair");

    const row = db.prepare("SELECT * FROM cycles WHERE id = ?").get(cycle.id) as CycleRow;
    expect(row.status).toBe("failed_terminal");
    // Terminal cycles are not returned by getPendingAndRetryableCycles — no retry loop.
    expect(getPendingAndRetryableCycles(db).some((c) => c.id === cycle.id)).toBe(false);
  });

  it("marks a cycle failed_retryable on a transient (network-shaped) error, and it remains claimable", async () => {
    vi.mocked(discoverPair).mockRejectedValue(new Error("fetch failed: ETIMEDOUT contacting Binance API"));
    const strategy = makeStrategy();
    ensureDueCycles(db, strategy, new Date(strategy.next_due_at));
    const [cycle] = db.prepare("SELECT * FROM cycles WHERE strategy_id = ?").all(strategy.id) as CycleRow[];
    const claimed = claimCycle(db, cycle.id)!;

    await expect(processCycle(db, claimed, strategy, new PaperExecutionAdapter())).rejects.toThrow();

    const row = db.prepare("SELECT * FROM cycles WHERE id = ?").get(cycle.id) as CycleRow;
    expect(row.status).toBe("failed_retryable");
    expect(getPendingAndRetryableCycles(db).some((c) => c.id === cycle.id)).toBe(true);

    // A subsequent tick can claim and retry it.
    const secondClaim = claimCycle(db, cycle.id);
    expect(secondClaim).not.toBeNull();
    expect(secondClaim!.attempt_count).toBe(2);
  });

  it("classifyError treats network-shaped messages as retryable and everything else as terminal", () => {
    expect(classifyError(new Error("fetch failed"))).toBe("retryable");
    expect(classifyError(new Error("Binance API error 503 for ..."))).toBe("retryable");
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("retryable");
    expect(classifyError(new Error("Unsupported hedge leverage 5x"))).toBe("terminal");
    expect(classifyError(new Error("AllocationPolicy fractions must sum to 1"))).toBe("terminal");
  });
});

describe("reconcileInProgressCycles — restart recovery, never a blind replay", () => {
  it("resolves an in_progress cycle with a matching execution as completed, without re-executing", () => {
    const strategy = makeStrategy();
    ensureDueCycles(db, strategy, new Date(strategy.next_due_at));
    const [cycle] = db.prepare("SELECT * FROM cycles WHERE strategy_id = ?").all(strategy.id) as CycleRow[];
    claimCycle(db, cycle.id); // -> in_progress, started_at = now

    // Simulate: runContribution actually completed and wrote an execution row,
    // but the process crashed before processCycle could mark the cycle completed.
    const execInfo = db
      .prepare(
        `INSERT INTO executions (
           strategy_id, mode, status, contribution_usd, reference_price,
           stock_budget_usd, stock_qty, stock_notional_usd, stock_fee_usd, stock_executable,
           hedge_budget_usd, hedge_leverage, hedge_target_short_notional_usd, hedge_qty,
           hedge_actual_short_notional_usd, hedge_actual_collateral_usd, hedge_fee_usd, hedge_executable
         ) VALUES (?, 'paper', 'completed', 100, 233, 90, 0.386, 89.94, 0.09, 1, 10, 2, 20, 0.08, 18.64, 9.32, 0.01, 1)`,
      )
      .run(strategy.id);

    const resolved = reconcileInProgressCycles(db);
    expect(resolved.length).toBe(1);
    expect(resolved[0].status).toBe("completed");
    expect(resolved[0].execution_id).toBe(Number(execInfo.lastInsertRowid));

    // Not claimable again — it's terminal-completed, not sitting in the retry queue.
    expect(getPendingAndRetryableCycles(db).some((c) => c.id === cycle.id)).toBe(false);
  });

  it("resolves an in_progress cycle with NO matching execution as failed_retryable, never as completed", () => {
    const strategy = makeStrategy();
    ensureDueCycles(db, strategy, new Date(strategy.next_due_at));
    const [cycle] = db.prepare("SELECT * FROM cycles WHERE strategy_id = ?").all(strategy.id) as CycleRow[];
    claimCycle(db, cycle.id); // -> in_progress; process "crashes" before runContribution wrote anything

    const resolved = reconcileInProgressCycles(db);
    expect(resolved.length).toBe(1);
    expect(resolved[0].status).toBe("failed_retryable");
    expect(resolved[0].execution_id).toBeNull();

    // Safe to retry now.
    expect(getPendingAndRetryableCycles(db).some((c) => c.id === cycle.id)).toBe(true);
  });
});

describe("deferred hedge budget carry-forward across scheduled cycles", () => {
  it("accumulates deferred hedge budget across two consecutive scheduled cycles that each fall under the exchange minimum", async () => {
    vi.mocked(discoverPair).mockResolvedValue(SUPPORTED_DISCOVERY as never);
    // $10 contribution -> $1 hedge budget -> even at 3x, $3 target, well under $5 minNotional at $233/share.
    const strategy = makeStrategy({ contributionUsd: 10, hedgeLeverage: 3, frequency: "daily" });

    for (let i = 0; i < 2; i++) {
      const current = getStrategy(db, strategy.id)!;
      ensureDueCycles(db, current, new Date(current.next_due_at));
      const cycle = db
        .prepare("SELECT * FROM cycles WHERE strategy_id = ? AND status = 'pending'")
        .get(strategy.id) as CycleRow;
      const claimed = claimCycle(db, cycle.id)!;
      await processCycle(db, claimed, current, new PaperExecutionAdapter());
    }

    const finalStrategy = getStrategy(db, strategy.id)!;
    expect(finalStrategy.deferred_hedge_budget_usd).toBeCloseTo(2, 6); // $1 deferred x 2 cycles
  });
});
