import type Database from "better-sqlite3";
import type { ExecutionAdapter } from "../binance/execution.js";
import type { StrategyRow } from "../db/index.js";
import { runContribution, type StructuredReceipt } from "../worker/runContribution.js";
import { addCadence } from "./cadence.js";

/** Cap on how many missed due-slots a single ensureDueCycles call will backfill for one strategy. */
export const MAX_CATCHUP_CYCLES = 12;

export type CycleStatus = "pending" | "in_progress" | "completed" | "failed_retryable" | "failed_terminal";

export interface CycleRow {
  id: number;
  strategy_id: number;
  scheduled_for: string;
  idempotency_key: string;
  status: CycleStatus;
  attempt_count: number;
  execution_id: number | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * Creates any missing due-slot rows for a strategy, from its current
 * next_due_at up through `now`, and advances next_due_at past them. Uses
 * INSERT OR IGNORE against the UNIQUE idempotency_key, so calling this
 * twice for the same slot (overlapping ticks, a restart before next_due_at
 * was persisted, etc.) creates at most one row — never a duplicate.
 * Capped at MAX_CATCHUP_CYCLES per call so a long-neglected schedule can't
 * flood the table in one tick; remaining backlog is picked up on the next
 * call(s), since next_due_at only advances past the slots actually created.
 */
export function ensureDueCycles(db: Database.Database, strategy: StrategyRow, now: Date = new Date()): number[] {
  const created: number[] = [];
  let dueAt = new Date(strategy.next_due_at.replace(" ", "T") + (strategy.next_due_at.endsWith("Z") ? "" : "Z"));
  let count = 0;

  // Inclusive boundary: a cycle scheduled exactly at end_at still runs (e.g.
  // "every week for six months" includes the contribution due on the
  // six-month mark itself). A cycle scheduled after end_at is never
  // created — checked per-iteration below, so this also correctly bounds
  // missed-cycle catch-up near the end date (never catches up PAST it) and
  // is unaffected by pause/resume (a paused strategy isn't ticked at all —
  // see listActiveStrategies) or by restart (reconcileInProgressCycles
  // only resolves already-created cycles, it never creates new ones).
  const endAt = strategy.end_at ? new Date(strategy.end_at) : null;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO cycles (strategy_id, scheduled_for, idempotency_key) VALUES (?, ?, ?)`,
  );

  while (dueAt.getTime() <= now.getTime() && count < MAX_CATCHUP_CYCLES && (!endAt || dueAt.getTime() <= endAt.getTime())) {
    const scheduledForIso = dueAt.toISOString();
    const idempotencyKey = `${strategy.id}:${scheduledForIso}`;
    const info = insert.run(strategy.id, scheduledForIso, idempotencyKey);
    if (info.changes > 0) {
      created.push(Number(info.lastInsertRowid));
    }
    dueAt = addCadence(dueAt, strategy.frequency);
    count++;
  }

  if (count > 0) {
    db.prepare("UPDATE strategies SET next_due_at = ? WHERE id = ?").run(dueAt.toISOString(), strategy.id);
  }
  return created;
}

/**
 * Atomically claims a cycle for execution: pending/failed_retryable -> in_progress.
 * The UPDATE's WHERE clause is the compare-and-swap — if another tick (or a
 * leftover process) already claimed or finished this cycle, `changes` is 0
 * and this returns null. This is what makes double-execution structurally
 * impossible regardless of restarts, overlapping ticks, or repeated calls.
 */
export function claimCycle(db: Database.Database, cycleId: number): CycleRow | null {
  const info = db
    .prepare(
      `UPDATE cycles SET status = 'in_progress', started_at = datetime('now'), attempt_count = attempt_count + 1
       WHERE id = ? AND status IN ('pending', 'failed_retryable')`,
    )
    .run(cycleId);
  if (info.changes !== 1) return null;
  return db.prepare("SELECT * FROM cycles WHERE id = ?").get(cycleId) as CycleRow;
}

export function getPendingAndRetryableCycles(db: Database.Database): CycleRow[] {
  return db
    .prepare("SELECT * FROM cycles WHERE status IN ('pending', 'failed_retryable') ORDER BY scheduled_for")
    .all() as CycleRow[];
}

/**
 * Classifies a thrown error as retryable (transient — network/upstream
 * trouble, safe to attempt again later) or terminal (won't succeed by
 * retrying the same inputs — a bug, a validation failure, a config error).
 * Conservative by design: anything not recognizably transient is terminal,
 * so HedgeOS never blindly loops retrying an error it doesn't understand.
 */
export function classifyError(err: unknown): "retryable" | "terminal" {
  const message = err instanceof Error ? err.message : String(err);
  const retryablePattern = /network|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|Binance API error 5\d\d/i;
  return retryablePattern.test(message) ? "retryable" : "terminal";
}

/**
 * Runs one already-claimed cycle through the existing runContribution path
 * and durably records the outcome. Lifecycle state is written before
 * execution (claimCycle, called by the caller) and after (here) — a crash
 * between those two points leaves a cycle in 'in_progress', which
 * reconcileInProgressCycles resolves on the next startup rather than ever
 * being silently re-run as if nothing happened.
 */
export async function processCycle(
  db: Database.Database,
  cycle: CycleRow,
  strategy: StrategyRow,
  adapter: ExecutionAdapter,
): Promise<StructuredReceipt> {
  try {
    const receipt = await runContribution(db, strategy, adapter, cycle.id);

    if (receipt.status === "completed") {
      db.prepare(
        `UPDATE cycles SET status = 'completed', execution_id = ?, completed_at = datetime('now'), last_error = NULL WHERE id = ?`,
      ).run(receipt.executionId, cycle.id);
    } else if (receipt.status === "partial_failure") {
      // One leg filled (or partially filled) and the other was rejected.
      // This is deliberately terminal for automatic retry: re-running the
      // cycle would double the leg that already executed. It needs a human
      // (or a dedicated single-leg reconciliation feature, not built here)
      // to look at the receipt and decide what to do — never a blind replay.
      db.prepare(
        `UPDATE cycles SET status = 'failed_terminal', execution_id = ?, completed_at = datetime('now'),
         last_error = 'partial cycle failure — one leg executed and one was rejected; needs manual review, not auto-retry' WHERE id = ?`,
      ).run(receipt.executionId, cycle.id);
    } else {
      // unsupported_pair: an execution row exists (recording the attempt),
      // but this cycle cannot succeed by retrying the same ticker, so it is
      // terminal. A future strategy edit or a later scheduled cycle can
      // reattempt discovery independently — this specific slot does not.
      db.prepare(
        `UPDATE cycles SET status = 'failed_terminal', execution_id = ?, completed_at = datetime('now'), last_error = ? WHERE id = ?`,
      ).run(receipt.executionId, "unsupported instrument pair", cycle.id);
    }
    return receipt;
  } catch (err) {
    const kind = classifyError(err);
    const status: CycleStatus = kind === "retryable" ? "failed_retryable" : "failed_terminal";
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE cycles SET status = ?, last_error = ?, completed_at = datetime('now') WHERE id = ?`).run(
      status,
      message,
      cycle.id,
    );
    throw err;
  }
}

