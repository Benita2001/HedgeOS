import { openDb, listActiveStrategies, getStrategy } from "../db/index.js";
import { getExecutionAdapter } from "../binance/execution.js";
import {
  ensureDueCycles,
  getPendingAndRetryableCycles,
  claimCycle,
  processCycle,
  reconcileInProgressCycles,
} from "../scheduler/cycles.js";

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Persistent headless worker: reconciles interrupted cycles from any prior
 * run, then loops on a fixed tick, creating and executing due contributions
 * through the existing runContribution path. This process is what makes
 * HedgeOS an agent rather than a script — it keeps running and making
 * scheduling/state decisions without an open Claude Code or chat session.
 *
 * Live execution (Checkpoint 9): the worker CAN start with HEDGEOS_MODE=live,
 * but only if `assertLiveTradingGate` (liveExecution.ts) passes — real
 * BINANCE_API_KEY/SECRET plus two explicit confirmation env vars
 * (HEDGEOS_LIVE_TRADING_CONFIRMED, HEDGEOS_LIVE_CHECKLIST_COMPLETE). None of
 * those are set in this project's environment or deployment as shipped, so
 * this remains paper-only in practice until a human deliberately sets all
 * four outside of any code here. See LIVE_TRADING_READINESS.md.
 */
export async function startWorker() {
  const db = openDb();
  const adapter = await getExecutionAdapter();
  const tickMs = Number(process.env.HEDGEOS_TICK_MS ?? 5000);

  log(`HedgeOS worker starting. mode=${adapter.mode} tickMs=${tickMs}`);

  const recovered = reconcileInProgressCycles(db);
  if (recovered.length > 0) {
    for (const c of recovered) {
      log(`recovered cycle #${c.id} (strategy ${c.strategy_id}, slot ${c.scheduled_for}) -> ${c.status}`);
    }
  } else {
    log("no interrupted cycles found at startup");
  }

  let tickRunning = false;
  let stopped = false;

  async function tick() {
    if (tickRunning) {
      log("tick skipped: previous tick still running (overlap guard)");
      return;
    }
    tickRunning = true;
    try {
      const now = new Date();
      for (const strategy of listActiveStrategies(db)) {
        const created = ensureDueCycles(db, strategy, now);
        if (created.length > 0) {
          log(`strategy ${strategy.id} (${strategy.ticker}): created ${created.length} due cycle(s)`);
        }
      }

      for (const cycle of getPendingAndRetryableCycles(db)) {
        const claimed = claimCycle(db, cycle.id);
        if (!claimed) {
          log(`cycle #${cycle.id} skipped: already claimed elsewhere (idempotency guard)`);
          continue;
        }
        const strategy = getStrategy(db, claimed.strategy_id);
        if (!strategy) {
          log(`cycle #${claimed.id} has no strategy ${claimed.strategy_id}; leaving as claimed for manual review`);
          continue;
        }
        log(`cycle #${claimed.id} claimed: strategy ${strategy.id} (${strategy.ticker}) slot ${claimed.scheduled_for}`);
        try {
          const receipt = await processCycle(db, claimed, strategy, adapter);
          log(
            `cycle #${claimed.id} -> ${receipt.status} (mode=${receipt.mode}, simulated=${receipt.simulated})`,
          );
        } catch (err) {
          log(`cycle #${claimed.id} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      tickRunning = false;
    }
  }

  await tick();
  const interval = setInterval(() => {
    if (!stopped) void tick();
  }, tickMs);

  function shutdown(signal: string) {
    if (stopped) return;
    stopped = true;
    log(`received ${signal}, stopping (no new cycles will be claimed; in-flight tick finishes)`);
    clearInterval(interval);
    db.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { db, stop: () => shutdown("manual") };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startWorker().catch((err) => {
    console.error("[HedgeOS worker] fatal:", err);
    process.exit(1);
  });
}
