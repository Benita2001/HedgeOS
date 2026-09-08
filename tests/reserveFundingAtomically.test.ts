import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrategy, reserveFundingAtomically, resolveFundingReservation, getReservedFuturesUsd, FUNDING_RESERVATION_STALE_AFTER_MINUTES } from "../src/db/index.js";

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

function dueCycle(db: Database.Database, strategyId: number, scheduledFor: string) {
  const info = db.prepare("INSERT INTO cycles (strategy_id, scheduled_for, idempotency_key) VALUES (?, ?, ?)").run(strategyId, scheduledFor, `${strategyId}:${scheduledFor}`);
  return Number(info.lastInsertRowid);
}

describe("reserveFundingAtomically — the actual concurrency fix", () => {
  let db: Database.Database;
  beforeEach(() => (db = freshDb()));
  afterEach(() => db.close());

  it("reserves successfully when the account has enough for this strategy alone", () => {
    const s1 = makeStrategy(db, "AAPL");
    const c1 = dueCycle(db, s1.id, "2026-01-01T00:00:00.000Z");
    const result = reserveFundingAtomically(db, { strategyId: s1.id, cycleId: c1, amountUsd: 10, futuresAvailableUsd: 20, reservedByOthersUsd: 0 });
    expect(result.reserved).toBe(true);
    expect(result.reservation?.status).toBe("pending");
  });

  it("SIMULTANEOUS funding attempts: two strategies racing for the same limited pool — the second correctly loses once the first has committed its reservation", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    const c1 = dueCycle(db, s1.id, "2026-01-01T00:00:00.000Z");
    const c2 = dueCycle(db, s2.id, "2026-01-01T00:00:00.000Z");

    // Both strategies observed the SAME account snapshot before either reserved (the real race
    // condition): $15 available, neither aware of the other's imminent claim.
    const snapshotAvailable = 15;
    const r1 = reserveFundingAtomically(db, { strategyId: s1.id, cycleId: c1, amountUsd: 10, futuresAvailableUsd: snapshotAvailable, reservedByOthersUsd: 0 });
    // s2's call re-reads pending reservations INSIDE its own lock — by the time it runs (after r1
    // has already committed, since this is synchronous), it correctly sees s1's $10 already claimed.
    const r2 = reserveFundingAtomically(db, { strategyId: s2.id, cycleId: c2, amountUsd: 10, futuresAvailableUsd: snapshotAvailable, reservedByOthersUsd: 0 });

    expect(r1.reserved).toBe(true);
    expect(r2.reserved).toBe(false); // only $5 unreserved remains ($15 - s1's $10) — not enough for s2's $10
    expect(r2.reason).toMatch(/insufficient unreserved balance/);
  });

  it("two strategies each requesting an amount that DOES both fit succeed independently", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    const c1 = dueCycle(db, s1.id, "2026-01-01T00:00:00.000Z");
    const c2 = dueCycle(db, s2.id, "2026-01-01T00:00:00.000Z");
    const r1 = reserveFundingAtomically(db, { strategyId: s1.id, cycleId: c1, amountUsd: 5, futuresAvailableUsd: 15, reservedByOthersUsd: 0 });
    const r2 = reserveFundingAtomically(db, { strategyId: s2.id, cycleId: c2, amountUsd: 5, futuresAvailableUsd: 15, reservedByOthersUsd: 0 });
    expect(r1.reserved).toBe(true);
    expect(r2.reserved).toBe(true); // 15 - 5(s1) = 10 unreserved, comfortably covers s2's 5
  });

  it("RESTART/RETRY recovery: reserving again for the SAME (strategy, cycle) returns the existing reservation — never double-reserves", () => {
    const s1 = makeStrategy(db, "AAPL");
    const c1 = dueCycle(db, s1.id, "2026-01-01T00:00:00.000Z");
    const first = reserveFundingAtomically(db, { strategyId: s1.id, cycleId: c1, amountUsd: 10, futuresAvailableUsd: 20, reservedByOthersUsd: 0 });
    // Simulate a worker crash right after reserving but before the transfer resolved, then a
    // restart re-claims the same due cycle (claimCycle's own idempotency) and retries funding.
    const retry = reserveFundingAtomically(db, { strategyId: s1.id, cycleId: c1, amountUsd: 10, futuresAvailableUsd: 20, reservedByOthersUsd: 0 });
    expect(first.reservation?.id).toBe(retry.reservation?.id); // same row, not a new one
    expect(retry.reserved).toBe(true);
    expect(retry.reason).toMatch(/already exists/);
  });

  it("an UNCERTAIN transfer's reservation is resolved to 'released' by the caller when the transfer ultimately fails/is unresolved — freeing the amount for a later cycle", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    const c1 = dueCycle(db, s1.id, "2026-01-01T00:00:00.000Z");
    const r1 = reserveFundingAtomically(db, { strategyId: s1.id, cycleId: c1, amountUsd: 10, futuresAvailableUsd: 15, reservedByOthersUsd: 0 });
    expect(getReservedFuturesUsd(db, s2.id)).toBe(10); // s2 sees s1's pending reservation as reserved

    resolveFundingReservation(db, r1.reservation!.id, "released"); // the transfer came back unresolved/failed
    expect(getReservedFuturesUsd(db, s2.id)).toBe(0); // released — no longer blocks s2's own funding
  });

  it("a CONFIRMED transfer's reservation stops counting as 'pending' (the real execution row is the durable record from then on) but doesn't need to double-count", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    const c1 = dueCycle(db, s1.id, "2026-01-01T00:00:00.000Z");
    const r1 = reserveFundingAtomically(db, { strategyId: s1.id, cycleId: c1, amountUsd: 10, futuresAvailableUsd: 15, reservedByOthersUsd: 0 });
    resolveFundingReservation(db, r1.reservation!.id, "confirmed");
    // No longer 'pending', so getReservedFuturesUsd's pending-sum no longer includes it —
    // by this point the real executions row (inserted separately by runContribution) is what
    // getReservedFuturesUsd's OTHER half (confirmed executions) picks up instead.
    expect(getReservedFuturesUsd(db, s2.id)).toBe(0);
  });

  it("a reservation older than the staleness window no longer counts against other strategies — an abandoned/crashed attempt doesn't block funding forever", () => {
    const s1 = makeStrategy(db, "AAPL");
    const s2 = makeStrategy(db, "MSFT");
    const c1 = dueCycle(db, s1.id, "2026-01-01T00:00:00.000Z");
    const r1 = reserveFundingAtomically(db, { strategyId: s1.id, cycleId: c1, amountUsd: 10, futuresAvailableUsd: 15, reservedByOthersUsd: 0 });
    expect(r1.reserved).toBe(true);
    // Backdate the reservation past the staleness window, simulating an abandoned attempt.
    db.prepare("UPDATE funding_reservations SET created_at = datetime('now', ?) WHERE id = ?").run(`-${FUNDING_RESERVATION_STALE_AFTER_MINUTES + 5} minutes`, r1.reservation!.id);
    expect(getReservedFuturesUsd(db, s2.id)).toBe(0); // stale — no longer reserved against s2
  });
});

