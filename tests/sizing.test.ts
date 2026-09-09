import { describe, expect, it } from "vitest";
import { sizeDcaHedgeContribution, sizeHedgeLeg, sizeStockLeg } from "../src/engine/sizing.js";
import { DEFAULT_POLICY, type SymbolFilters } from "../src/engine/types.js";

// Filters modeled on the live NVDABUSDT (spot bStock) and NVDAUSDT
// (TRADIFI_PERPETUAL) exchangeInfo pulled during Phase 0 validation.
const STOCK_FILTERS: SymbolFilters = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
const HEDGE_FILTERS: SymbolFilters = { stepSize: 0.01, minQty: 0.01, minNotional: 5 };
const PRICE = 233; // ~NVDA reference price at Phase 0 validation time

describe("90/10 contribution split", () => {
  it("allocates exactly 90% to stock budget and 10% to hedge budget, from the contribution only", () => {
    const result = sizeDcaHedgeContribution(100, PRICE, STOCK_FILTERS, HEDGE_FILTERS, DEFAULT_POLICY);
    expect(result.stock.budgetUsd).toBeCloseTo(90, 6);
    expect(result.hedge.hedgeBudgetUsd).toBeCloseTo(10, 6);
  });

  it("is independent of any portfolio/account balance — same contribution always yields the same split", () => {
    const a = sizeDcaHedgeContribution(100, PRICE, STOCK_FILTERS, HEDGE_FILTERS, DEFAULT_POLICY);
    const b = sizeDcaHedgeContribution(100, PRICE, STOCK_FILTERS, HEDGE_FILTERS, DEFAULT_POLICY);
    expect(a.stock.budgetUsd).toEqual(b.stock.budgetUsd);
    expect(a.hedge.hedgeBudgetUsd).toEqual(b.hedge.hedgeBudgetUsd);
  });

  it("rejects a policy whose fractions do not sum to 1", () => {
    expect(() =>
      sizeDcaHedgeContribution(100, PRICE, STOCK_FILTERS, HEDGE_FILTERS, {
        stockFraction: 0.9,
        hedgeFraction: 0.2,
        hedgeLeverage: 2,
      }),
    ).toThrow();
  });
});

describe("hedge leverage policy (2x default, 3x optional, nothing above 3x)", () => {
  it("targets short notional = hedgeBudget * 2 at the default leverage", () => {
    const hedge = sizeHedgeLeg(10, 2, PRICE, HEDGE_FILTERS);
    expect(hedge.targetShortNotionalUsd).toBeCloseTo(20, 6);
    expect(hedge.executable).toBe(true);
    expect(hedge.actualCollateralUsd).toBeLessThanOrEqual(10);
  });

  it("targets short notional = hedgeBudget * 3 at the optional leverage", () => {
    const hedge = sizeHedgeLeg(10, 3, PRICE, HEDGE_FILTERS);
    expect(hedge.targetShortNotionalUsd).toBeCloseTo(30, 6);
    expect(hedge.executable).toBe(true);
    expect(hedge.actualCollateralUsd).toBeLessThanOrEqual(10);
  });

  it("rejects any leverage above 3x", () => {
    expect(() => sizeHedgeLeg(10, 4, PRICE, HEDGE_FILTERS)).toThrow(/3x/);
    expect(() => sizeHedgeLeg(10, 10, PRICE, HEDGE_FILTERS)).toThrow();
  });

  it("rejects leverage values outside the approved set (e.g. 1x, 2.5x)", () => {
    expect(() => sizeHedgeLeg(10, 1, PRICE, HEDGE_FILTERS)).toThrow();
    expect(() => sizeHedgeLeg(10, 2.5, PRICE, HEDGE_FILTERS)).toThrow();
  });

  it("never lets actual collateral used exceed the hedge budget, at either approved leverage", () => {
    for (const leverage of [2, 3] as const) {
      const hedge = sizeHedgeLeg(10, leverage, PRICE, HEDGE_FILTERS);
      if (hedge.executable) {
        expect(hedge.actualCollateralUsd).toBeLessThanOrEqual(10 + 1e-9);
      }
    }
  });
});

