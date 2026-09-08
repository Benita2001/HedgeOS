import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrategy, hasScheduleEnded, type StrategyRow } from "../src/db/index.js";
import { ensureDueCycles, claimCycle, getPendingAndRetryableCycles, reconcileInProgressCycles, MAX_CATCHUP_CYCLES } from "../src/scheduler/cycles.js";
import { addCadence, assertValidIntervalMinutes, MIN_INTERVAL_MINUTES } from "../src/scheduler/cadence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf-8");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

function makeIntervalStrategy(db: Database.Database, intervalMinutes: number, overrides: Partial<Parameters<typeof createStrategy>[1]> = {}): StrategyRow {
  return createStrategy(db, {
    ticker: "NVDA",
    spotSymbol: "NVDABUSDT",
    futuresSymbol: "NVDAUSDT",
    contributionUsd: 5,
    frequency: "daily", // required, but overridden for scheduling by intervalMinutes below
    hedgeLeverage: 2,
    intervalMinutes,
    ...overrides,
  });
}

describe("addCadence — generic interval, no hardcoded value", () => {
  it("advances by exactly the given number of minutes, whatever it is — 1, 10, 90, 1440, all treated identically", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    for (const minutes of [1, 5, 10, 37, 90, 1440]) {
      const next = addCadence(start, "daily", minutes);
      expect(next.getTime() - start.getTime()).toBe(minutes * 60_000);
    }
  });

  it("intervalMinutes, when given, completely overrides frequency (frequency becomes purely informational)", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const withDailyLabel = addCadence(start, "daily", 10);
    const withMonthlyLabel = addCadence(start, "monthly", 10);
    expect(withDailyLabel.getTime()).toBe(withMonthlyLabel.getTime()); // frequency label is ignored once intervalMinutes is set
  });

  it("falls back to calendar cadence when intervalMinutes is null/undefined — unchanged prior behavior", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    expect(addCadence(start, "daily", null).getUTCDate()).toBe(2);
    expect(addCadence(start, "daily", undefined).getUTCDate()).toBe(2);
    expect(addCadence(start, "daily").getUTCDate()).toBe(2);
  });
});

describe("assertValidIntervalMinutes — rejects excessively frequent / invalid schedules", () => {
  it("accepts the documented minimum and anything above it", () => {
    expect(() => assertValidIntervalMinutes(MIN_INTERVAL_MINUTES)).not.toThrow();
    expect(() => assertValidIntervalMinutes(10)).not.toThrow();
    expect(() => assertValidIntervalMinutes(100000)).not.toThrow();
  });

  it("rejects below the minimum (excessively frequent — faster than the worker could ever observe)", () => {
    expect(() => assertValidIntervalMinutes(0)).toThrow(/>= 1/);
    expect(() => assertValidIntervalMinutes(-5)).toThrow(/>= 1/);
  });

  it("rejects fractional minutes — the schema/cadence contract is whole minutes only", () => {
    expect(() => assertValidIntervalMinutes(0.5)).toThrow(/whole number/);
    expect(() => assertValidIntervalMinutes(10.5)).toThrow(/whole number/);
  });

  it("createStrategy itself rejects an invalid intervalMinutes — validated at the DB-facing boundary, not just in the MCP layer", () => {
    const db = freshDb();
    expect(() => makeIntervalStrategy(db, 0)).toThrow(/>= 1/);
    expect(() => makeIntervalStrategy(db, -10)).toThrow();
    db.close();
  });
});

