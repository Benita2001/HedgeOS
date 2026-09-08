# HedgeOS — The Four Distinct Integration Surfaces

This document exists because it is easy to conflate these and easy to overstate what's actually connected to what. None of the below is aspirational — every claim here matches the verified state as of 2026-09-08.

## 1. Binance Agent OS MCP server (`agent.binance.com/mcp/agentic`)
Binance's own MCP server. Requires interactive browser OAuth consent — confirmed via official docs (`developers.binance.com`) to have **no headless, service-account, or refresh-token authentication method**. Compatible clients are explicitly interactive tools (Claude, Claude Code, Codex, ChatGPT, VS Code), not unattended servers.

**Status in this project**: not connected in this session. A connection was reportedly established in a separate interactive Claude Code session, but that session is unreachable from here (no working cross-session messaging tool available), so **no real tool call against it has been verified from this codebase or this session**. Nothing in HedgeOS's code calls it. If and when it is connected and verified, its role would be strictly **operator-side**: an interactive session asking Binance directly for market data, account reads, or (with explicit authorization) trade actions — never something the persistent VPS worker depends on, because it structurally cannot authenticate unattended.

## 2. HedgeOS's own operator MCP server (`src/mcp/server.ts`)
Built by this project, unrelated to Binance's server beyond using the same MCP protocol. Exposes the **running persistent service's** state (strategies, positions, receipts, risk alerts) and a narrow set of paper-mode actions (create/pause/resume/trigger) to any MCP client — in practice, Claude Code, reaching it over the existing SSH connection to the VPS.

**Status**: real, deployed, verified — see `PROGRESS_LOG.md` checkpoints 4 and 7. `trigger_due_cycle` goes through the exact same idempotent claim path as the scheduler itself, so an operator action and a scheduled tick can never double-execute.

## 3. Public Binance REST (`api.binance.com`, `fapi.binance.com`)
What the persistent worker actually uses for every market observation: symbol discovery (`src/binance/client.ts`), live prices, contract filters. No authentication, no session, no OAuth to expire — which is exactly why it's the only viable foundation for something that must run unattended for weeks.

**Status**: real, live, this is what every paper execution in this project has actually been priced against.

## 4. Disabled live Futures REST adapter (`src/binance/liveSigning.ts`, `liveRequests.ts`)
Pure, unit-tested request-signing and order-reconciliation functions for the *official authenticated* Binance Futures REST API (not Agent OS, not MCP — direct HMAC-signed REST, the same API a live Agent OS trade tool would itself ultimately call under the hood). Confirmed via `grep` to be unreachable from any runtime path — the worker, dashboard, and MCP server never import these modules. `LiveExecutionAdapter` throws unconditionally regardless.

**Status**: exists and is tested against fixtures/fake credentials only. No real credentials exist anywhere in this project. See `LIVE_TRADING_READINESS.md` for the human-only prerequisites still blocking this.

## Why this separation is the honest design, not a workaround
An agent that must run continuously and independently of any laptop or chat session cannot be built on an authentication method that has no headless mode — that's a fact about Agent OS today, not a limitation HedgeOS invented. The persistent service (surfaces 3 and, if ever authorized, 4) is deliberately Agent-OS-independent. Agent OS's real, supported role in this architecture is surface 1: an optional, session-bound enhancement to the **operator** experience, layered on top of — never underneath — the autonomous service.