describe("minimum order / exchange filter enforcement", () => {
  it("does not execute the stock leg when snapped notional is below minNotional", () => {
    const stock = sizeStockLeg(0.5, PRICE, STOCK_FILTERS); // $0.50 budget, far below $5 min notional
    expect(stock.executable).toBe(false);
    expect(stock.reason).toMatch(/minNotional/);
    expect(stock.quantity).toBe(0);
  });

  it("does not execute the hedge leg when target notional snaps below minNotional", () => {
    // Tiny contribution -> tiny hedge budget -> even at 3x, notional stays under $5.
    const hedge = sizeHedgeLeg(0.5, 3, PRICE, HEDGE_FILTERS); // target = $1.50
    expect(hedge.executable).toBe(false);
    expect(hedge.quantity).toBe(0);
  });

  it("rounds order quantities down to the permitted step, never up past budget", () => {
    const hedge = sizeHedgeLeg(10, 2, PRICE, HEDGE_FILTERS); // target $20 / 233 = 0.0858...
    // stepSize 0.01 -> snapped quantity must be a clean multiple of 0.01 and <= raw
    const raw = 20 / PRICE;
    expect(hedge.quantity).toBeLessThanOrEqual(raw + 1e-9);
    expect(Math.round(hedge.quantity * 100)).toBeCloseTo(hedge.quantity * 100, 6);
  });
});