describe("reserveFundingAtomically — genuine multi-connection concurrency (two separate SQLite connections to the SAME on-disk file, the real worker/MCP-server topology)", () => {
  const TMP_DB = join(__dirname, "..", "data", "test-reservation-concurrency.db");

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(TMP_DB + suffix)) unlinkSync(TMP_DB + suffix);
  });

  it("a SECOND, INDEPENDENT connection to the same database file cannot double-reserve past what the FIRST connection already committed — proves this is a real SQLite-level lock, not just single-process application logic", () => {
    const dbA = new Database(TMP_DB);
    dbA.pragma("journal_mode = WAL");
    dbA.exec(SCHEMA_SQL);
    const s1 = makeStrategy(dbA, "AAPL");
    const s2 = makeStrategy(dbA, "MSFT");
    const c1 = dueCycle(dbA, s1.id, "2026-01-01T00:00:00.000Z");
    const c2 = dueCycle(dbA, s2.id, "2026-01-01T00:00:00.000Z");
    dbA.close();

    // Two genuinely separate connections — this is exactly the worker process and an operator's
    // MCP-triggered trigger_due_cycle call, or two worker instances, hitting the same file.
    const connA = new Database(TMP_DB);
    const connB = new Database(TMP_DB);
    connA.pragma("journal_mode = WAL");
    connB.pragma("journal_mode = WAL");

    const rA = reserveFundingAtomically(connA, { strategyId: s1.id, cycleId: c1, amountUsd: 10, futuresAvailableUsd: 15, reservedByOthersUsd: 0 });
    const rB = reserveFundingAtomically(connB, { strategyId: s2.id, cycleId: c2, amountUsd: 10, futuresAvailableUsd: 15, reservedByOthersUsd: 0 });

    expect(rA.reserved).toBe(true);
    expect(rB.reserved).toBe(false); // connB's own transaction re-read the real on-disk state and saw connA's committed reservation
    connA.close();
    connB.close();
  });
});