/**
 * Startup recovery for cycles left 'in_progress' by a process that died
 * mid-execution. Never assumes success and never blindly replays: it looks
 * for an execution row created at/after the cycle's claim time for that
 * strategy. If one exists, the contribution actually ran — link it and mark
 * the cycle by that execution's real outcome. If none exists, nothing was
 * persisted, so it is genuinely safe to retry — marked failed_retryable,
 * not completed, and not silently forgotten.
 */
export function reconcileInProgressCycles(db: Database.Database): CycleRow[] {
  const stuck = db.prepare("SELECT * FROM cycles WHERE status = 'in_progress'").all() as CycleRow[];
  const resolved: CycleRow[] = [];

  for (const cycle of stuck) {
    const candidateExecution = db
      .prepare(
        `SELECT * FROM executions WHERE strategy_id = ? AND ts >= ? ORDER BY id ASC LIMIT 1`,
      )
      .get(cycle.strategy_id, cycle.started_at) as { id: number; status: string } | undefined;

    if (candidateExecution) {
      const finalStatus: CycleStatus = candidateExecution.status === "completed" ? "completed" : "failed_terminal";
      db.prepare(
        `UPDATE cycles SET status = ?, execution_id = ?, completed_at = datetime('now'),
         last_error = 'recovered after interrupted process: matched an existing execution record' WHERE id = ?`,
      ).run(finalStatus, candidateExecution.id, cycle.id);
    } else {
      db.prepare(
        `UPDATE cycles SET status = 'failed_retryable', completed_at = datetime('now'),
         last_error = 'recovered after interrupted process: no execution record found, safe to retry' WHERE id = ?`,
      ).run(cycle.id);
    }
    resolved.push(db.prepare("SELECT * FROM cycles WHERE id = ?").get(cycle.id) as CycleRow);
  }

  return resolved;
}
