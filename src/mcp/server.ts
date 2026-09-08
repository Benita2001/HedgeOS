import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  openDb,
  createStrategy,
  listStrategies,
  getStrategy,
  listActiveStrategies,
  pauseStrategy,
  resumeStrategy,
  listExecutions,
  listReceipts,
  getPaperState,
  getLatestExecution,
} from "../db/index.js";
import { ALLOWED_HEDGE_LEVERAGES, DEFAULT_HEDGE_LEVERAGE } from "../engine/types.js";
import { evaluateRiskAlerts, type LatestExecutionSummary } from "../risk/checks.js";
import { previewContribution } from "../worker/preview.js";
import { ensureDueCycles, getPendingAndRetryableCycles, claimCycle, processCycle } from "../scheduler/cycles.js";
import { getExecutionAdapter } from "../binance/execution.js";

/**
 * HedgeOS-owned MCP server: an operator interface onto the SAME persistent
 * SQLite database the worker (src/worker/index.ts) reads and writes. This
 * process does not run the worker itself and does not need the worker
 * running to answer read queries — it operates on durable state, not on an
 * in-memory session. State-changing tools here go through the exact same
 * idempotent claim/execute path (scheduler/cycles.ts, runContribution.ts)
 * the worker uses, so a manual trigger from here and a scheduled tick from
 * the worker can never double-execute the same due slot.
 *
 * Paper-mode only: this server never enables LiveExecutionAdapter and has
 * no tool that could place a live order. That gate is separate and has not
 * passed (see LIVE_TRADING_READINESS.md).
 */

const db = openDb();
const server = new McpServer({ name: "hedgeos", version: "0.1.0" });

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

// ---------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------

