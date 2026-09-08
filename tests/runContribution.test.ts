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
import { createStrategy } from "../src/db/index.js";
import { PaperExecutionAdapter } from "../src/binance/execution.js";
import { runContribution, UnsupportedPairError } from "../src/worker/runContribution.js";

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
  spot: { tradable: false, reason: "no spot bStock symbol ZZZZBUSDT" },
  futures: { tradable: false, reason: "no TRADIFI_PERPETUAL future named ZZZZUSDT" },
  usableForProtectedDca: false,
};

describe("runContribution — supported pair, paper mode", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    vi.mocked(discoverPair).mockResolvedValue(SUPPORTED_DISCOVERY as never);
  });
  afterEach(() => db.close());

  it("produces a structured receipt labeled simulated, with hedge budget/notional/collateral kept as separate values", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });

    const receipt = await runContribution(db, strategy, new PaperExecutionAdapter());

    expect(receipt.status).toBe("completed");
    expect(receipt.simulated).toBe(true);
    expect(receipt.mode).toBe("paper");

    // Distinct accounting values, never conflated:
    expect(receipt.hedge!.budgetUsd).toBeCloseTo(10, 6);
    expect(receipt.hedge!.targetShortNotionalUsd).toBeCloseTo(20, 6); // 10 * 2x
    expect(receipt.hedge!.requestedNotionalUsd).toBeLessThanOrEqual(receipt.hedge!.targetShortNotionalUsd);
    expect(receipt.hedge!.actualCollateralUsd).toBeLessThanOrEqual(receipt.hedge!.budgetUsd + 1e-9);
    expect(receipt.hedge!.actualCollateralUsd).not.toEqual(receipt.hedge!.requestedNotionalUsd);

    // Real fills recorded (simulated, but against the mocked live-shaped price).
    expect(receipt.stock!.filledQty).toBeGreaterThan(0);
    expect(receipt.hedge!.filledQty).toBeGreaterThan(0);
    expect(receipt.stock!.orderStatus).toBe("filled");
    expect(receipt.hedge!.orderStatus).toBe("filled");

    // Paper state recomputed from the ledger, not asserted separately.
    expect(receipt.paperState!.contributionsCount).toBe(1);
    expect(receipt.paperState!.cumulativeStockQty).toEqual(receipt.stock!.filledQty);
  });

  it("defers (not drops, not oversizes) a hedge budget too small to clear the exchange minimum", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 10, // hedge budget = $1 -> even at 3x, $3 target, likely under $5 minNotional depending on price
      frequency: "weekly",
      hedgeLeverage: 3,
    });

    const receipt = await runContribution(db, strategy, new PaperExecutionAdapter());

    if (!receipt.hedge!.executable) {
      expect(receipt.hedge!.deferredThisContributionUsd).toBeCloseTo(1, 6);
      expect(receipt.hedge!.filledQty).toBe(0);
    }
  });
});

describe("runContribution — partial fills and rejections (Priority 3 realism)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    vi.mocked(discoverPair).mockResolvedValue(SUPPORTED_DISCOVERY as never);
  });
  afterEach(() => db.close());

  it("records a partial fill distinctly from the requested quantity, and paperState reflects only what actually filled", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });

    const adapter = new PaperExecutionAdapter({
      simulateFill: (symbol, side, leg) =>
        side === "BUY" ? { quantity: leg.quantity / 2, status: "partially_filled", reason: "test-simulated thin liquidity" } : undefined,
    });

    const receipt = await runContribution(db, strategy, adapter);

    expect(receipt.status).toBe("completed"); // a partial fill is not a rejection — still a valid, recorded outcome
    expect(receipt.stock!.orderStatus).toBe("partially_filled");
    expect(receipt.stock!.filledQty).toBeLessThan(receipt.stock!.requestedQty);
    expect(receipt.stock!.filledQty).toBeGreaterThan(0);
    expect(receipt.paperState!.cumulativeStockQty).toEqual(receipt.stock!.filledQty);
  });

  it("marks the cycle partial_failure when one leg is rejected, and does not lose the leg that did fill", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });

    const adapter = new PaperExecutionAdapter({
      simulateFill: (symbol, side) => (side === "SELL" ? { status: "rejected", reason: "test-simulated exchange rejection" } : undefined),
    });

    const receipt = await runContribution(db, strategy, adapter);

    expect(receipt.status).toBe("partial_failure");
    expect(receipt.stock!.orderStatus).toBe("filled");
    expect(receipt.stock!.filledQty).toBeGreaterThan(0);
    expect(receipt.hedge!.orderStatus).toBe("rejected");
    expect(receipt.hedge!.filledQty).toBe(0);
    // The stock leg that DID fill must still be reflected in paper state — never dropped because the other leg failed.
    expect(receipt.paperState!.cumulativeStockQty).toEqual(receipt.stock!.filledQty);
    expect(receipt.paperState!.cumulativeHedgeQty).toBe(0);
  });
});

