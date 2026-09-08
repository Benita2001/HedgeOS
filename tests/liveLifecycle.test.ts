import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf-8");

vi.mock("../src/binance/client.js", () => ({ discoverPair: vi.fn() }));
import { discoverPair } from "../src/binance/client.js";
import { createStrategy, getPaperState } from "../src/db/index.js";
import { ensureDueCycles, claimCycle, processCycle, getPendingAndRetryableCycles } from "../src/scheduler/cycles.js";
import type { ExecutionAdapter, Fill } from "../src/binance/execution.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

const DISCOVERY = {
  ticker: "NVDA",
  spotSymbol: "NVDABUSDT",
  futuresSymbol: "NVDAUSDT",
  spot: { tradable: true, filters: { stepSize: 0.001, minQty: 0.001, minNotional: 5 }, price: 226.16 },
  futures: { tradable: true, filters: { stepSize: 0.01, minQty: 0.01, minNotional: 5 }, contractType: "TRADIFI_PERPETUAL", markPrice: 226.2 },
  usableForProtectedDca: true,
};

/**
 * Simulates the actual sequence a real LiveExecutionAdapter would produce
 * for the full recurring lifecycle the task describes: strategy
 * confirmation -> due cycle -> account preflight (implied — this test
 * focuses on the adapter-facing contract, real preflight is exercised for
 * real in tests/liveExecution.test.ts) -> funding check (implied, see
 * fundingReadiness.test.ts) -> stock order -> fill reconciliation -> hedge
 * sizing (already re-derived from the ACTUAL stock fill by runContribution
 * for live mode) -> hedge order -> position reconciliation -> durable
 * receipt -> next scheduled cycle. This test proves those pieces work
 * TOGETHER across TWO consecutive real due cycles, not just individually.
 */
function makeMockLiveAdapter(behavior: { cycle2HedgeThrows?: boolean }): ExecutionAdapter {
  let callCount = 0;
  return {
    mode: "live",
    // Fills exactly what the real sizing engine requested (via `leg`), like a real full-fill market
    // order would — this matters because live mode re-derives the hedge budget from the stock leg's
    // ACTUAL filled notional (runContribution.ts), so a realistic fill here is what makes the hedge
    // leg's own executability/throw behavior representative of the real lifecycle.
    placeOrder: vi.fn(async (symbol: string, side: "BUY" | "SELL", leg: { quantity: number; notionalUsd?: number }): Promise<Fill> => {
      callCount++;
      const isStock = symbol === "NVDABUSDT";
      if (behavior.cycle2HedgeThrows && !isStock && callCount > 2) {
        throw new Error("Margin is insufficient."); // real-shaped exception, exercises runContribution's throw-capturing wrapper
      }
      const price = isStock ? 226.16 : 226.2;
      return {
        symbol,
        side,
        quantity: leg.quantity,
        price,
        notionalUsd: leg.notionalUsd ?? Math.round(leg.quantity * price * 100) / 100,
        mode: "live",
        orderId: `live-order-${callCount}`,
        status: "filled",
      };
    }),
  };
}