server.registerTool(
  "list_strategies",
  {
    title: "List strategies",
    description: "Lists all HedgeOS strategies (active and paused), with their configured contribution, frequency, and hedge leverage.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => textResult(listStrategies(db)),
);

server.registerTool(
  "get_strategy_status",
  {
    title: "Get strategy status",
    description:
      "Full status for one strategy: config, accumulated paper position (from actual fills, not planned amounts), deferred hedge budget, and current deterministic risk alerts.",
    inputSchema: { strategyId: z.number().int().positive() },
    annotations: { readOnlyHint: true },
  },
  async ({ strategyId }) => {
    const strategy = getStrategy(db, strategyId);
    if (!strategy) return errorResult(`no strategy with id ${strategyId}`);
    const paperState = getPaperState(db, strategyId);
    const latest = getLatestExecution(db, strategyId) as unknown as LatestExecutionSummary | undefined;
    const riskAlerts = evaluateRiskAlerts(strategy, paperState, latest);
    return textResult({ strategy, paperState, riskAlerts });
  },
);

server.registerTool(
  "list_recent_cycles",
  {
    title: "List recent scheduled cycles",
    description: "Lists recent due-cycle lifecycle records (pending/in_progress/completed/failed_retryable/failed_terminal) for a strategy, most recent first.",
    inputSchema: { strategyId: z.number().int().positive(), limit: z.number().int().positive().max(200).default(20) },
    annotations: { readOnlyHint: true },
  },
  async ({ strategyId, limit }) => {
    const rows = db
      .prepare("SELECT * FROM cycles WHERE strategy_id = ? ORDER BY id DESC LIMIT ?")
      .all(strategyId, limit);
    return textResult(rows);
  },
);

server.registerTool(
  "list_receipts",
  {
    title: "List receipts",
    description: "Lists durable execution receipts (per-leg: requested vs filled quantity/notional, fees, order status). Filter by executionId, or omit for the most recent receipts across all strategies.",
    inputSchema: { executionId: z.number().int().positive().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ executionId }) => textResult(listReceipts(db, executionId)),
);

server.registerTool(
  "list_executions",
  {
    title: "List executions",
    description: "Lists execution records (one per attempted contribution cycle) for a strategy, most recent first, including status (completed/unsupported_pair/partial_failure).",
    inputSchema: { strategyId: z.number().int().positive() },
    annotations: { readOnlyHint: true },
  },
  async ({ strategyId }) => textResult(listExecutions(db, strategyId)),
);

server.registerTool(
  "preview_strategy",
  {
    title: "Preview a strategy (dry run)",
    description:
      "Runs live instrument discovery + the deterministic sizing engine for a proposed contribution WITHOUT creating a strategy, writing to the database, or placing any order. Use this to show a user exactly what a contribution would do before they commit.",
    inputSchema: {
      ticker: z.string().min(1),
      contributionUsd: z.number().positive(),
      hedgeLeverage: z.number().refine((n) => (ALLOWED_HEDGE_LEVERAGES as readonly number[]).includes(n), {
        message: `hedgeLeverage must be one of ${ALLOWED_HEDGE_LEVERAGES.join(", ")}`,
      }).default(DEFAULT_HEDGE_LEVERAGE),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ ticker, contributionUsd, hedgeLeverage }) => {
    try {
      const preview = await previewContribution(ticker, contributionUsd, hedgeLeverage);
      return textResult(preview);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

// ---------------------------------------------------------------------------
// State-changing tools (paper mode only — no live trading is reachable here)
// ---------------------------------------------------------------------------

server.registerTool(
  "create_paper_strategy",
  {
    title: "Create a paper strategy",
    description:
      "Creates a new HedgeOS strategy in paper mode: 90% of each contribution buys the bStock, 10% is the hedge collateral budget at the given leverage (2x default, 3x optional, nothing higher). Does not place any order — the first contribution runs on the strategy's own schedule via the persistent worker, or can be triggered manually with trigger_due_cycle.",
    inputSchema: {
      ticker: z.string().min(1),
      contributionUsd: z.number().positive(),
      frequency: z.enum(["daily", "weekly", "monthly"]),
      hedgeLeverage: z.number().refine((n) => (ALLOWED_HEDGE_LEVERAGES as readonly number[]).includes(n), {
        message: `hedgeLeverage must be one of ${ALLOWED_HEDGE_LEVERAGES.join(", ")}`,
      }).default(DEFAULT_HEDGE_LEVERAGE),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ ticker, contributionUsd, frequency, hedgeLeverage }) => {
    const upper = ticker.toUpperCase();
    const strategy = createStrategy(db, {
      ticker: upper,
      spotSymbol: `${upper}BUSDT`,
      futuresSymbol: `${upper}USDT`,
      contributionUsd,
      frequency,
      hedgeLeverage,
    });
    return textResult({ created: strategy, note: "Paper mode. No order has been placed. The instrument pair will be (re-)validated at each contribution via live discovery." });
  },
);

server.registerTool(
  "pause_strategy",
  {
    title: "Pause a strategy",
    description: "Pauses a strategy: the scheduler will not create or execute any new due cycles for it until resumed. Already-pending cycles are unaffected.",
    inputSchema: { strategyId: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ strategyId }) => {
    const strategy = pauseStrategy(db, strategyId);
    if (!strategy) return errorResult(`no strategy with id ${strategyId}`);
    return textResult(strategy);
  },
);

server.registerTool(
  "resume_strategy",
  {
    title: "Resume a strategy",
    description: "Resumes a paused strategy. Its schedule continues from wherever next_due_at was left — it does not retroactively create a backlog beyond the normal missed-cycle catch-up cap.",
    inputSchema: { strategyId: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ strategyId }) => {
    const strategy = resumeStrategy(db, strategyId);
    if (!strategy) return errorResult(`no strategy with id ${strategyId}`);
    return textResult(strategy);
  },
);

server.registerTool(
  "trigger_due_cycle",
  {
    title: "Trigger a due paper cycle now",
    description:
      "Manually runs the SAME due-cycle detection and idempotent claim/execute path the persistent worker uses, for one strategy, right now — for demos, not a substitute for the schedule. If nothing is due yet, reports that and does nothing. If the worker process is also running and races this call, the idempotency claim guarantees only one of them actually executes. Paper mode only — never places a live order.",
    inputSchema: { strategyId: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ strategyId }) => {
    const strategy = getStrategy(db, strategyId);
    if (!strategy) return errorResult(`no strategy with id ${strategyId}`);
    if (strategy.status !== "active") return errorResult(`strategy ${strategyId} is ${strategy.status}, not active`);

    const adapter = getExecutionAdapter();
    if (adapter.mode !== "paper") {
      return errorResult("refusing: execution adapter is not in paper mode (HEDGEOS_MODE must be 'paper' for this MCP server)");
    }

    ensureDueCycles(db, strategy, new Date());
    const due = getPendingAndRetryableCycles(db).filter((c) => c.strategy_id === strategyId);
    if (due.length === 0) {
      return textResult({ triggered: false, reason: "no due or retryable cycle for this strategy right now" });
    }

    const claimed = claimCycle(db, due[0].id);
    if (!claimed) {
      return textResult({ triggered: false, reason: "cycle was claimed by another process (e.g. the running worker) between listing and claiming — this is the idempotency guard working as intended" });
    }

    const receipt = await processCycle(db, claimed, strategy, adapter);
    return textResult({ triggered: true, receipt });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[HedgeOS MCP] connected via stdio\n");
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[HedgeOS MCP] fatal:", err);
    process.exit(1);
  });
}
