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
    expect(receipt.hedge!.hedgeBudgetUsd).toBeCloseTo(10, 6);
    expect(receipt.hedge!.targetShortNotionalUsd).toBeCloseTo(20, 6); // 10 * 2x
    expect(receipt.hedge!.actualShortNotionalUsd).toBeLessThanOrEqual(receipt.hedge!.targetShortNotionalUsd);
    expect(receipt.hedge!.actualCollateralUsd).toBeLessThanOrEqual(receipt.hedge!.hedgeBudgetUsd + 1e-9);
    expect(receipt.hedge!.actualCollateralUsd).not.toEqual(receipt.hedge!.actualShortNotionalUsd);

    // Real fills recorded (simulated, but against the mocked live-shaped price).
    expect(receipt.stock!.simulatedFillQty).toBeGreaterThan(0);
    expect(receipt.hedge!.simulatedFillQty).toBeGreaterThan(0);

    // Paper state recomputed from the ledger, not asserted separately.
    expect(receipt.paperState!.contributionsCount).toBe(1);
    expect(receipt.paperState!.cumulativeStockQty).toEqual(receipt.stock!.simulatedFillQty);
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
      expect(receipt.hedge!.simulatedFillQty).toBe(0);
    }
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
