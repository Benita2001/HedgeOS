export type Frequency = "daily" | "weekly" | "monthly";

/**
 * Floor for `interval_minutes`. Tied to a real technical constraint, not a
 * demo number: the worker only ever checks for due cycles once per tick
 * (`HEDGEOS_TICK_MS`, default 60000ms = 1 minute — see src/worker/index.ts),
 * so a cadence shorter than one worker tick couldn't be observed any more
 * often than the tick itself allows, regardless of what's configured. A
 * strategy is free to run at the worker's own tick granularity (1 minute)
 * or any whole-minute multiple of it — "every 10 minutes" is just one
 * caller-supplied value among infinitely many valid ones, nothing special.
 */
export const MIN_INTERVAL_MINUTES = 1;

export function assertValidIntervalMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES) {
    throw new Error(
      `intervalMinutes must be a whole number >= ${MIN_INTERVAL_MINUTES} (the worker's own tick granularity) — got ${minutes}.`,
    );
  }
}

/**
 * Deterministic cadence math, all in UTC to match SQLite's datetime('now').
 * No calendar-approximation shortcuts (e.g. "30 days" for monthly) — this
 * uses real calendar month arithmetic so a monthly strategy lands on the
 * same day-of-month (subject to short-month clamping by JS Date itself).
 *
 * `intervalMinutes`, when given, is a generic whole-minute cadence override
 * that takes precedence over `frequency` entirely (frequency is then kept
 * only for backward-compatible display/informational purposes on that
 * strategy row) — this is what makes "every 10 minutes," "every 90
 * minutes," or any other user-configured interval possible without any
 * cadence value being hardcoded anywhere in this function.
 */
export function addCadence(date: Date, frequency: Frequency, intervalMinutes?: number | null): Date {
  const d = new Date(date.getTime());
  if (intervalMinutes != null) {
    assertValidIntervalMinutes(intervalMinutes);
    d.setUTCMinutes(d.getUTCMinutes() + intervalMinutes);
    return d;
  }
  if (frequency === "daily") {
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (frequency === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d;
}