describe("Full recurring live lifecycle — two consecutive due cycles through processCycle/runContribution with a live-shaped adapter", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    vi.mocked(discoverPair).mockResolvedValue(DISCOVERY as never);
  });
  afterEach(() => db.close());

  it("cycle 1 completes both legs; cycle 2's hedge leg throws — cycle 1's real fill and receipt are NOT affected by cycle 2's failure, and the schedule still advances correctly for a future cycle 3", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 63, // arbitrary user-configured amount, large enough that both legs clear exchange minimums (a $5 contribution's hedge leg would safely defer instead — see fundingReadiness/contributionSizeSweep tests for that behavior)
      frequency: "daily",
      hedgeLeverage: 2,
      intervalMinutes: 10, // generic interval cadence, not daily/weekly/monthly
      firstDueAt: "2026-01-01T00:00:00.000Z",
    });

    const adapter = makeMockLiveAdapter({ cycle2HedgeThrows: true });

    // --- Cycle 1: due at 00:00, both legs filled ---
    const now1 = new Date("2026-01-01T00:00:00.000Z");
    const created1 = ensureDueCycles(db, strategy, now1);
    expect(created1.length).toBe(1);
    const claimed1 = claimCycle(db, created1[0]);
    const strategyAfterCycle1 = db.prepare("SELECT * FROM strategies WHERE id = ?").get(strategy.id) as typeof strategy;
    const receipt1 = await processCycle(db, claimed1!, strategyAfterCycle1, adapter);
    expect(receipt1.status).toBe("completed");

    // --- Cycle 2: due at 00:10 (per the 10-minute interval), hedge leg throws ---
    const strategyBeforeCycle2 = db.prepare("SELECT * FROM strategies WHERE id = ?").get(strategy.id) as typeof strategy;
    const now2 = new Date("2026-01-01T00:10:00.000Z");
    const created2 = ensureDueCycles(db, strategyBeforeCycle2, now2);
    expect(created2.length).toBe(1);
    expect(
      (db.prepare("SELECT scheduled_for FROM cycles WHERE id = ?").get(created2[0]) as { scheduled_for: string }).scheduled_for,
    ).toBe("2026-01-01T00:10:00.000Z"); // real 10-minute interval advancement, not hardcoded
    const claimed2 = claimCycle(db, created2[0]);
    const strategyAfterCycle1Cycle = db.prepare("SELECT * FROM strategies WHERE id = ?").get(strategy.id) as typeof strategy;
    const receipt2 = await processCycle(db, claimed2!, strategyAfterCycle1Cycle, adapter);
    expect(receipt2.status).toBe("partial_failure");
    expect(receipt2.hedge!.orderStatus).toBe("rejected");
    expect(receipt2.hedge!.reason).toMatch(/UNRESOLVED/);
    expect(receipt2.stock!.orderStatus).toBe("filled"); // cycle 2's stock leg DID fill — its receipt must survive the hedge throw too

    // cycle 2's cycle-status is terminal (never auto-retried — would double the stock leg that already filled)
    const cycle2Row = db.prepare("SELECT status FROM cycles WHERE id = ?").get(created2[0]) as { status: string };
    expect(cycle2Row.status).toBe("failed_terminal");
    expect(getPendingAndRetryableCycles(db).some((c) => c.id === created2[0])).toBe(false);

    // cycle 1's outcome is completely unaffected by cycle 2's later failure
    const cycle1Row = db.prepare("SELECT status FROM cycles WHERE id = ?").get(created1[0]) as { status: string };
    expect(cycle1Row.status).toBe("completed");

    // Aggregate state: contributionsCount only counts fully `completed` executions (by design — see
    // getPaperState's own doc comment), so cycle 2's partial_failure doesn't count as a contribution,
    // but its real stock fill still accumulates into cumulativeStockQty (never lost, never over-reported).
    const paperState = getPaperState(db, strategy.id);
    expect(paperState.contributionsCount).toBe(1); // only cycle 1 fully completed
    expect(paperState.cumulativeStockQty).toBeGreaterThan(0.4); // BOTH cycles' real stock fills accumulated (each ~0.25 at this contribution/price)

    // --- Cycle 3: schedule still advances correctly (00:20) despite cycle 2's failure — proves the scheduler/lifecycle isn't wedged by a partial_failure ---
    const strategyBeforeCycle3 = db.prepare("SELECT * FROM strategies WHERE id = ?").get(strategy.id) as typeof strategy;
    const now3 = new Date("2026-01-01T00:20:00.000Z");
    const created3 = ensureDueCycles(db, strategyBeforeCycle3, now3);
    expect(created3.length).toBe(1);
    expect(
      (db.prepare("SELECT scheduled_for FROM cycles WHERE id = ?").get(created3[0]) as { scheduled_for: string }).scheduled_for,
    ).toBe("2026-01-01T00:20:00.000Z");
  });
});