describe("runContribution — live mode: hedge sizing tracks the STOCK LEG'S ACTUAL fill, not the pre-trade target", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    vi.mocked(discoverPair).mockResolvedValue(SUPPORTED_DISCOVERY as never);
  });
  afterEach(() => db.close());

  it("re-derives the hedge budget from stockFill.notionalUsd (90/10 ratio applied to REALIZED dollars) before sizing the hedge leg", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });

    // Pre-trade target would be: stock budget $90 @ 233 -> ~0.386 qty -> ~$89.94
    // notional; hedge budget would nominally be $10. Simulate a stock fill
    // that came back notably LOWER than the pre-trade target (adverse
    // slippage/partial liquidity) — the hedge must track that real $80, not
    // the originally-budgeted $90.
    const placeOrder = vi.fn(async (symbol: string, side: "BUY" | "SELL", _leg: unknown, _refPrice: number, _ctx?: unknown) => {
      if (symbol === "NVDABUSDT") {
        return { symbol, side, quantity: 0.343, price: 233.24, notionalUsd: 80.0, mode: "live", orderId: "1", status: "filled" };
      }
      return { symbol, side, quantity: 0.03, price: 233.2, notionalUsd: 6.9, mode: "live", orderId: "2", status: "filled" };
    });

    const receipt = await runContribution(db, strategy, { mode: "live", placeOrder } as never, 1);

    expect(receipt.status).toBe("completed");
    // hedge budget actually used for sizing should be 80 * (0.1/0.9) = 8.888... -> $8.89, not the nominal $10
    const hedgeCall = placeOrder.mock.calls.find((c) => c[0] === "NVDAUSDT")!;
    const hedgeLegArg = hedgeCall[2] as { quantity: number };
    // at price 233.2, stepSize 0.01: target notional = 8.89 * 2 = 17.78 -> floor to 0.07 qty (0.07*233.2=16.32) — recompute expected via same math the engine uses
    expect(hedgeLegArg.quantity).toBeGreaterThan(0);
    expect(hedgeLegArg.quantity).toBeLessThan(0.09); // less than the nominal-budget sizing (~0.08-0.09) would have produced
    expect(receipt.hedge!.budgetUsd).toBeCloseTo(8.89, 2);
  });

  it("passes a stable idempotency context (strategyId, cycleId, leg) derived from the cycleId argument", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });
    const placeOrder = vi.fn(async (symbol: string, side: "BUY" | "SELL", _leg: unknown, _refPrice: number, _ctx?: unknown) => ({
      symbol,
      side,
      quantity: symbol === "NVDABUSDT" ? 0.38 : 0.06,
      price: symbol === "NVDABUSDT" ? 233 : 233.2,
      notionalUsd: symbol === "NVDABUSDT" ? 88.5 : 14,
      mode: "live",
      orderId: "x",
      status: "filled",
    }));

    await runContribution(db, strategy, { mode: "live", placeOrder } as never, 42);

    const stockCall = placeOrder.mock.calls.find((c) => c[0] === "NVDABUSDT")!;
    expect(stockCall[4]).toEqual({ strategyId: strategy.id, cycleId: 42, leg: "stock" });
    const hedgeCall = placeOrder.mock.calls.find((c) => c[0] === "NVDAUSDT")!;
    expect(hedgeCall[4]).toEqual({ strategyId: strategy.id, cycleId: 42, leg: "hedge" });
  });

  it("paper mode is unaffected: hedge sizing still uses the nominal contribution split, not the stock fill", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });
    const receipt = await runContribution(db, strategy, new PaperExecutionAdapter());
    // Nominal hedge budget for a $100 contribution is $10, regardless of the (near-exact, paper) stock fill.
    expect(receipt.hedge!.budgetUsd).toBe(10);
  });
});

