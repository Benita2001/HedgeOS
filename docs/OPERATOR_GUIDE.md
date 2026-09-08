# HedgeOS Operator Guide — for Claude Code, Codex, or any MCP client

This is the reusable instruction set for an AI coding agent (or a human) operating a HedgeOS instance on behalf of its owner. It assumes HedgeOS is already installed and its worker is running somewhere (see `docs/VPS_DEPLOYMENT.md` for a worked example, or run it locally per `README.md`) — this guide is about the **operator interface** (HedgeOS's own MCP server, `src/mcp/server.ts`), not about building HedgeOS itself.

## Client compatibility

| Client | Status | How |
|---|---|---|
| **Claude Code** | **Tested, working.** Real end-to-end evidence: `scripts/mcp-smoke-test.ts` (spawns the actual server, drives it as a real MCP client) and this project's own build sessions, which used exactly this connection. | `claude mcp add hedgeos --transport stdio -- npx tsx src/mcp/server.ts` — see `docs/MCP_SETUP.md` |
| **Codex CLI** | **Documented, NOT verified in this project.** HedgeOS's MCP server is a standard `@modelcontextprotocol/sdk` stdio server with no Claude-specific behavior, and Codex CLI's own documentation describes stdio MCP server support via a `[mcp_servers.*]` block in `~/.codex/config.toml` — the connection mechanics are the same to a standards-compliant server. **No Codex session has actually been run against this server in this repository's history.** Treat the config below as a starting point to test, not a proven-working recipe, until someone actually runs it and the result is logged. | See "Codex setup" below |
| Any other MCP-capable client | Should work the same way (stdio transport, standard tool-call semantics) — genuinely untested here, same caveat as Codex. | Point it at `npx tsx src/mcp/server.ts` (or a remote form, see `docs/MCP_SETUP.md`'s SSH-spawn pattern) |

### Claude Code setup (verified)
```bash
claude mcp add hedgeos --transport stdio -- npx tsx src/mcp/server.ts
```
Then `/mcp` in that session and select `hedgeos`. Full detail, including remote-over-SSH: `docs/MCP_SETUP.md`.

### Codex setup (documented, unverified — test before relying on it)
Add to `~/.codex/config.toml`:
```toml
[mcp_servers.hedgeos]
command = "npx"
args = ["tsx", "src/mcp/server.ts"]
cwd = "/path/to/your/HedgeOS/checkout"
env = { HEDGEOS_DB_PATH = "./data/hedgeos.db", HEDGEOS_MODE = "paper" }
```
Adjust `cwd` to your actual checkout path — there is nothing HedgeOS-specific to configure beyond that. If you run this and it works (or doesn't), please record the result in `PROGRESS_LOG.md` so this status line stops being a guess.

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

1. **Extract the structured fields**: ticker (`AAPL`), contribution (`$250`), frequency (`weekly` — HedgeOS supports `daily`/`weekly`/`monthly` only; reject or ask for clarification on anything else), leverage (unstated → default `2x`, per policy). **"For six months" has no field to hold it** — HedgeOS's schema (`strategies` table) has no end-date/duration/cycle-count column. **Say so explicitly to the user** rather than silently dropping it or pretending it's enforced: "HedgeOS will run this weekly until you pause it — there's no built-in auto-stop after 6 months yet, so you'll need to pause it yourself (or ask me to) around that time." Do not fabricate a duration field or promise automatic expiry.
2. **Call `preview_strategy`** (or `preview_with_agent_os_observations` if you have a live Binance Agent OS MCP connection this session and want to show corroborating evidence) with the extracted `ticker`/`contributionUsd`/`hedgeLeverage`. This runs real live discovery — it will tell you plainly if `AAPL` doesn't have both a matching bStock and TradFi perpetual (no proxy is ever substituted).
3. **Optionally call `check_funding_readiness`** with the same inputs if the operator's account credentials are configured — surface any shortfall now, before the user commits to a schedule they can't fund.
4. **Present a structured proposal back to the user and get explicit confirmation** before doing anything state-changing. Example:
   > "Proposed: AAPL, $250/week, 2× hedge leverage (default). Preview shows $225 → AAPL stock, $25 → hedge collateral (target $50 short notional). No end date is enforced — you'll need to pause this yourself when you're done. Confirm to activate?"
5. **Only after explicit confirmation**, call `create_paper_strategy` (in paper mode — this is always paper unless the separate, much more involved live-trading gate in `LIVE_TRADING_READINESS.md` has been deliberately passed by the account owner).
6. Report back the created strategy's `id`, and mention `get_strategy_status` / `list_receipts` as how to check on it later.

**Every number in steps 2–5 is computed by the deterministic sizing engine (`src/engine/sizing.ts`) from the user's own stated contribution — nothing here is hardcoded to any demo amount, and nothing here lets the AI's own judgment override the 90/10 split, the leverage policy, or the exchange-filter-based sizing.** The AI's role is intent extraction and proposal presentation; the money math is not delegated to it, ever.

## Agent OS integration path (where available)

If the operator's own session has Binance's Agent OS MCP server connected (requires that session's own interactive browser OAuth — see `docs/INTEGRATION_SURFACES.md` §1), it can be used to fetch corroborating market observations and pass them into `preview_with_agent_os_observations`. This is **evidence only** — HedgeOS's own live discovery is what actually sizes the order, regardless of what Agent OS reports (see `docs/AGENT_OS_OPERATOR_WORKFLOW.md` for the full mechanics and why). **Do not assume every client/session has Agent OS connected** — it is optional, session-bound, and the operator workflow above works completely without it (steps 2–6 don't require it).

## Risk monitoring

`get_strategy_status` includes `riskAlerts` (from `src/risk/checks.ts`): missing hedge exposure (deferred budget accumulating), stale schedule, execution/reconciliation discrepancies, and a static (explicitly non-live) leverage-headroom note. Check this periodically for any strategy you're operating, and surface alerts to the user — don't just report "it's running."

## What this guide does not cover

Installing HedgeOS itself (`README.md`), deploying the persistent worker (`docs/VPS_DEPLOYMENT.md`, `docs/SELF_HOSTED_INSTALL.md`), or the live-trading account-onboarding process (`LIVE_TRADING_READINESS.md`). This guide is specifically the operator/MCP-client layer.
