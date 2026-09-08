export type Frequency = "daily" | "weekly" | "monthly";

/**
 * Deterministic cadence math, all in UTC to match SQLite's datetime('now').
 * No calendar-approximation shortcuts (e.g. "30 days" for monthly) — this
 * uses real calendar month arithmetic so a monthly strategy lands on the
 * same day-of-month (subject to short-month clamping by JS Date itself).
 */
export function addCadence(date: Date, frequency: Frequency): Date {
  const d = new Date(date.getTime());
  if (frequency === "daily") {
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (frequency === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d;
}
