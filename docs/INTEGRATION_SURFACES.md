# HedgeOS — The Four Distinct Integration Surfaces

This document exists because it is easy to conflate these and easy to overstate what's actually connected to what. None of the below is aspirational — every claim here matches the verified state as of 2026-09-08 14:35 UTC.

## 1. Binance Agent OS MCP server (`agent.binance.com/mcp/agentic`)
Binance's own MCP server. Requires interactive browser OAuth consent — confirmed via official docs (`developers.binance.com`) to have **no headless, service-account, or refresh-token authentication method**. Compatible clients are explicitly interactive tools (Claude, Claude Code, Codex, ChatGPT, VS Code), not unattended servers.

**Status**: connected and verified in this session (2026-09-08, 14:26–14:35 UTC). Real read-only tool calls were made and their results captured verbatim — `spot_tickerPrice(NVDABUSDT)` -> `228.11`, `spot_exchangeInfo(NVDABUSDT)` -> `baseAsset: "NVDAB"`/TRADING/minNotional 5, `futures_usds_symbolPriceTicker(NVDAUSDT)` -> `227.85`, `futures_usds_exchangeInformation` (full dump, filtered to `NVDAUSDT`) -> `contractType: "TRADIFI_PERPETUAL"`, `underlyingType: "EQUITY"`, `underlyingSubType: ["TradFi"]`, TRADING. These are session-bound: the connection required this session's own interactive OAuth consent and does not persist to any other process. Nothing in the persistent worker's runtime import graph calls it — its role is strictly **operator-side**, formalized in `docs/AGENT_OS_OPERATOR_WORKFLOW.md`: an interactive session obtains source-attributed observations from Agent OS and passes them to HedgeOS's own `preview_with_agent_os_observations` MCP tool (surface 2), which independently re-verifies instrument identity and price against public REST before any sizing occurs — the Agent OS observation itself never reaches the sizing engine.

## 2. HedgeOS's own operator MCP server (`src/mcp/server.ts`)
Built by this project, unrelated to Binance's server beyond using the same MCP protocol. Exposes the **running persistent service's** state (strategies, positions, receipts, risk alerts) and a narrow set of paper-mode actions (create/pause/resume/trigger) to any MCP client — in practice, Claude Code, reaching it over the existing SSH connection to the VPS.

**Status**: real, deployed, verified — see `PROGRESS_LOG.md` checkpoints 4, 7 and 8. `trigger_due_cycle` goes through the exact same idempotent claim path as the scheduler itself, so an operator action and a scheduled tick can never double-execute. As of checkpoint 8 it also exposes `preview_with_agent_os_observations`, the one tool that accepts input from surface 1 — as evidence to cross-check, never as a sizing input (see `docs/AGENT_OS_OPERATOR_WORKFLOW.md`).

## 3. Public Binance REST (`api.binance.com`, `fapi.binance.com`)
What the persistent worker actually uses for every market observation: symbol discovery (`src/binance/client.ts`), live prices, contract filters. No authentication, no session, no OAuth to expire — which is exactly why it's the only viable foundation for something that must run unattended for weeks.

**Status**: real, live, this is what every paper execution in this project has actually been priced against.

## 4. Disabled live Futures REST adapter (`src/binance/liveSigning.ts`, `liveRequests.ts`)
Pure, unit-tested request-signing and order-reconciliation functions for the *official authenticated* Binance Futures REST API (not Agent OS, not MCP — direct HMAC-signed REST, the same API a live Agent OS trade tool would itself ultimately call under the hood). Confirmed via `grep` to be unreachable from any runtime path — the worker, dashboard, and MCP server never import these modules. `LiveExecutionAdapter` throws unconditionally regardless.

**Status**: exists and is tested against fixtures/fake credentials only. No real credentials exist anywhere in this project. See `LIVE_TRADING_READINESS.md` for the human-only prerequisites still blocking this.

## Why this separation is the honest design, not a workaround
An agent that must run continuously and independently of any laptop or chat session cannot be built on an authentication method that has no headless mode — that's a fact about Agent OS today, not a limitation HedgeOS invented. The persistent service (surfaces 3 and, if ever authorized, 4) is deliberately Agent-OS-independent. Agent OS's real, supported role in this architecture is surface 1: an optional, session-bound enhancement to the **operator** experience, layered on top of — never underneath — the autonomous service.
