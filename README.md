# HedgeOS

A persistent, autonomous protected-DCA agent for Binance stock/bStock investments. You say "invest $100 into NVDA every day"; HedgeOS splits each new contribution 90% into the stock and 10% into a hedge collateral budget, sizes both legs against live exchange filters with exact fixed-point arithmetic, and keeps doing this on schedule — as a standing service, not a chat session that stops when you close the laptop.

Built for the Binance Agent OS Mini Hackathon (Track A).

## Status (see `PROGRESS_LOG.md` for full evidence)

**Paper mode is real and working end-to-end.** Live trading is deliberately not enabled — see [`LIVE_TRADING_READINESS.md`](LIVE_TRADING_READINESS.md) for exactly what's blocking it and why.

- Persistent worker with restart-safe, idempotent scheduling: ✅ built, tested, demonstrated against real market data.
- Deterministic sizing engine (90/10 split, 2x/3x leverage, exact BigInt arithmetic): ✅ built, tested.
- Live instrument discovery with authoritative bStock/TradFi identity validation (not naming-pattern guessing): ✅ built, tested against real Binance data.
- Paper execution with partial-fill/rejection modeling: ✅ built, tested.
- HedgeOS-owned MCP server for Claude Code to inspect/operate the running service: ✅ built, smoke-tested end-to-end.
- Disabled live-execution signing/reconciliation primitives: ✅ built, unit-tested, **not wired to any runtime path**.
- Live trading: ❌ blocked on human-only prerequisites (bStock/ADGM eligibility, TradFi-Perps agreement, Futures-enabled credential) — see `LIVE_TRADING_READINESS.md`.
- Dashboard: not built yet (deliberately deprioritized behind the autonomous core and operator interface, per plan).

## Architecture

```
src/
  engine/       deterministic sizing (90/10 split, 2x/3x leverage, exact BigInt fixed-point math) — no LLM, no network
  decimal.ts    exact fixed-point arithmetic (avoids float rounding bugs in order sizing)
  binance/
    client.ts        public market-data discovery: validates a ticker's bStock + TradFi-perp pair against
                      Binance's own classification fields, not naming patterns
    execution.ts      ExecutionAdapter interface; PaperExecutionAdapter (simulated fills, injectable
                      partial-fill/rejection/slippage for testing); LiveExecutionAdapter (throws — disabled)
    liveSigning.ts,
    liveRequests.ts   disabled: HMAC signing + signed-request builders + order reconciliation for the real
                      Binance Futures/Spot REST API. Pure functions, unit-tested against fixtures, NOT
                      reachable from any runtime path (grepped and confirmed).
  db/           SQLite schema + access (strategies, executions, receipts, cycles)
  scheduler/    cadence math + idempotent due-cycle lifecycle (pending -> in_progress -> completed/
                failed_retryable/failed_terminal), crash recovery
  worker/       runContribution.ts (observe -> decide -> act -> verify, one contribution) +
                index.ts (the actual persistent process: reconciles on boot, ticks on an interval)
  risk/         deterministic risk alerts (missing hedge exposure, stale schedule, reconciliation
                discrepancy, static margin-headroom note) — never triggers automatic rebalancing
  mcp/          HedgeOS's own MCP server — operator interface for Claude Code
```

## Running it

```bash
npm install
npm test              # 56 tests
npx tsc --noEmit       # typecheck
```

**One-off paper demo** (real live market data, simulated fill, no order placed):
```bash
npx tsx scripts/paper-demo.ts NVDA 100 2     # ticker, contribution $, leverage
```

**Persistent worker** (the actual autonomous service):
```bash
npx tsx scripts/seed-strategy.ts NVDA 100 2 daily   # create a strategy, due immediately for demo
HEDGEOS_MODE=paper npx tsx src/worker/index.ts      # runs until Ctrl+C; restart-safe, won't double-execute
```

**HedgeOS MCP server** (Claude Code operator interface) — see [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md) for full setup:
```bash
claude mcp add hedgeos --transport stdio -- npx tsx src/mcp/server.ts
```

**MCP smoke test** (spawns the real server, drives it as a real client, verifies idempotency):
```bash
npx tsx scripts/mcp-smoke-test.ts
```

## Product policy (frozen — see `PROJECT_PLAN.md`)

- 90% of each contribution buys the stock/bStock; 10% is the hedge collateral budget.
- The split is per contribution, never based on total account balance or portfolio NAV.
- Hedge leverage: 2x default, 3x optional, nothing higher in P0.
- The hedge is an exact matching short TradFi perpetual — no proxy hedging, no substitute instrument, ever, without a separate explicit policy change.
- Ordinary price movement never triggers routine hedge-ratio rebalancing. New contributions are the normal trigger for adding hedge exposure.
- A hedge budget too small to clear the exchange minimum is deferred and accumulated — never dropped, never force-executed below the floor, never compensated for by silently raising leverage.
- Paper fills are always explicitly labeled simulated. Real market data does not make a simulated fill live.

## Key design decisions worth knowing before reading the code

1. **Sizing uses exact BigInt fixed-point arithmetic** (`src/engine/decimal.ts`), not native float math — a real rounding bug (round-to-nearest instead of floor, occasionally rounding a quantity UP past budget) was caught and fixed during development. See `PROGRESS_LOG.md` checkpoint 1.
2. **Instrument discovery validates identity, not naming convention.** A symbol matching the constructed string `<TICKER>BUSDT` is not accepted on name alone — the futures leg must carry Binance's own `underlyingType: EQUITY` + `underlyingSubType: ["TradFi"]` classification, the spot leg's `baseAsset` must exactly equal `<TICKER>B`, and both are cross-checked against each other. Verified live: NVDA is accepted, BTC (a real crypto perpetual) is correctly rejected.
3. **Idempotency is a database-level compare-and-swap**, not a best-effort check: `claimCycle()`'s `UPDATE ... WHERE status IN ('pending','failed_retryable')` only succeeds once per due slot, regardless of restarts, overlapping ticks, or a concurrent MCP-triggered manual run racing the worker. This is proven end-to-end in `scripts/mcp-smoke-test.ts`, not just unit-tested.
4. **A partial fill is never conflated with a full fill**, and a rejected leg is never silently retried if the other leg already executed (that would double the filled leg's exposure) — see `partial_failure` status handling in `runContribution.ts` and `scheduler/cycles.ts`.
5. **Live execution stays genuinely unreachable**, not just "off by default": the signing/request-building code exists and is tested, but is never imported by the worker, the adapter selector, or the MCP server.

## What this is not

Not a chatbot. Not a one-off script. Not a guarantee of downside protection, a continuous 10% hedge ratio, or a maximum-loss cap. Not (yet) connected to real money — see `LIVE_TRADING_READINESS.md` for exactly what's required before it could be.

## Documents

- `PROJECT_PLAN.md` — product policy, Phase 0 research findings, critical demo path
- `EXECUTION_ROUTE_DECISION.md` — why the hedge leg uses direct REST rather than the connected Binance MCP server (which doesn't expose Futures order tools)
- `LIVE_TRADING_READINESS.md` — exact prerequisites, verified API contracts, and the (not-yet-approved) minimal live-test budget
- `PROGRESS_LOG.md` — full checkpoint-by-checkpoint evidence log for this build session
- `docs/MCP_SETUP.md` — connecting the HedgeOS MCP server to Claude Code
