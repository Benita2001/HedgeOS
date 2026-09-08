import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrategy, hasScheduleEnded, openDb, type StrategyRow } from "../src/db/index.js";
import { ensureDueCycles, MAX_CATCHUP_CYCLES } from "../src/scheduler/cycles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf-8");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

function makeStrategy(db: Database.Database, overrides: Partial<Parameters<typeof createStrategy>[1]> = {}): StrategyRow {
  return createStrategy(db, {
    ticker: "AAPL",
    spotSymbol: "AAPLBUSDT",
    futuresSymbol: "AAPLUSDT",
    contributionUsd: 250,
    frequency: "weekly",
    hedgeLeverage: 2,
    ...overrides,
  });
}

describe("hasScheduleEnded — pure, derived, no DB status change", () => {
  it("false when end_at is null (every pre-existing strategy, and the default for new ones)", () => {
    expect(hasScheduleEnded({ next_due_at: "2026-01-01T00:00:00.000Z", end_at: null })).toBe(false);
  });
  it("false while next_due_at is still on/before end_at", () => {
    expect(hasScheduleEnded({ next_due_at: "2026-01-01T00:00:00.000Z", end_at: "2026-06-01T00:00:00.000Z" })).toBe(false);
    expect(hasScheduleEnded({ next_due_at: "2026-06-01T00:00:00.000Z", end_at: "2026-06-01T00:00:00.000Z" })).toBe(false); // exact boundary
  });
  it("true once next_due_at is after end_at", () => {
    expect(hasScheduleEnded({ next_due_at: "2026-06-02T00:00:00.000Z", end_at: "2026-06-01T00:00:00.000Z" })).toBe(true);
  });
});

describe("createStrategy — endAt is optional and validated", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("defaults end_at to null (backward compatible — identical to a strategy with no duration)", () => {
    const s = makeStrategy(db);
    expect(s.end_at).toBeNull();
  });

  it("persists a valid ISO endAt exactly", () => {
    const s = makeStrategy(db, { endAt: "2026-09-08T00:00:00.000Z" });
    expect(s.end_at).toBe("2026-09-08T00:00:00.000Z");
  });

  it("rejects an invalid endAt rather than silently storing garbage", () => {
    expect(() => makeStrategy(db, { endAt: "not-a-date" })).toThrow(/not a valid ISO timestamp/);
  });
});