describe("ensureDueCycles — generic interval scheduling, e.g. 'invest $5 in NVDA every 10 minutes'", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("creates cycles exactly on the interval boundary, not more/less often", () => {
    const strategy = makeIntervalStrategy(db, 10, { firstDueAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-01-01T00:35:00.000Z"); // 3.5 intervals elapsed
    ensureDueCycles(db, strategy, now);
    const cycles = db.prepare("SELECT scheduled_for FROM cycles WHERE strategy_id = ? ORDER BY scheduled_for").all(strategy.id) as Array<{ scheduled_for: string }>;
    expect(cycles.map((c) => c.scheduled_for)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T00:20:00.000Z",
      "2026-01-01T00:30:00.000Z",
    ]); // the 00:40 slot is not yet due at 00:35
  });

  it("duplicate ticks (calling ensureDueCycles twice for the same 'now') create no duplicate cycles — idempotent by (strategy_id, scheduled_for)", () => {
    const strategy = makeIntervalStrategy(db, 10, { firstDueAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-01-01T00:15:00.000Z");
    ensureDueCycles(db, strategy, now);
    const afterFirst = db.prepare("SELECT * FROM strategies WHERE id = ?").get(strategy.id) as StrategyRow;
    ensureDueCycles(db, afterFirst, now); // second tick, same moment — simulates two overlapping worker ticks
    const cycles = db.prepare("SELECT COUNT(*) as c FROM cycles WHERE strategy_id = ?").get(strategy.id) as { c: number };
    expect(cycles.c).toBe(2); // 00:00 and 00:10 — not duplicated by the second call
  });

  it("missed intervals (worker down for a while) catch up, capped at MAX_CATCHUP_CYCLES per tick — never an unbounded burst", () => {
    const strategy = makeIntervalStrategy(db, 1, { firstDueAt: "2026-01-01T00:00:00.000Z" }); // every 1 minute — worst case for backlog size
    const now = new Date("2026-01-01T05:00:00.000Z"); // 300 minutes missed
    const created = ensureDueCycles(db, strategy, now);
    expect(created.length).toBe(MAX_CATCHUP_CYCLES); // capped, not 300
  });

  it("restart recovery: an in_progress cycle from before a crash is resolved by reconcileInProgressCycles, not silently re-created", () => {
    const strategy = makeIntervalStrategy(db, 10, { firstDueAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const createdIds = ensureDueCycles(db, strategy, now);
    const claimed = claimCycle(db, createdIds[0]);
    expect(claimed?.status).toBe("in_progress");
    // Simulate the worker restarting before this cycle ever resolved (no execution row was ever written).
    const recovered = reconcileInProgressCycles(db);
    expect(recovered.length).toBe(1);
    const after = db.prepare("SELECT status FROM cycles WHERE id = ?").get(createdIds[0]) as { status: string };
    expect(["pending", "failed_retryable"]).toContain(after.status); // resolved to a re-claimable state, never left stuck in_progress
  });

  it("end_at interacts correctly with interval cadence — no cycle scheduled past the boundary, even at fine granularity", () => {
    const strategy = makeIntervalStrategy(db, 10, { firstDueAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-01T00:20:00.000Z" });
    const now = new Date("2026-01-01T02:00:00.000Z"); // far past — would create many more cycles without the boundary
    ensureDueCycles(db, strategy, now);
    const cycles = db.prepare("SELECT scheduled_for FROM cycles WHERE strategy_id = ? ORDER BY scheduled_for").all(strategy.id) as Array<{ scheduled_for: string }>;
    expect(cycles.map((c) => c.scheduled_for)).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z", "2026-01-01T00:20:00.000Z"]);
    const updated = db.prepare("SELECT * FROM strategies WHERE id = ?").get(strategy.id) as StrategyRow;
    expect(hasScheduleEnded(updated, now)).toBe(true);
  });

  it("a strategy with no intervalMinutes is completely unaffected — exact prior daily/weekly/monthly behavior", () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA", spotSymbol: "NVDABUSDT", futuresSymbol: "NVDAUSDT",
      contributionUsd: 100, frequency: "daily", hedgeLeverage: 2, firstDueAt: "2026-01-01T00:00:00.000Z",
    });
    expect(strategy.interval_minutes).toBeNull();
    const created = ensureDueCycles(db, strategy, new Date("2026-01-01T12:00:00.000Z")); // half a day later — only the Jan 1 00:00 slot is due
    expect(created.length).toBe(1); // exactly one daily cycle, as before this session's changes
  });
});

describe("getPendingAndRetryableCycles — works identically regardless of cadence type (sanity check, no interval-specific branching exists in the claim path)", () => {
  it("a pending interval-scheduled cycle is claimable exactly like a daily one", () => {
    const db = freshDb();
    const strategy = makeIntervalStrategy(db, 10, { firstDueAt: "2026-01-01T00:00:00.000Z" });
    ensureDueCycles(db, strategy, new Date("2026-01-01T00:00:00.000Z"));
    const pending = getPendingAndRetryableCycles(db).filter((c) => c.strategy_id === strategy.id);
    expect(pending.length).toBe(1);
    db.close();
  });
});
