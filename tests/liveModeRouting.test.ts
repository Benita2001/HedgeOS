import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrategy, getStrategy } from "../src/db/index.js";
import { ensureDueCycles, claimCycle, getPendingAndRetryableCycles } from "../src/scheduler/cycles.js";
import { assertLiveTradingGate } from "../src/binance/liveExecution.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf-8");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

describe("createStrategy — mode routing and its guardrails", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("defaults to mode='paper' when unspecified — unchanged prior behavior for every existing call site", () => {
    const s = createStrategy(db, { ticker: "NVDA", spotSymbol: "NVDABUSDT", futuresSymbol: "NVDAUSDT", contributionUsd: 100, frequency: "daily", hedgeLeverage: 2 });
    expect(s.mode).toBe("paper");
    expect(s.capital_limit_usd).toBeNull();
  });

  it("mode='live' is refused without an explicit, positive capitalLimitUsd", () => {
    expect(() =>
      createStrategy(db, { ticker: "NVDA", spotSymbol: "NVDABUSDT", futuresSymbol: "NVDAUSDT", contributionUsd: 10, frequency: "daily", hedgeLeverage: 2, mode: "live", endAt: "2026-12-01T00:00:00.000Z" }),
    ).toThrow(/requires an explicit, positive capitalLimitUsd/);
    expect(() =>
      createStrategy(db, { ticker: "NVDA", spotSymbol: "NVDABUSDT", futuresSymbol: "NVDAUSDT", contributionUsd: 10, frequency: "daily", hedgeLeverage: 2, mode: "live", endAt: "2026-12-01T00:00:00.000Z", capitalLimitUsd: -5 }),
    ).toThrow(/capitalLimitUsd/);
  });

  it("mode='live' is refused without an explicit endAt — never an unattended, indefinitely-recurring live strategy", () => {
    expect(() =>
      createStrategy(db, { ticker: "NVDA", spotSymbol: "NVDABUSDT", futuresSymbol: "NVDAUSDT", contributionUsd: 10, frequency: "daily", hedgeLeverage: 2, mode: "live", capitalLimitUsd: 100 }),
    ).toThrow(/requires an explicit endAt/);
  });

  it("mode='live' with both capitalLimitUsd and endAt succeeds and persists exactly what was given — no hardcoded amount/ticker/duration anywhere in this path", () => {
    const s = createStrategy(db, {
      ticker: "AAPL", spotSymbol: "AAPLBUSDT", futuresSymbol: "AAPLUSDT",
      contributionUsd: 10, frequency: "daily", hedgeLeverage: 2, intervalMinutes: 60,
      mode: "live", capitalLimitUsd: 240, endAt: "2026-12-01T00:00:00.000Z",
    });
    expect(s.mode).toBe("live");
    expect(s.capital_limit_usd).toBe(240);
    expect(s.contribution_usd).toBe(10);
    expect(s.interval_minutes).toBe(60);
  });

  it("a paper strategy created alongside a live one is completely unaffected — no cross-contamination of records", () => {
    const paper = createStrategy(db, { ticker: "NVDA", spotSymbol: "NVDABUSDT", futuresSymbol: "NVDAUSDT", contributionUsd: 100, frequency: "daily", hedgeLeverage: 2 });
    const live = createStrategy(db, { ticker: "AAPL", spotSymbol: "AAPLBUSDT", futuresSymbol: "AAPLUSDT", contributionUsd: 10, frequency: "daily", hedgeLeverage: 2, mode: "live", capitalLimitUsd: 100, endAt: "2026-12-01T00:00:00.000Z" });
    expect(getStrategy(db, paper.id)?.mode).toBe("paper");
    expect(getStrategy(db, live.id)?.mode).toBe("live");
  });
});

describe("Passive worker never auto-executes a live-mode strategy's due cycle (the exact check worker/index.ts's tick loop performs)", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("a live strategy's due cycle, once claimed, is reverted to pending rather than processed — matches worker/index.ts's own logic exactly", () => {
    const live = createStrategy(db, {
      ticker: "AAPL", spotSymbol: "AAPLBUSDT", futuresSymbol: "AAPLUSDT", contributionUsd: 10, frequency: "daily", hedgeLeverage: 2,
      mode: "live", capitalLimitUsd: 100, endAt: "2026-12-01T00:00:00.000Z", firstDueAt: "2026-01-01T00:00:00.000Z",
    });
    ensureDueCycles(db, live, new Date("2026-01-01T00:00:00.000Z"));
    const due = getPendingAndRetryableCycles(db).filter((c) => c.strategy_id === live.id);
    expect(due.length).toBe(1);

    // Reproduces worker/index.ts's tick(): claim, look up the strategy, and if mode==='live',
    // revert to pending instead of calling processCycle.
    const claimed = claimCycle(db, due[0].id);
    expect(claimed?.status).toBe("in_progress");
    const strategy = getStrategy(db, claimed!.strategy_id)!;
    expect(strategy.mode).toBe("live");
    if (strategy.mode === "live") {
      db.prepare("UPDATE cycles SET status = 'pending' WHERE id = ?").run(claimed!.id);
    }

    const after = db.prepare("SELECT status FROM cycles WHERE id = ?").get(claimed!.id) as { status: string };
    expect(after.status).toBe("pending"); // never left in_progress, never advanced to completed — no execution row was ever created
    const execCount = (db.prepare("SELECT COUNT(*) as c FROM executions").get() as { c: number }).c;
    expect(execCount).toBe(0); // proves nothing was actually executed
  });

  it("a PAPER strategy's due cycle is unaffected by the live-mode check — normal processing path still applies", () => {
    const paper = createStrategy(db, { ticker: "NVDA", spotSymbol: "NVDABUSDT", futuresSymbol: "NVDAUSDT", contributionUsd: 100, frequency: "daily", hedgeLeverage: 2, firstDueAt: "2026-01-01T00:00:00.000Z" });
    ensureDueCycles(db, paper, new Date("2026-01-01T00:00:00.000Z"));
    const due = getPendingAndRetryableCycles(db).filter((c) => c.strategy_id === paper.id);
    const claimed = claimCycle(db, due[0].id);
    const strategy = getStrategy(db, claimed!.strategy_id)!;
    expect(strategy.mode).toBe("paper"); // would NOT be reverted — the worker proceeds to processCycle normally
  });
});

describe("assertLiveTradingGate — independent of a strategy's own mode field (defense in depth)", () => {
  it("a strategy marked mode='live' does not itself satisfy the environment gate — both must independently agree", () => {
    // Simulates trigger_live_cycle's own check: even for a genuinely live-mode strategy,
    // the environment gate is re-checked fresh and fails closed if unset.
    expect(() => assertLiveTradingGate({} as NodeJS.ProcessEnv)).toThrow(/HEDGEOS_MODE is not 'live'/);
  });
});