describe("deferred hedge budget (never dropped, never oversized, never re-leveraged)", () => {
  it("reports the full hedge budget as deferred when the leg cannot execute", () => {
    const hedge = sizeHedgeLeg(0.5, 2, PRICE, HEDGE_FILTERS);
    expect(hedge.executable).toBe(false);
    expect(hedge.deferredBudgetUsd).toBeCloseTo(0.5, 6);
  });

  it("reports only the unused remainder as deferred when the leg does execute", () => {
    const hedge = sizeHedgeLeg(10, 2, PRICE, HEDGE_FILTERS);
    expect(hedge.executable).toBe(true);
    expect(hedge.deferredBudgetUsd).toBeCloseTo(10 - hedge.actualCollateralUsd, 6);
    expect(hedge.deferredBudgetUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("partial fill / rounding behavior", () => {
  it("stock leg never uses more notional than its budget allows, even after snapping", () => {
    const stock = sizeStockLeg(90, PRICE, STOCK_FILTERS);
    expect(stock.notionalUsd).toBeLessThanOrEqual(90 + 1e-9);
  });

  it("hedge leg's actual short notional is always <= target short notional (rounds down, never up)", () => {
    const hedge = sizeHedgeLeg(10, 3, PRICE, HEDGE_FILTERS);
    expect(hedge.actualShortNotionalUsd).toBeLessThanOrEqual(hedge.targetShortNotionalUsd + 1e-9);
  });
});

describe("insufficient funds", () => {
  it("marks both legs non-executable for a contribution too small to clear any exchange minimum", () => {
    const result = sizeDcaHedgeContribution(1, PRICE, STOCK_FILTERS, HEDGE_FILTERS, DEFAULT_POLICY);
    expect(result.stock.executable).toBe(false);
    expect(result.hedge.executable).toBe(false);
  });
});

describe("no routine price-driven rebalancing", () => {
  it("sizing depends only on (contribution, price, filters, policy) — never on a prior position or NAV argument", () => {
    // Structural guarantee: the function signature itself has no portfolio/NAV
    // parameter, so a price move between two calls cannot make it emit a
    // "rebalancing" trade — each call is an independent, per-contribution sizing.
    expect(sizeDcaHedgeContribution.length).toBeLessThanOrEqual(5);
    const before = sizeDcaHedgeContribution(100, 200, STOCK_FILTERS, HEDGE_FILTERS, DEFAULT_POLICY);
    const afterPriceMove = sizeDcaHedgeContribution(100, 260, STOCK_FILTERS, HEDGE_FILTERS, DEFAULT_POLICY);
    // Budgets (USD allocation) are identical regardless of price — only quantities differ.
    expect(before.stock.budgetUsd).toEqual(afterPriceMove.stock.budgetUsd);
    expect(before.hedge.hedgeBudgetUsd).toEqual(afterPriceMove.hedge.hedgeBudgetUsd);
  });
});

describe("REAL CASE, 2026-09-08 23:55 UTC — a real live cycle's hedge deferred despite the pre-trade preview showing both legs executable", () => {
  // Not a bug — this test exists to lock in and document the exact, verified mechanism, using
  // the real numbers from the real cycle (NVDA, $34 contribution, 2x, main account):
  //
  // Preview (before the trade): contribution $34, price $225.53 -> hedge budget $3.40,
  // target notional $6.80, quantity 0.03, actual notional $6.77 -> EXECUTABLE.
  //
  // Live mode re-derives the hedge budget from the ACTUAL stock fill notional, not the
  // pre-trade estimate (src/worker/runContribution.ts) — the real fill came in at $30.45
  // (0.135 @ $225.52), a completely ordinary ~$0.15 difference from the preview's estimate.
  // That alone was enough to cross a step-size rounding boundary and produce a DIFFERENT,
  // non-executable result — not because of any float/rounding bug (this engine uses exact
  // BigInt fixed-point arithmetic throughout), but because $34 was chosen as the bare
  // calculated minimum, with zero safety margin above the threshold.
  const HEDGE_FILTERS_REAL: SymbolFilters = { stepSize: 0.01, minQty: 0.01, minNotional: 5 };
  const REAL_MARK_PRICE = 225.58715797;

  it("re-deriving the hedge budget from the ACTUAL $30.45 stock fill (not the $30.60 pre-trade estimate) correctly floors the quantity DOWN a full step, below the exchange minimum", () => {
    const actualStockFillNotionalUsd = 30.45;
    const actualHedgeBudgetUsd = Math.round(actualStockFillNotionalUsd * (0.1 / 0.9) * 100) / 100;
    expect(actualHedgeBudgetUsd).toBe(3.38); // matches the real receipt's hedge.budgetUsd exactly

    const result = sizeHedgeLeg(actualHedgeBudgetUsd, 2, REAL_MARK_PRICE, HEDGE_FILTERS_REAL);
    expect(result.targetShortNotionalUsd).toBe(6.76); // matches the real receipt exactly
    // The engine computes an internal snapped quantity of 0.02 (notional $4.51, mentioned in
    // `reason`) purely to explain WHY the leg is rejected — since it's below minNotional, the
    // OUTPUT-facing quantity/notional are correctly zeroed (nothing will ever be submitted),
    // exactly matching the real receipt's requestedQty=0/requestedNotionalUsd=0.
    expect(result.quantity).toBe(0);
    expect(result.actualShortNotionalUsd).toBe(0);
    expect(result.reason).toMatch(/\$4\.51 is below exchange minNotional \$5/); // the internal $4.51 computation, preserved for the human-readable explanation
    expect(result.executable).toBe(false); // below the real $5 exchange minimum — correctly deferred, never forced through
    expect(result.deferredBudgetUsd).toBe(3.38); // the full budget is preserved for a future cycle, never dropped
  });

  it("the SAME $3.40 nominal (pre-trade-estimate) budget WOULD have cleared the minimum — proving this is a real-fill-vs-estimate boundary effect, not a general engine defect", () => {
    const nominalPreTradeHedgeBudgetUsd = 3.40; // 10% of the full $34 contribution, before re-deriving from the actual fill
    const result = sizeHedgeLeg(nominalPreTradeHedgeBudgetUsd, 2, REAL_MARK_PRICE, HEDGE_FILTERS_REAL);
    expect(result.quantity).toBe(0.03);
    expect(result.actualShortNotionalUsd).toBeCloseTo(6.77, 2);
    expect(result.executable).toBe(true); // confirms the preview's own math was correct at the time it ran — the outcome changed only because the real fill differed slightly from the estimate
  });

  it("never oversizes to force execution: 0.03 shares would exceed the $6.76 budget-derived target, so the engine floors to 0.02, not up to 0.03", () => {
    const targetNotional = 3.38 * 2; // 6.76
    const costOfNextStepUp = 0.03 * REAL_MARK_PRICE;
    expect(costOfNextStepUp).toBeGreaterThan(targetNotional); // proves 0.03 would have been an overshoot — flooring to 0.02 was the only budget-respecting choice
  });
});
