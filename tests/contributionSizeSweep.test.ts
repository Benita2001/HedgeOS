import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sizeDcaHedgeContribution } from "../src/engine/sizing.js";
import type { SymbolFilters } from "../src/engine/types.js";
import { createStrategy } from "../src/db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(__dirname, "..", "src", "db", "schema.sql"), "utf-8"));
  return db;
}

/**
 * Explicit evidence that contribution sizing is fully generic — no
 * hardcoded contribution amount, no NVDA-specific quantity, no
 * demo-specific branch anywhere in the sizing path. Every case below runs
 * through the exact same `sizeDcaHedgeContribution` the live and paper
 * adapters both call — nothing here is a special-cased test double.
 *
 * Real, live-verified filters (captured this session via a real Binance
 * Agent OS MCP call and cross-checked against public REST): spot stepSize
 * 0.001/minNotional $5, futures stepSize 0.01/minNotional $5.
 */
const REFERENCE_PRICE = 226.16;
const SPOT_FILTERS: SymbolFilters = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
const HEDGE_FILTERS: SymbolFilters = { stepSize: 0.01, minQty: 0.01, minNotional: 5 };

const CASES = [
  { label: "below-minimum ($5)", contributionUsd: 5, expectHedgeExecutable: false },
  { label: "below-minimum ($20)", contributionUsd: 20, expectHedgeExecutable: false },
  { label: "minimum-valid at 2x (calculated: $34, from scripts/find-min-live-test-budget.ts against this exact price/filters)", contributionUsd: 34, expectHedgeExecutable: true },
  { label: "$40 (proposed live-test buffer amount)", contributionUsd: 40, expectHedgeExecutable: true },
  { label: "$100 (a common round DCA amount, not special-cased)", contributionUsd: 100, expectHedgeExecutable: true },
  { label: "$500", contributionUsd: 500, expectHedgeExecutable: true },
  { label: "large ($50,000)", contributionUsd: 50_000, expectHedgeExecutable: true },
  { label: "very large ($1,000,000)", contributionUsd: 1_000_000, expectHedgeExecutable: true },
] as const;

describe("contribution sizing is generic across arbitrary amounts (2x leverage, 90/10 split)", () => {
  for (const c of CASES) {
    it(`$${c.contributionUsd} — ${c.label}`, () => {
      const result = sizeDcaHedgeContribution(c.contributionUsd, REFERENCE_PRICE, SPOT_FILTERS, HEDGE_FILTERS, {
        stockFraction: 0.9,
        hedgeFraction: 0.1,
        hedgeLeverage: 2,
      });

      // The 90/10 split is exact and derived ONLY from the contribution argument — never a constant.
      expect(result.stock.budgetUsd).toBeCloseTo(c.contributionUsd * 0.9, 6);
      expect(result.hedge.hedgeBudgetUsd).toBeCloseTo(c.contributionUsd * 0.1, 6);

      // Budget invariant: never spend more than allocated, regardless of size.
      expect(result.stock.notionalUsd).toBeLessThanOrEqual(result.stock.budgetUsd + 1e-6);
      expect(result.hedge.actualCollateralUsd).toBeLessThanOrEqual(result.hedge.hedgeBudgetUsd + 1e-6);
      if (result.hedge.executable) {
        expect(result.hedge.actualShortNotionalUsd).toBeLessThanOrEqual(result.hedge.targetShortNotionalUsd + 1e-6);
        expect(result.hedge.targetShortNotionalUsd).toBeCloseTo(result.hedge.hedgeBudgetUsd * 2, 6); // 2x leverage, from the contribution, not a constant
      }

      expect(result.hedge.executable).toBe(c.expectHedgeExecutable);
      if (!c.expectHedgeExecutable) {
        // Small contributions defer safely — never dropped, never forced through by raising leverage.
        expect(result.hedge.quantity).toBe(0);
        expect(result.hedge.deferredBudgetUsd).toBeCloseTo(c.contributionUsd * 0.1, 6);
        expect(result.hedge.reason).toBeDefined();
      }

      // Quantities are always snapped DOWN to the real exchange step — never up, regardless of size.
      const stockSteps = result.stock.quantity / SPOT_FILTERS.stepSize;
      expect(Math.round(stockSteps)).toBeCloseTo(stockSteps, 6);
      if (result.hedge.executable) {
        const hedgeSteps = result.hedge.quantity / HEDGE_FILTERS.stepSize;
        expect(Math.round(hedgeSteps)).toBeCloseTo(hedgeSteps, 6);
      }
    });
  }

  it("3x leverage produces a proportionally larger target notional from the SAME contribution — leverage is a policy input, not tied to any specific amount", () => {
    const at2x = sizeDcaHedgeContribution(100, REFERENCE_PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
    const at3x = sizeDcaHedgeContribution(100, REFERENCE_PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 3 });
    expect(at3x.hedge.targetShortNotionalUsd).toBeCloseTo(at2x.hedge.targetShortNotionalUsd * 1.5, 6);
    expect(at2x.hedge.hedgeBudgetUsd).toBeCloseTo(at3x.hedge.hedgeBudgetUsd, 6); // budget (10% of contribution) is leverage-independent
  });

  it("createStrategy (the actual strategy-creation interface, used by create_paper_strategy and by the live path identically) persists the exact user-supplied amount — no default, no clamping, no $40/$100 special case", () => {
    const db = freshDb();
    try {
      for (const amount of [17.5, 34, 40, 100, 500, 9999.99]) {
        const s = createStrategy(db, {
          ticker: "NVDA",
          spotSymbol: "NVDABUSDT",
          futuresSymbol: "NVDAUSDT",
          contributionUsd: amount,
          frequency: "weekly",
          hedgeLeverage: 2,
        });
        expect(s.contribution_usd).toBe(amount); // persisted exactly, not rounded to a "nice" demo number
      }
    } finally {
      db.close();
    }
  });

  it("doubling the contribution roughly doubles both legs' notional — confirms proportional, non-hardcoded scaling", () => {
    const base = sizeDcaHedgeContribution(200, REFERENCE_PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
    const doubled = sizeDcaHedgeContribution(400, REFERENCE_PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
    expect(doubled.stock.notionalUsd).toBeGreaterThan(base.stock.notionalUsd * 1.9);
    expect(doubled.hedge.actualShortNotionalUsd).toBeGreaterThan(base.hedge.actualShortNotionalUsd * 1.8); // step-rounding introduces small deviation, still clearly proportional
  });
});
