# HedgeOS

A persistent, autonomous protected-DCA agent for Binance stock/bStock investments. You say "invest $250 into AAPL every week"; HedgeOS splits each new contribution 90% into the stock and 10% into a hedge collateral budget, sizes both legs against live exchange filters with exact fixed-point arithmetic, and keeps doing this on schedule — as a standing service, not a chat session that stops when you close the laptop.

Built for the Binance Agent OS Mini Hackathon (Track A).

## Status — read this before anything else below

| Capability | Status |
|---|---|
| Persistent worker, restart-safe idempotent scheduling | ✅ **Real, running, tested.** Deployed on a VPS independent of any laptop/chat session. |
| Deterministic sizing engine (90/10 split, 2×/3× leverage, exact BigInt arithmetic) | ✅ **Real, tested.** Generic across ticker/amount — see "Generic, not a demo" below. |
| Live instrument discovery (authoritative identity, not naming-pattern guessing) | ✅ **Real, tested against live Binance data.** |
| Paper execution (partial-fill/rejection modeling) | ✅ **Real, tested.** Every paper fill is explicitly labeled `simulated`. |
| Binance Agent OS MCP integration | ✅ **Real, verified with actual tool calls this session** — operator-side evidence layer, session-bound (no headless auth exists for it). See `docs/AGENT_OS_OPERATOR_WORKFLOW.md`. |
| HedgeOS's own MCP server (Claude Code) | ✅ **Real, smoke-tested end-to-end** against the actual server subprocess. |
| HedgeOS's own MCP server (Codex) | ✅ **Tested, working — verified 2026-09-08.** Real `codex exec` session, real MCP tool calls (`list_strategies`, `get_strategy_status`), real correct results. See `docs/OPERATOR_GUIDE.md`. |
| Official Binance Skill (`binance`, a `binance-cli` wrapper — separate from the Agent OS MCP server) | ⚠️ **Installed, command surface inspected from source — not execution-verified.** Real `npx skills add` install (security-reviewed, Snyk: Med Risk, disclosed not hidden); its Futures reference docs confirm it can structurally target `NVDAUSDT`/`TRADIFI_PERPETUAL`, independently corroborating `EXECUTION_ROUTE_DECISION.md`. Its own `binance-cli` binary/installer was never run and no command was ever invoked through it — deliberately not wired into HedgeOS (would duplicate `liveExecution.ts`'s already-tested native code). See `docs/BINANCE_SKILLS_HUB_ASSESSMENT.md`. |
| Live-execution adapter (real signing, order placement, reconciliation) | ✅ **Real code, mock-tested (28+ tests against a fake HTTP client, zero real network calls).** Fail-closed behind a 4-condition gate that nothing in this repo sets. **No real order has ever been placed.** |
| Real authenticated preflight against a live account | ✅ **Actually run once, this session**, against the founder's own real (rotated, least-privilege) key — 10/10 read-only checks passed. See `LIVE_TRADING_READINESS.md`. |
| Live orders | ❌ **Never placed.** Blocked on funding ($0 in both wallets as of the last check) and your explicit per-order authorization. |
| Funding-readiness check for any user's own account | ✅ **Real, tested**, read-only. `check_funding_readiness` MCP tool / `docs/FUNDING_READINESS.md`. |
| Automatic Spot→Futures funding transfer | ⚠️ **Real code, mock-tested (34 tests, zero real network calls), wired into the recurring lifecycle (`ExecutionAdapter.prepareFunding`), gated separately from live trading.** Defaults to `prefunded` (no transfer ever attempted); `auto` mode requires an explicit per-cycle cap plus a separate runtime gate. Shared-wallet reservation derived for real from durable DB state (`getReservedFuturesUsd`) — concurrent strategies can't double-count the same collateral. **Never executed against a real account.** `enableInternalTransfer` is now confirmed `true` on the real credential (verified this session) — funding, not permissions, is what's left. See `docs/FUNDING_READINESS.md`. |
| Self-hosted install for a second, independent user | ✅ **Deploy tooling is generic** (parameterized by `HEDGEOS_DEPLOY_HOST`, no hardcoded IP/paths — verified by grep this session). `docs/SELF_HOSTED_INSTALL.md`. |
| Multi-tenant hosting (many users, one shared instance) | ❌ **Not built.** Architecture documented in `docs/MULTI_TENANT_ARCHITECTURE.md` — explicitly a design sketch, not a claim of implementation. |
| Natural-language strategy proposals: any amount, any cadence ("...every 10 minutes"), finite duration ("...for six months") | ✅ **Workflow documented** (`docs/OPERATOR_GUIDE.md`) and **cadence + duration enforcement are real and tested**: `strategies.interval_minutes` (generic whole-minute cadence, overrides `frequency`, 1-minute documented floor tied to the worker's own tick granularity — not any specific demo value) and `strategies.end_at` (optional end date), both migration-tested against a pre-existing database, both enforced deterministically by the scheduler (`ensureDueCycles`) — no cycle ever created past `end_at`, missed-cycle catch-up correctly capped near any boundary, a schedule ending never touches accumulated positions. The AI extracts intent and computes concrete values; only the deterministic engine enforces them — not independent LLM reasoning about trading decisions. |
| Full recurring live lifecycle (due cycle → stock order → reconciliation → re-derived hedge sizing → hedge order → reconciliation → receipt → next cycle) | ✅ **Real code, integration-tested** across two consecutive cycles with a live-shaped mock adapter (`tests/liveLifecycle.test.ts`) — proves a mid-lifecycle failure in one cycle doesn't corrupt an earlier cycle's real fill or block future scheduling. Still gated: no real order has ever been placed. |

Full evidence, checkpoint by checkpoint: `PROGRESS_LOG.md`.

## The observe → decide → act → verify loop

1. **Observe**: live discovery against Binance's own classification fields (not naming patterns) — `src/binance/client.ts`. Optionally corroborated by a real Binance Agent OS MCP observation, evidence-only (`src/observations/externalObservation.ts`).
2. **Decide**: deterministic sizing (`src/engine/sizing.ts`) — exact BigInt fixed-point math, no LLM anywhere in this path, generic across ticker/amount/leverage.
3. **Act**: `PaperExecutionAdapter` (real, always-on) or `LiveExecutionAdapter` (real code, gated inert) places the order — `src/binance/execution.ts`.
4. **Verify**: independent reconciliation against actual trade data (never trusting an order-placement response alone), durable receipts, and a stock-filled/hedge-failed safety net that survives a thrown exception without losing a real fill's record (`src/worker/runContribution.ts`).

This loop runs unattended, on a schedule, in a persistent worker process — not inside any interactive AI session. The AI (Claude Code, Codex, or a human) is the **operator**, layered on top via MCP, for proposing/inspecting/pausing strategies — never in the money-math path.

## Generic, not a demo

Contribution amounts, tickers, schedules, and leverage are all user-supplied, with no hardcoded product minimum, no fixed demo amount, and no NVDA-specific code path — verified this session by grepping `src/` for hardcoded dollar figures/ticker special-casing (none found) and by `tests/contributionSizeSweep.test.ts` (10 tests sweeping $5 through $1,000,000) and `tests/fundingReadiness.test.ts`. The $34–$40 numbers that appear in `LIVE_TRADING_READINESS.md` are **one proposed human-approved test configuration**, not a product limit — see that document's own explicit statement to this effect.

## Architecture

```
src/
  engine/       deterministic sizing (90/10 split, 2x/3x leverage, exact BigInt fixed-point math) — no LLM, no network
    decimal.ts  exact fixed-point arithmetic (avoids float rounding bugs in order sizing)
  binance/
    client.ts          public market-data discovery: validates a ticker's bStock + TradFi-perp pair against
                        Binance's own classification fields, not naming patterns
    execution.ts        ExecutionAdapter interface; PaperExecutionAdapter (always-on, real); getExecutionAdapter()
                         constructs LiveExecutionAdapter only after the full live-trading gate passes
    liveSigning.ts,
    liveRequests.ts,
    liveHttp.ts          HMAC signing, signed-request builders, a real (but only ever gate-reachable) HTTP
                          transport, and order reconciliation — pure/testable, mock-tested, fail-closed
    liveExecution.ts      the real live adapter: idempotent placement, ambiguous-outcome recovery (query before
                           ever retrying), leverage/margin verification (reads back real account state, refuses
                           to place an order if it doesn't match — see LIVE_TRADING_READINESS.md §9), preflight
    fundingReadiness.ts    compares a proposed contribution's real sizing requirement against actual account
                           balances — pure function, generic across ticker/amount
  observations/  cross-checks operator-supplied Binance Agent OS observations against HedgeOS's own live
                 discovery — evidence only, never a sizing input (src/observations/externalObservation.ts)
  db/           SQLite schema + access (strategies, executions, receipts, cycles) — single-tenant today
  scheduler/    cadence math + idempotent due-cycle lifecycle (pending -> in_progress -> completed/
                failed_retryable/failed_terminal), crash recovery, optional end_at enforcement
                (no cycle created past it, inclusive boundary, missed-cycle catch-up correctly capped)
  worker/       runContribution.ts (observe -> decide -> act -> verify, one contribution) +
                index.ts (the actual persistent process: reconciles on boot, ticks on an interval)
  risk/         deterministic risk alerts (missing hedge exposure, stale schedule, reconciliation
                discrepancy, static margin-headroom note) — never triggers automatic rebalancing
  mcp/          HedgeOS's own MCP server — operator interface for Claude Code / Codex / any MCP client
  dashboard/    minimal read-only Express dashboard (strategy, positions, risk alerts, cycle history)
```

## Running it

```bash
npm install
npm test              # 182 tests
npx tsc --noEmit       # typecheck
```

**One-off paper demo** (real live market data, simulated fill, no order placed):
```bash
npx tsx scripts/paper-demo.ts NVDA 100 2     # ticker, contribution $, leverage — any valid values work, this is just an example
```

**Persistent worker** (the actual autonomous service):
```bash
npx tsx scripts/seed-strategy.ts AAPL 250 2 weekly   # create a strategy, due immediately for demo
HEDGEOS_MODE=paper npx tsx src/worker/index.ts       # runs until Ctrl+C; restart-safe, won't double-execute
```

**HedgeOS MCP server** — see `docs/OPERATOR_GUIDE.md` (both clients) and `docs/MCP_SETUP.md` (Claude Code detail):
```bash
claude mcp add hedgeos --transport stdio -- npx tsx src/mcp/server.ts
```

**Combined Binance Agent OS + HedgeOS MCP demo** (real Agent OS observations + real HedgeOS sizing + paper execution):
```bash
npx tsx scripts/agent-os-integration-demo.ts
```

**Real read-only live-account preflight** (needs your own credentials, never through chat — see `docs/LIVE_PREFLIGHT_SETUP.md`):
```bash
npx tsx scripts/live-preflight.ts AAPL
```

**Dashboard** (read-only, labels PAPER MODE prominently):
```bash
HEDGEOS_MODE=paper npx tsx src/dashboard/server.ts   # http://localhost:8766
```

**Self-hosted deploy** (your own VPS, not the founder's):
```bash
export HEDGEOS_DEPLOY_HOST=root@<your-host>
./deploy/deploy.sh
```

## Product policy (frozen — see `PROJECT_PLAN.md`)

- 90% of each contribution buys the stock/bStock; 10% is the hedge collateral budget.
- The split is per contribution, never based on total account balance or portfolio NAV.
- Hedge leverage: 2x default, 3x optional, nothing higher in P0. Never raised to force an order past the exchange minimum.
- The hedge is an exact matching short TradFi perpetual — no proxy hedging, no substitute instrument, ever, without a separate explicit policy change.
- Ordinary price movement never triggers routine hedge-ratio rebalancing. New contributions are the normal trigger for adding hedge exposure.
- A hedge budget too small to clear the exchange minimum is deferred and accumulated — never dropped, never force-executed below the floor.
- Paper fills are always explicitly labeled simulated. Real market data does not make a simulated fill live.
- Isolated margin is not treated as a guaranteed maximum-loss cap (funding fees, liquidation fee, and gap risk are real) — a contribution budget is a capital budget, not a promised ceiling.

## Key design decisions worth knowing before reading the code

1. **Sizing uses exact BigInt fixed-point arithmetic** (`src/engine/decimal.ts`), not native float math — a real rounding bug was caught and fixed during development. See `PROGRESS_LOG.md` checkpoint 1.
2. **Instrument discovery validates identity, not naming convention.** The futures leg must carry Binance's own `underlyingType: EQUITY` + `underlyingSubType: ["TradFi"]` classification; the spot leg's `baseAsset` must exactly equal `<TICKER>B`; both are cross-checked against each other.
3. **Idempotency is a database-level compare-and-swap.** `claimCycle()`'s `UPDATE ... WHERE status IN ('pending','failed_retryable')` only succeeds once per due slot, regardless of restarts, overlapping ticks, or a concurrent MCP-triggered manual run. Proven end-to-end, not just unit-tested.
4. **A thrown error can never silently lose a real fill.** A genuine defect found and fixed this session: an exception from the hedge leg's placement used to propagate out of `runContribution` before the database write, meaning a real, exchange-confirmed stock fill could vanish with zero record. Fixed and regression-tested (`tests/runContribution.test.ts`).
5. **Configuration is verified, not trusted.** Setting leverage/margin type gets read back and checked against the real account before an order is ever placed — found necessary this session when a real test account turned out to default to 20×/Cross on a never-before-configured symbol.
6. **Live execution stays gated, not just "off by default."** Four independent conditions, checked separately, none set by anything in this repo — see `LIVE_TRADING_READINESS.md` §5.

## What this is not

Not a chatbot — the AI proposes and confirms, it doesn't compute money math. Not a guarantee of downside protection, a continuous 10% hedge ratio, or a maximum-loss cap. Not (yet) connected to real money. Not multi-tenant. Not verified against Codex.

## Documents

- `PROJECT_PLAN.md` — product policy, Phase 0 research findings, critical demo path
- `EXECUTION_ROUTE_DECISION.md` — why the hedge leg uses direct REST rather than Agent OS MCP (which doesn't expose Futures order tools)
- `LIVE_TRADING_READINESS.md` — exact prerequisites, verified API contracts, real preflight results, the proposed (not-yet-approved) minimal live-test budget
- `PROGRESS_LOG.md` — full checkpoint-by-checkpoint evidence log
- `docs/MCP_SETUP.md` — connecting the HedgeOS MCP server to Claude Code
- `docs/OPERATOR_GUIDE.md` — reusable operator workflow for any MCP client, natural-language strategy proposals
- `docs/AGENT_OS_OPERATOR_WORKFLOW.md` — how Binance Agent OS MCP and HedgeOS's own MCP work together
- `docs/FUNDING_READINESS.md` — funding-readiness checks, future auto-transfer requirements
- `docs/SELF_HOSTED_INSTALL.md` — generic install path for a second, independent user
- `docs/MULTI_TENANT_ARCHITECTURE.md` — design sketch for future multi-user hosting (not implemented)
- `docs/LIVE_PREFLIGHT_SETUP.md` — secure per-user credential onboarding
- `docs/INTEGRATION_SURFACES.md` — the four distinct integration surfaces, and why they're kept separate
- `docs/BINANCE_SKILLS_HUB_ASSESSMENT.md` — official Binance Skills Hub research: what was installed, inspected, and why nothing was wired into HedgeOS's own execution path
