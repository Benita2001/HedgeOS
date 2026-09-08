# Connecting the HedgeOS MCP server to Claude Code

This is HedgeOS's own MCP server (`src/mcp/server.ts`) — separate from and unrelated to Binance's Agent OS MCP server. It exposes the *running HedgeOS service's* state (strategies, positions, receipts, risk alerts) to any MCP client, so Claude Code (or any other client) can inspect and operate HedgeOS without needing to be the process that's actually running the worker.

## What it connects to
The server reads/writes the same SQLite database file the persistent worker (`src/worker/index.ts`) uses (`./data/hedgeos.db` by default, override with `HEDGEOS_DB_PATH`). It does **not** need the worker process running to answer read queries. State-changing tools (`trigger_due_cycle` in particular) go through the identical idempotent claim path the worker uses — verified in `scripts/mcp-smoke-test.ts` that calling it twice back-to-back never double-executes, even if the real worker is also running concurrently against the same DB file.

## Setup (local, stdio transport)
From an interactive Claude Code session, in this repository:

```bash
claude mcp add hedgeos --transport stdio -- npx tsx src/mcp/server.ts
```

Then in that session: `/mcp` → select `hedgeos`. No OAuth, no consent screen — it's a local process you're running yourself, not a third-party service.

To point it at a specific DB file or force paper mode explicitly, set env vars before adding it (or in your shell profile):
```bash
export HEDGEOS_DB_PATH=./data/hedgeos.db
export HEDGEOS_MODE=paper
```

## Tools exposed

**Read-only:**
- `list_strategies` — all strategies, active and paused
- `get_strategy_status` — one strategy's config, accumulated paper position (from actual fills), deferred hedge budget, and current risk alerts
- `list_recent_cycles` — scheduler lifecycle records for a strategy
- `list_receipts` — durable per-leg receipts (requested vs. filled, fees, order status)
- `list_executions` — one row per attempted contribution cycle
- `preview_strategy` — dry-run discovery + sizing against live market data; **writes nothing, places no order**
- `preview_with_agent_os_observations` — same as `preview_strategy`, plus a validation report cross-checking operator-supplied observations (in practice, real reads from Binance's own Agent OS MCP server) against HedgeOS's own live discovery for symbol identity, freshness, and price deviation. The supplied observations are evidence only — sizing always uses HedgeOS's own price. See `docs/AGENT_OS_OPERATOR_WORKFLOW.md`.

**State-changing (all paper-mode only — no tool here can reach live trading):**
- `create_paper_strategy` — creates a strategy row; does not place an order itself
- `pause_strategy` / `resume_strategy`
- `trigger_due_cycle` — runs the exact same due-cycle detection + idempotent claim/execute path the persistent worker uses, for one strategy, right now. Refuses if the execution adapter isn't in paper mode.

## Smoke test (already run, evidence in PROGRESS_LOG.md)
```bash
npx tsx scripts/mcp-smoke-test.ts
```
This spawns the real server as a subprocess (not a mock) and, as a real MCP client: lists tools, previews a strategy against live NVDA market data, creates a strategy, triggers a due cycle, **immediately triggers again to verify it does NOT double-execute**, and confirms `paperState.contributionsCount` is exactly 1 afterward. Uses a disposable test DB (`./data/mcp-smoke-test.db`), cleaned up automatically.

## Boundaries
- This server has no tool that can place a live order, change leverage on a real exchange, or touch credentials. `HEDGEOS_MODE=live` causes `trigger_due_cycle` to refuse outright.
- It is an operator/inspection interface, not the scheduler itself — the persistent worker (`npm run worker`) is what actually keeps due contributions flowing on schedule when no one is watching. Run both for the full autonomous-agent demo: the worker in the background, this MCP server for Claude Code to inspect and manually trigger demo cycles.