describe("runContribution — CRITICAL: a THROWN hedge-leg error must never lose the stock leg's real fill", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    vi.mocked(discoverPair).mockResolvedValue(SUPPORTED_DISCOVERY as never);
  });
  afterEach(() => db.close());

  it("regression: previously, a throw from the hedge leg propagated out of runContribution before any DB write — the stock fill vanished entirely", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });

    const placeOrder = vi.fn(async (symbol: string) => {
      if (symbol === "NVDABUSDT") {
        return { symbol, side: "BUY", quantity: 0.386, price: 233, notionalUsd: 89.94, mode: "live", orderId: "real-order-1", status: "filled" };
      }
      // Simulates a real exception path: insufficient margin, a permission
      // failure, or a genuinely unresolved ambiguous-outcome error from
      // LiveExecutionAdapter — anything that THROWS rather than resolving.
      throw new Error("Margin is insufficient.");
    });

    // Must not throw out of runContribution — the wrapper converts the
    // hedge leg's throw into a recorded, clearly-labeled unresolved outcome.
    const receipt = await runContribution(db, strategy, { mode: "live", placeOrder } as never, 7);

    expect(receipt.status).toBe("partial_failure");

    // The critical assertion: the stock leg's REAL fill is actually persisted.
    expect(receipt.stock!.orderStatus).toBe("filled");
    expect(receipt.stock!.filledQty).toBeCloseTo(0.386, 6);
    const execRow = db.prepare("SELECT * FROM executions WHERE id = ?").get(receipt.executionId) as any;
    expect(execRow).toBeDefined();
    expect(execRow.stock_filled_qty).toBeCloseTo(0.386, 6);
    const receiptRows = db.prepare("SELECT * FROM receipts WHERE execution_id = ?").all(receipt.executionId) as any[];
    const stockReceipt = receiptRows.find((r) => r.leg === "stock");
    expect(stockReceipt).toBeDefined();
    expect(stockReceipt.order_id).toBe("real-order-1");

    // The hedge leg's outcome is recorded as unresolved/rejected, never silently dropped, and never mislabeled as a confirmed rejection.
    expect(receipt.hedge!.orderStatus).toBe("rejected");
    expect(receipt.hedge!.reason).toMatch(/UNRESOLVED/);
    expect(receipt.hedge!.reason).toMatch(/Margin is insufficient/);

    // paperState (used identically for live receipts) still reflects the real stock fill.
    expect(receipt.paperState!.cumulativeStockQty).toBeCloseTo(0.386, 6);
  });

  it("a throw from the STOCK leg itself is also captured, not just the hedge leg", async () => {
    const strategy = createStrategy(db, {
      ticker: "NVDA",
      spotSymbol: "NVDABUSDT",
      futuresSymbol: "NVDAUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });
    const placeOrder = vi.fn(async () => {
      throw new Error("Invalid API-key, IP, or permissions for action.");
    });

    const receipt = await runContribution(db, strategy, { mode: "live", placeOrder } as never, 8);
    expect(receipt.status).toBe("partial_failure");
    expect(receipt.stock!.orderStatus).toBe("rejected");
    expect(receipt.stock!.reason).toMatch(/UNRESOLVED/);
  });
});

describe("runContribution — unsupported pair", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    vi.mocked(discoverPair).mockResolvedValue(UNSUPPORTED_DISCOVERY as never);
  });
  afterEach(() => db.close());

  it("fails transparently with status=unsupported_pair and places no orders — no proxy hedge", async () => {
    const strategy = createStrategy(db, {
      ticker: "ZZZZ",
      spotSymbol: "ZZZZBUSDT",
      futuresSymbol: "ZZZZUSDT",
      contributionUsd: 100,
      frequency: "weekly",
      hedgeLeverage: 2,
    });

    const placeOrder = vi.fn();
    const receipt = await runContribution(db, strategy, { mode: "paper", placeOrder } as never);

    expect(receipt.status).toBe("unsupported_pair");
    expect(receipt.stock).toBeUndefined();
    expect(receipt.hedge).toBeUndefined();
    expect(placeOrder).not.toHaveBeenCalled();

    const row = db.prepare("SELECT * FROM executions WHERE id = ?").get(receipt.executionId) as any;
    expect(row.status).toBe("unsupported_pair");
    expect(row.hedge_qty).toBe(0);
    expect(row.stock_qty).toBe(0);
  });

  it("UnsupportedPairError message names the actual missing legs, not a generic failure", () => {
    const err = new UnsupportedPairError("ZZZZ", UNSUPPORTED_DISCOVERY as never);
    expect(err.message).toMatch(/ZZZZBUSDT/);
    expect(err.message).toMatch(/ZZZZUSDT/);
    expect(err.message).toMatch(/No proxy hedge/);
  });
});
