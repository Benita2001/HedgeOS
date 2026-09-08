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
  hasScheduleEnded,
} from "../db/index.js";
import { ALLOWED_HEDGE_LEVERAGES, DEFAULT_HEDGE_LEVERAGE } from "../engine/types.js";
import { evaluateRiskAlerts, type LatestExecutionSummary } from "../risk/checks.js";
import { previewContribution } from "../worker/preview.js";
import { ExternalObservationSchema, validateExternalObservation } from "../observations/externalObservation.js";
import { ensureDueCycles, getPendingAndRetryableCycles, claimCycle, processCycle } from "../scheduler/cycles.js";
import { MIN_INTERVAL_MINUTES } from "../scheduler/cadence.js";
import { getExecutionAdapter } from "../binance/execution.js";
import { evaluateFundingReadiness } from "../binance/fundingReadiness.js";

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
    return textResult({
      strategy,
      scheduleEnded: hasScheduleEnded(strategy),
      paperState,
      riskAlerts,
    });
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

server.registerTool(
  "preview_with_agent_os_observations",
  {
    title: "Preview a strategy, cross-checked against operator-supplied Agent OS observations",
    description:
      "Same dry-run discovery + deterministic sizing as preview_strategy (writes nothing, places no order), PLUS a validation report for zero or more market observations the operator obtained separately (in practice: real read-only calls to Binance's own Agent OS MCP server, made interactively by the operator's own session — this server never calls it, since it has no headless/unattended auth path). Each observation is cross-checked against HedgeOS's OWN independently-fetched live discovery for symbol identity, freshness (<=120s), and price deviation (<=2%). This is a corroboration/evidence report only: the sizing result never reads price off an external observation, accepted or not — sizing is always computed from HedgeOS's own live discoverPair() call, so no externally-supplied or LLM-stated price can influence money math.",
    inputSchema: {
      ticker: z.string().min(1),
      contributionUsd: z.number().positive(),
      hedgeLeverage: z.number().refine((n) => (ALLOWED_HEDGE_LEVERAGES as readonly number[]).includes(n), {
        message: `hedgeLeverage must be one of ${ALLOWED_HEDGE_LEVERAGES.join(", ")}`,
      }).default(DEFAULT_HEDGE_LEVERAGE),
      externalObservations: z.array(ExternalObservationSchema).default([]),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ ticker, contributionUsd, hedgeLeverage, externalObservations }) => {
    try {
      const preview = await previewContribution(ticker, contributionUsd, hedgeLeverage);
      const discovery = preview.discovery;
      const observationVerdicts = externalObservations.map((obs) => validateExternalObservation(obs, discovery));
      return textResult({
        ...preview,
        agentOsObservations: observationVerdicts,
        note:
          "sizing is computed exclusively from HedgeOS's own live discoverPair() result (see discovery.spot.price / discovery.futures.markPrice) — agentOsObservations is a source-attributed corroboration report and never feeds the sizing engine, accepted or rejected.",
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  "check_funding_readiness",
  {
    title: "Check funding readiness for a proposed contribution",
    description:
      "Compares what a proposed contribution actually requires (via the same deterministic sizing engine every execution path uses) against the operator's OWN real account balances — Spot USDT for the stock leg, Futures USDT margin for the hedge leg — and reports a shortfall, if any. Read-only: makes only GET account-balance calls, places no order, changes no leverage/margin, and is completely independent of HEDGEOS_MODE=live (works, and is meant to be run, long before that gate could ever pass). Requires BINANCE_API_KEY/BINANCE_API_SECRET in THIS server process's environment; without them, returns a clear 'not configured' result with the sizing preview alone.",
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
      if (!preview.sizing) {
        return textResult({ ticker, contributionUsd, credentialsConfigured: false, funding: undefined, discovery: preview.discovery, note: "instrument pair is not usable — no funding check to run" });
      }

      const apiKey = process.env.BINANCE_API_KEY;
      const apiSecret = process.env.BINANCE_API_SECRET;
      if (!apiKey || !apiSecret) {
        return textResult({
          ticker,
          contributionUsd,
          credentialsConfigured: false,
          sizing: preview.sizing,
          note:
            "BINANCE_API_KEY/BINANCE_API_SECRET are not set in this MCP server's environment — cannot check real balances. This is independent of live-trading mode; setting these two vars alone does NOT enable live trading (see LIVE_TRADING_READINESS.md). See docs/LIVE_PREFLIGHT_SETUP.md for how to install them securely, in your own terminal, never through chat.",
        });
      }

      const { RealLiveHttpClient } = await import("../binance/liveHttp.js");
      const { buildSpotAccountRequest, buildFuturesAccountV3Request } = await import("../binance/liveRequests.js");
      const client = new RealLiveHttpClient();
      const creds = { apiKey, apiSecret };

      const spotAccount = await client.send<{ balances: Array<{ asset: string; free: string }> }>(
        buildSpotAccountRequest({ ...creds, timestamp: Date.now() }),
      );
      const spotAvailableUsd = Number(spotAccount.balances.find((b) => b.asset === "USDT")?.free ?? 0);

      const futuresAccount = await client.send<{ availableBalance?: string }>(buildFuturesAccountV3Request({ ...creds, timestamp: Date.now() }));
      const futuresAvailableUsd = Number(futuresAccount.availableBalance ?? 0);

      const funding = evaluateFundingReadiness({ ticker: preview.ticker, sizing: preview.sizing, spotAvailableUsd, futuresAvailableUsd });
      return textResult({ credentialsConfigured: true, sizing: preview.sizing, funding });
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
      "Creates a new HedgeOS strategy in paper mode: 90% of each contribution buys the bStock, 10% is the hedge collateral budget at the given leverage (2x default, 3x optional, nothing higher). Does not place any order — the first contribution runs on the strategy's own schedule via the persistent worker, or can be triggered manually with trigger_due_cycle. `frequency` is required for backward compatibility, but pass optional `intervalMinutes` (a whole number of minutes, e.g. 10 for 'every 10 minutes') to override it with any generic cadence — the minimum is the worker's own tick granularity (1 minute, not any specific demo value), rejected otherwise with a clear error. Optional endAt (ISO timestamp): if the user said something like 'for six months', compute the concrete end date yourself (now + 6 months) and pass it here — HedgeOS enforces it deterministically (no new cycle is ever scheduled after it; a cycle due exactly on it still runs) but never guesses a duration from vague language on its own. Omit endAt for a strategy that runs indefinitely (the default, unchanged behavior).",
    inputSchema: {
      ticker: z.string().min(1),
      contributionUsd: z.number().positive(),
      frequency: z.enum(["daily", "weekly", "monthly"]),
      hedgeLeverage: z.number().refine((n) => (ALLOWED_HEDGE_LEVERAGES as readonly number[]).includes(n), {
        message: `hedgeLeverage must be one of ${ALLOWED_HEDGE_LEVERAGES.join(", ")}`,
      }).default(DEFAULT_HEDGE_LEVERAGE),
      endAt: z.string().datetime().optional(),
      intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).optional(),
      fundingMode: z.enum(["prefunded", "auto"]).default("prefunded"),
      fundingBufferUsd: z.number().min(0).optional(),
      fundingPerCycleCapUsd: z.number().positive().optional(),
      fundingPeriodCapUsd: z.number().positive().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ ticker, contributionUsd, frequency, hedgeLeverage, endAt, intervalMinutes, fundingMode, fundingBufferUsd, fundingPerCycleCapUsd, fundingPeriodCapUsd }) => {
    const upper = ticker.toUpperCase();
    try {
      const strategy = createStrategy(db, {
        ticker: upper,
        spotSymbol: `${upper}BUSDT`,
        futuresSymbol: `${upper}USDT`,
        contributionUsd,
        frequency,
        hedgeLeverage,
        endAt,
        intervalMinutes,
        fundingMode,
        fundingBufferUsd,
        fundingPerCycleCapUsd,
        fundingPeriodCapUsd,
      });
      return textResult({
        created: strategy,
        note:
          "Paper mode. No order has been placed. The instrument pair will be (re-)validated at each contribution via live discovery." +
          (intervalMinutes ? ` Cadence: every ${intervalMinutes} minute(s), overriding frequency="${frequency}" for scheduling purposes.` : "") +
          (endAt ? ` Schedule ends ${endAt} (inclusive) — no new contribution will be created after that date; accumulated positions are never auto-liquidated when a schedule ends.` : " Runs indefinitely (no endAt given) — pause it yourself when you're done.") +
          (fundingMode === "auto"
            ? ` Funding policy: AUTOMATIC — up to $${fundingPerCycleCapUsd} per cycle may be transferred Spot->Futures to cover the hedge collateral shortfall (buffer $${fundingBufferUsd ?? 0}${fundingPeriodCapUsd ? `, period cap $${fundingPeriodCapUsd}` : ""}). This ALSO requires the separate HEDGEOS_FUNDING_MODE/HEDGEOS_AUTO_FUNDING_CONFIRMED runtime gate to be set before any real transfer occurs — creating this strategy alone does not authorize one.`
            : " Funding policy: PREFUNDED (default) — you top up the Futures wallet yourself; HedgeOS only reports shortfalls, never transfers automatically."),
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
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

    const adapter = await getExecutionAdapter();
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
