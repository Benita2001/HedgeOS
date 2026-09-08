# HedgeOS Operator Guide — for Claude Code, Codex, or any MCP client

This is the reusable instruction set for an AI coding agent (or a human) operating a HedgeOS instance on behalf of its owner. It assumes HedgeOS is already installed and its worker is running somewhere (see `docs/VPS_DEPLOYMENT.md` for a worked example, or run it locally per `README.md`) — this guide is about the **operator interface** (HedgeOS's own MCP server, `src/mcp/server.ts`), not about building HedgeOS itself.

## Client compatibility

| Client | Status | How |
|---|---|---|
| **Claude Code** | **Tested, working.** Real end-to-end evidence: `scripts/mcp-smoke-test.ts` (spawns the actual server, drives it as a real MCP client) and this project's own build sessions, which used exactly this connection. | `claude mcp add hedgeos --transport stdio -- npx tsx src/mcp/server.ts` — see `docs/MCP_SETUP.md` |
| **Codex CLI** | **Tested, working — verified 2026-09-08.** `codex mcp add hedgeos --env HEDGEOS_MODE=paper --env HEDGEOS_DB_PATH=<abs path> -- npx tsx <abs path>/src/mcp/server.ts`, then `codex exec -s read-only -C <repo>` with a prompt calling `list_strategies` and `get_strategy_status` — real session id `01a0824a-e323-7631-be0c-c5ad5937e245`, both tools returned correct real data (a seeded NVDA strategy, its `scheduleEnded`/`paperState`/`riskAlerts`). No HedgeOS-specific behavior was needed — it's a standard stdio MCP server. | See "Codex setup" below |
| Any other MCP-capable client | Should work the same way (stdio transport, standard tool-call semantics) — genuinely untested here, same caveat as Codex. | Point it at `npx tsx src/mcp/server.ts` (or a remote form, see `docs/MCP_SETUP.md`'s SSH-spawn pattern) |

### Claude Code setup (verified)
```bash
claude mcp add hedgeos --transport stdio -- npx tsx src/mcp/server.ts
```
Then `/mcp` in that session and select `hedgeos`. Full detail, including remote-over-SSH: `docs/MCP_SETUP.md`.

### Codex setup (verified working)
Use Codex's own CLI (`codex mcp add`) rather than hand-editing `~/.codex/config.toml` — it has no `--cwd` flag, so pass **absolute paths** everywhere:
```bash
codex mcp add hedgeos \
  --env HEDGEOS_MODE=paper \
  --env HEDGEOS_DB_PATH=/absolute/path/to/HedgeOS/data/hedgeos.db \
  -- npx tsx /absolute/path/to/HedgeOS/src/mcp/server.ts
```
Then, non-interactively:
```bash
codex exec -s read-only -C /absolute/path/to/HedgeOS "Use the 'hedgeos' MCP server's list_strategies tool..."
```
or in an interactive `codex` session, same as any other configured MCP server. `codex mcp remove hedgeos` to undo.

## Tool inventory (all HedgeOS-owned, see `src/mcp/server.ts` for the source of truth)

**Read-only** — safe to call any time, change nothing:
- `list_strategies`, `get_strategy_status`, `list_recent_cycles`, `list_receipts`, `list_executions`
- `preview_strategy` — dry-run discovery + sizing, no DB write
- `preview_with_agent_os_observations` — same, plus cross-checking operator-supplied Binance Agent OS observations (see "Agent OS integration" below)
- `check_funding_readiness` — compares a proposed contribution's actual sizing requirement against the operator's own real Spot/Futures balances (needs `BINANCE_API_KEY`/`SECRET` in the MCP server's own environment — independent of live-trading mode; see `docs/FUNDING_READINESS.md`)

**State-changing, paper-mode only** (no tool here can reach live trading — see `LIVE_TRADING_READINESS.md` for the live gate, which is entirely separate from this MCP server):
- `create_paper_strategy`, `pause_strategy`, `resume_strategy`, `trigger_due_cycle`

## Turning a natural-language request into a strategy — the actual workflow

A user says something like: **"Invest $250 in Apple every week for six months."**

The operator (you, running in Claude Code/Codex/etc.) should:

1. **Extract the structured fields**: ticker (`AAPL`), contribution (`$250`), cadence, leverage (unstated → default `2x`, per policy), and duration.
   - **Cadence**: `daily`/`weekly`/`monthly` map directly to `frequency`. A finer or unusual cadence — "every 10 minutes," "every 90 minutes," "every 6 hours" — maps to `intervalMinutes` (a whole number of minutes; convert hours/days yourself). `frequency` is still required by the tool schema in that case but is ignored for actual scheduling — pass any value (`"daily"` is a reasonable default) and mention in your proposal that the real cadence is the interval. The minimum is 1 minute (the worker's own tick granularity) — reject or ask for clarification on anything faster, since it's not a policy choice, it's a real technical floor. Nothing about "every 10 minutes" specifically is special-cased anywhere in HedgeOS — it's one arbitrary valid `intervalMinutes` value among infinitely many.
   - **Duration**: **"For six months" maps to `create_paper_strategy`'s optional `endAt` field** (`strategies.end_at` in the schema, added and migration-tested this session): compute the concrete ISO date yourself (now + 6 months) and pass it as `endAt` — **HedgeOS enforces the resulting date deterministically** (the scheduler creates no cycle scheduled after it; a cycle due exactly on it still runs), it does not interpret "six months" itself. State the concrete date back to the user so they can sanity-check your interpretation ("...running through 2027-03-08"). Omitting `endAt` means the strategy runs indefinitely until manually paused — still fully supported, still the default.
2. **Call `preview_strategy`** (or `preview_with_agent_os_observations` if you have a live Binance Agent OS MCP connection this session and want to show corroborating evidence) with the extracted `ticker`/`contributionUsd`/`hedgeLeverage`. This runs real live discovery — it will tell you plainly if `AAPL` doesn't have both a matching bStock and TradFi perpetual (no proxy is ever substituted).
3. **Optionally call `check_funding_readiness`** with the same inputs if the operator's account credentials are configured — surface any shortfall now, before the user commits to a schedule they can't fund.
4. **Present a structured proposal back to the user and get explicit confirmation** before doing anything state-changing. The proposal must state, explicitly: asset, contribution amount, cadence, duration (or "runs indefinitely"), leverage, execution mode (paper, or — only if the account owner has separately completed the live-trading gate — live), and **the funding policy** — separately from execution mode:
   - **Funding policy**: default is `prefunded` — the user tops up the Futures wallet themselves; HedgeOS only ever reports a shortfall (`check_funding_readiness`). **Never propose `auto` funding unless the user has explicitly asked for automatic transfers** — "invest $100" alone is intent about the contribution, not authorization to move money between wallets. If the user does ask for automatic funding, the proposal must state the exact per-cycle cap and buffer you intend to pass as `fundingPerCycleCapUsd`/`fundingBufferUsd` (both required — `create_paper_strategy` itself refuses `fundingMode="auto"` with no cap) and that a **separate runtime gate** (`HEDGEOS_FUNDING_MODE`/`HEDGEOS_AUTO_FUNDING_CONFIRMED`, independent of the live-trading gate) must also be set on the deployment before any real transfer can occur — creating the strategy alone never moves money.
   Examples:
   > "Proposed: AAPL, $250/week, 2× hedge leverage (default), running through 2027-03-08 (six months from today), **paper mode**. Preview shows $225 → AAPL stock, $25 → hedge collateral (target $50 short notional). The last contribution will be on or just before that date; no new one after. Confirm to activate?"

   > "Proposed: NVDA, $5 every 10 minutes, 2× hedge leverage (default), no end date (runs until you pause it), **paper mode**. At $5, the 10% hedge budget ($0.50) is likely below the exchange's $5 minimum notional — expect the hedge leg to defer and accumulate across cycles rather than execute every time (see `check_funding_readiness` / `docs/FUNDING_READINESS.md`). Confirm to activate?"

   **Never infer "live mode" from ambiguous phrasing.** If the user hasn't explicitly said "live" / "with real money" / equivalent, propose paper mode and say so. If they do ask for live mode, state plainly that it additionally requires the account owner to have completed the separate live-trading gate (`LIVE_TRADING_READINESS.md`) — you cannot activate it from a conversation alone.
5. **Only after explicit confirmation**, call `create_paper_strategy` (in paper mode — this is always paper unless the separate, much more involved live-trading gate in `LIVE_TRADING_READINESS.md` has been deliberately passed by the account owner).
6. Report back the created strategy's `id`, and mention `get_strategy_status` / `list_receipts` as how to check on it later.

**Every number in steps 2–5 is computed by the deterministic sizing engine (`src/engine/sizing.ts`) from the user's own stated contribution — nothing here is hardcoded to any demo amount, and nothing here lets the AI's own judgment override the 90/10 split, the leverage policy, or the exchange-filter-based sizing.** The AI's role is intent extraction and proposal presentation; the money math is not delegated to it, ever.

## Agent OS integration path (where available)

If the operator's own session has Binance's Agent OS MCP server connected (requires that session's own interactive browser OAuth — see `docs/INTEGRATION_SURFACES.md` §1), it can be used to fetch corroborating market observations and pass them into `preview_with_agent_os_observations`. This is **evidence only** — HedgeOS's own live discovery is what actually sizes the order, regardless of what Agent OS reports (see `docs/AGENT_OS_OPERATOR_WORKFLOW.md` for the full mechanics and why). **Do not assume every client/session has Agent OS connected** — it is optional, session-bound, and the operator workflow above works completely without it (steps 2–6 don't require it).

## Risk monitoring

`get_strategy_status` includes `riskAlerts` (from `src/risk/checks.ts`): missing hedge exposure (deferred budget accumulating), stale schedule, execution/reconciliation discrepancies, and a static (explicitly non-live) leverage-headroom note. Check this periodically for any strategy you're operating, and surface alerts to the user — don't just report "it's running."

## What this guide does not cover

Installing HedgeOS itself (`README.md`), deploying the persistent worker (`docs/VPS_DEPLOYMENT.md`, `docs/SELF_HOSTED_INSTALL.md`), or the live-trading account-onboarding process (`LIVE_TRADING_READINESS.md`). This guide is specifically the operator/MCP-client layer.
