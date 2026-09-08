import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrategy, getReservedFuturesUsd } from "../src/db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf-8");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

function makeStrategy(db: Database.Database, ticker: string) {
  return createStrategy(db, { ticker, spotSymbol: `${ticker}BUSDT`, futuresSymbol: `${ticker}USDT`, contributionUsd: 63, frequency: "weekly", hedgeLeverage: 2 });
}

function insertExecution(db: Database.Database, strategyId: number, mode: "paper" | "live", hedgeOrderStatus: string, hedgeActualCollateralUsd: number) {
  db.prepare(
    `INSERT INTO executions (
       strategy_id, mode, status, contribution_usd, reference_price,
       stock_budget_usd, stock_qty, stock_notional_usd, stock_executable,
       hedge_budget_usd, hedge_leverage, hedge_target_short_notional_usd, hedge_qty,
       hedge_actual_short_notional_usd, hedge_actual_collateral_usd, hedge_executable, hedge_order_status
     ) VALUES (?, ?, 'completed', 63, 226.16, 0, 0, 0, 1, 0, 2, 0, 0, 0, ?, 1, ?)`,
  ).run(strategyId, mode, hedgeActualCollateralUsd, hedgeOrderStatus);
}
function insertLiveExecution(db: Database.Database, strategyId: number, hedgeOrderStatus: string, hedgeActualCollateralUsd: number) {
  insertExecution(db, strategyId, "live", hedgeOrderStatus, hedgeActualCollateralUsd);
}

describe("getReservedFuturesUsd — real DB-derived reservation, prevents concurrent strategies from double-counting", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("is 0 when no other strategy holds any live collateral", () => {
    const s1 = makeStrategy(db, "AAPL");
    expect(getReservedFuturesUsd(db, s1.id)).toBe(0);
  });

  it("sums another strategy's real filled collateral, excludes the strategy's own", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    insertLiveExecution(db, s1.id, "filled", 10);
    insertLiveExecution(db, s2.id, "filled", 15);
    expect(getReservedFuturesUsd(db, s1.id)).toBe(15); // s1 queries: only s2's collateral counts against it
    expect(getReservedFuturesUsd(db, s2.id)).toBe(10); // s2 queries: only s1's collateral counts against it
  });

  it("includes a PARTIALLY_FILLED hedge leg's collateral (still real, still held) but not a rejected one", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    insertLiveExecution(db, s2.id, "partially_filled", 7);
    insertLiveExecution(db, s2.id, "rejected", 999); // never actually held — must not count
    expect(getReservedFuturesUsd(db, s1.id)).toBe(7);
  });

  it("accumulates across MULTIPLE other strategies and multiple cycles each — the real concurrent-strategies scenario", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    const s3 = makeStrategy(db, "TSLA");
    insertLiveExecution(db, s2.id, "filled", 10);
    insertLiveExecution(db, s2.id, "filled", 12); // s2's second cycle adds more collateral
    insertLiveExecution(db, s3.id, "filled", 5);
    expect(getReservedFuturesUsd(db, s1.id)).toBe(27); // 10+12+5, none of it s1's own
  });

  it("ignores PAPER-mode executions entirely — no real Futures wallet is involved in paper mode", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    insertExecution(db, s2.id, "paper", "filled", 1000);
    expect(getReservedFuturesUsd(db, s1.id)).toBe(0);
  });

  it("a PAUSED strategy's already-open collateral still counts as reserved — pausing doesn't release it", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    insertLiveExecution(db, s2.id, "filled", 20);
    db.prepare("UPDATE strategies SET status = 'paused' WHERE id = ?").run(s2.id);
    expect(getReservedFuturesUsd(db, s1.id)).toBe(20);
  });
});
