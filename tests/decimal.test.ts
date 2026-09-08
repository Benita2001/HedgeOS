import { describe, expect, it } from "vitest";
import { toScaled, fromScaled, mulScaled, divScaledFloor, floorToStep } from "../src/engine/decimal.js";

describe("decimal.ts — exact fixed-point arithmetic", () => {
  it("round-trips numbers through scaling without drift", () => {
    expect(fromScaled(toScaled(90))).toBe(90);
    expect(fromScaled(toScaled(0.01))).toBe(0.01);
    expect(fromScaled(toScaled(233.2))).toBe(233.2);
  });

  it("floorToStep never rounds up, unlike naive float rounding at a .5 boundary", () => {
    // This is the exact Milestone-1 bug: 20/233 * 100 = 8.583..., which
    // Math.round() would push to 9 (rounding UP) instead of flooring to 8.
    const rawScaled = divScaledFloor(toScaled(20), toScaled(233));
    const snapped = floorToStep(rawScaled, toScaled(0.01));
    expect(fromScaled(snapped)).toBe(0.08); // NOT 0.09
  });

  it("divScaledFloor truncates toward zero exactly, no float division involved", () => {
    const result = divScaledFloor(toScaled(1), toScaled(3));
    // 1/3 = 0.33333333... floored to 8 decimals is 0.33333333, never 0.33333334
    expect(fromScaled(result)).toBe(0.33333333);
  });

  it("mulScaled composes with divScaledFloor without accumulating error over many operations", () => {
    let acc = toScaled(1);
    for (let i = 0; i < 100; i++) {
      acc = mulScaled(acc, toScaled(1.01));
      acc = divScaledFloor(acc, toScaled(1.01));
    }
    // Multiplying and immediately dividing by the same factor 100 times
    // should not drift far from 1 the way repeated float64 ops can.
    expect(fromScaled(acc)).toBeCloseTo(1, 4);
  });

  it("floorToStep is a no-op for a zero or negative step", () => {
    expect(floorToStep(toScaled(5), toScaled(0))).toBe(toScaled(5));
  });
});