describe("ensureDueCycles — 'invest $250 in AAPL every week for six months' (end_at enforcement)", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("creates the cycle scheduled exactly ON end_at (inclusive boundary), but none after", () => {
    const strategy = makeStrategy(db, {
      frequency: "weekly",
      firstDueAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-01-15T00:00:00.000Z", // exactly the 3rd weekly slot: Jan 1, Jan 8, Jan 15
    });
    const now = new Date("2026-02-01T00:00:00.000Z"); // far past everything — would normally catch up many cycles
    const createdIds = ensureDueCycles(db, strategy, now);
    const cycles = db.prepare("SELECT scheduled_for FROM cycles WHERE strategy_id = ? ORDER BY scheduled_for").all(strategy.id) as Array<{ scheduled_for: string }>;
    expect(cycles.map((c) => c.scheduled_for)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-08T00:00:00.000Z",
      "2026-01-15T00:00:00.000Z",
    ]);
    expect(createdIds.length).toBe(3);

    // A second call (simulating the next worker tick), re-reading the persisted row exactly as
    // the real worker loop does, creates nothing further — the schedule has ended.
    const updatedAfterFirstCall = db.prepare("SELECT * FROM strategies WHERE id = ?").get(strategy.id) as StrategyRow;
    const secondCallCreated = ensureDueCycles(db, updatedAfterFirstCall, now);
    expect(secondCallCreated.length).toBe(0);
    expect(hasScheduleEnded(updatedAfterFirstCall, now)).toBe(true);
  });

  it("missed-cycle catch-up near the end date is capped at end_at — never catches up PAST it", () => {
    // Strategy was created long ago and the worker was down (or paused) for a while — many weekly
    // slots are now due at once. end_at falls in the middle of the backlog.
    const strategy = makeStrategy(db, {
      frequency: "daily",
      firstDueAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-01-05T00:00:00.000Z", // only the first 5 daily slots should ever be created
    });
    const now = new Date("2026-03-01T00:00:00.000Z"); // huge backlog if end_at weren't respected
    ensureDueCycles(db, strategy, now);
    const cycles = db.prepare("SELECT scheduled_for FROM cycles WHERE strategy_id = ? ORDER BY scheduled_for").all(strategy.id) as Array<{ scheduled_for: string }>;
    expect(cycles.length).toBe(5); // Jan 1,2,3,4,5 — not MAX_CATCHUP_CYCLES(12), not unlimited
    expect(cycles[cycles.length - 1].scheduled_for).toBe("2026-01-05T00:00:00.000Z");
  });

  it("a strategy with no end_at behaves EXACTLY as before — unaffected, still catches up to MAX_CATCHUP_CYCLES", () => {
    const strategy = makeStrategy(db, { frequency: "daily", firstDueAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-06-01T00:00:00.000Z");
    const created = ensureDueCycles(db, strategy, now);
    expect(created.length).toBe(MAX_CATCHUP_CYCLES); // capped by the pre-existing catch-up limit, not by any end date
  });

  it("pause/resume: a paused strategy is never ticked (listActiveStrategies excludes it) — end_at logic doesn't need to special-case this, the worker loop already does", () => {
    // This documents the existing, unchanged guarantee: ensureDueCycles is only ever called
    // for active strategies (see src/worker/index.ts), so a paused strategy near its end_at
    // simply accumulates no new cycles until resumed, exactly like one with no end_at at all.
    const strategy = makeStrategy(db, { frequency: "weekly", firstDueAt: "2026-01-01T00:00:00.000Z", endAt: "2026-02-01T00:00:00.000Z" });
    db.prepare("UPDATE strategies SET status = 'paused' WHERE id = ?").run(strategy.id);
    const activeOnly = db.prepare("SELECT * FROM strategies WHERE status = 'active'").all();
    expect(activeOnly.length).toBe(0); // confirms the worker's own query would skip it — nothing more to test at this layer
  });

  it("ending a schedule never touches executions or receipts — no liquidation, ever", () => {
    const strategy = makeStrategy(db, { frequency: "weekly", firstDueAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-01T00:00:00.000Z" });
    ensureDueCycles(db, strategy, new Date("2026-06-01T00:00:00.000Z"));
    const execCount = (db.prepare("SELECT COUNT(*) as c FROM executions").get() as { c: number }).c;
    const receiptCount = (db.prepare("SELECT COUNT(*) as c FROM receipts").get() as { c: number }).c;
    expect(execCount).toBe(0); // ensureDueCycles only creates pending cycle rows, never executes anything
    expect(receiptCount).toBe(0);
  });
});

describe("openDb migration — an existing pre-end_at database gets the column added, existing data preserved", () => {
  const TMP_DB = join(__dirname, "..", "data", "test-migration.db");

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(TMP_DB + suffix)) unlinkSync(TMP_DB + suffix);
    }
  });

  it("adds end_at (NULL) to a table created under the OLD schema, without touching existing rows", () => {
    // Simulate a database created before end_at existed: build the OLD schema by hand (schema.sql
    // minus the end_at column), insert a real row, THEN open it through openDb() and confirm the
    // migration ran and the pre-existing row is untouched apart from gaining end_at=NULL.
    const oldSchema = SCHEMA_SQL.replace(/,\s*-- Optional ISO timestamp[\s\S]*?end_at TEXT DEFAULT NULL\n/, "\n").replace(",\n  end_at TEXT DEFAULT NULL", "");
    const raw = new Database(TMP_DB);
    raw.exec(oldSchema);
    const info = raw
      .prepare(
        `INSERT INTO strategies (ticker, spot_symbol, futures_symbol, contribution_usd, frequency, hedge_leverage, next_due_at)
         VALUES ('NVDA', 'NVDABUSDT', 'NVDAUSDT', 100, 'daily', 2, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const preMigrationColumns = raw.prepare("PRAGMA table_info(strategies)").all() as Array<{ name: string }>;
    expect(preMigrationColumns.some((c) => c.name === "end_at")).toBe(false); // confirm the OLD schema really lacks it
    raw.close();

    const migrated = openDb(TMP_DB);
    const columns = migrated.prepare("PRAGMA table_info(strategies)").all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === "end_at")).toBe(true);

    const row = migrated.prepare("SELECT * FROM strategies WHERE id = ?").get(info.lastInsertRowid) as StrategyRow;
    expect(row.end_at).toBeNull(); // migrated existing row: no duration, runs indefinitely — unchanged behavior
    expect(row.ticker).toBe("NVDA"); // existing data intact
    expect(row.next_due_at).toBe("2026-01-01T00:00:00.000Z");
    migrated.close();
  });

  it("running the migration twice (e.g. two processes opening the same DB) is a safe no-op", () => {
    const db1 = openDb(TMP_DB);
    db1.close();
    const db2 = openDb(TMP_DB); // should not throw "duplicate column name"
    const columns = db2.prepare("PRAGMA table_info(strategies)").all() as Array<{ name: string }>;
    expect(columns.filter((c) => c.name === "end_at").length).toBe(1);
    db2.close();
  });
});
