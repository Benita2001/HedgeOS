/**
 * Minimal exact fixed-point arithmetic for order sizing. Plain JS `number`
 * math (float64) accumulates rounding error and, worse, `Math.round`/`Math.floor`
 * on a float division can silently round UP a quantity that should round down
 * (the exact bug fixed in Milestone 1 — see git history on snapDownToStep).
 * BigInt division truncates toward zero, which for the non-negative values
 * used here IS floor — and it is exact, not an approximation of floor.
 *
 * Scale: 1e8 (8 decimal places) — enough headroom for USD cents and typical
 * equity/crypto quantity precision (exchange stepSize as fine as 0.00000001).
 * No external decimal library dependency was added; this is intentionally
 * small and scoped to what the sizing engine actually needs.
 */
export const SCALE = 100_000_000n; // 1e8

/** Converts a JS number (already the boundary where float imprecision can enter) to a scaled BigInt. */
export function toScaled(n: number): bigint {
  // Round at the boundary once, here — every subsequent operation is exact BigInt math.
  return BigInt(Math.round(n * 1e8));
}

export function fromScaled(b: bigint): number {
  return Number(b) / 1e8;
}

export function mulScaled(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

/** Truncates toward zero — exact floor for non-negative operands, never rounds up. */
export function divScaledFloor(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("division by zero in scaled decimal arithmetic");
  return (a * SCALE) / b;
}

/**
 * Floors `rawScaled` down to the nearest multiple of `stepScaled` — the exact
 * BigInt equivalent of the exchange's stepSize/lot-size rounding rule.
 */
export function floorToStep(rawScaled: bigint, stepScaled: bigint): bigint {
  if (stepScaled <= 0n) return rawScaled;
  const units = rawScaled / stepScaled; // BigInt division truncates toward zero == floor for non-negative values
  return units * stepScaled;
}
