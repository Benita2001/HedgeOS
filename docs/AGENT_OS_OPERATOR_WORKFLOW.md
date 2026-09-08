# Operator workflow: Binance Agent OS MCP + HedgeOS MCP together

This is the reproducible operator procedure for combining the two MCP surfaces described in `INTEGRATION_SURFACES.md` (surfaces 1 and 2). It exists because the two servers have structurally different trust levels, and conflating them would be the actual security bug: Agent OS output is operator-supplied evidence, never an input to money math.

## The three kinds of call in this workflow — keep them labeled

| Call | What it is | Trust level |
| --- | --- | --- |
| `mcp__binance-mcp-server__*` (Agent OS) | A real, authenticated read against Binance's own Agent OS MCP server, made by an interactive operator session (this requires the operator's own browser OAuth consent — see `INTEGRATION_SURFACES.md` §1) | Evidence only. Cross-checked, never sized against. |
| `discoverPair()` / `getSpotPrice()` / `getFuturesMarkPrice()` (`src/binance/client.ts`) | Public REST (`api.binance.com`, `fapi.binance.com`), called directly by HedgeOS itself, no auth | Authoritative. This is what sizing actually uses. |
| `create_paper_strategy` / `trigger_due_cycle` / receipts | HedgeOS's own paper execution (`src/binance/execution.ts`, `PaperExecutionAdapter`) | Simulated fill against a real live price. Never a live order. |

## Procedure

1. **Operator obtains observations from Agent OS.** In an interactive Claude Code session with the Binance Agent OS MCP server connected (`/mcp`, browser OAuth consent already granted), call a read-only tool for each leg, e.g.:
   - `mcp__binance-mcp-server__spot_tickerPrice({ symbol: "<TICKER>BUSDT" })`
   - `mcp__binance-mcp-server__futures_usds_symbolPriceTicker({ symbol: "<TICKER>USDT" })`
   - Optionally `mcp__binance-mcp-server__spot_exchangeInfo` / `futures_usds_exchangeInformation` for contract specs (identity, filters).

   Record each result's `symbol`, `price`, the literal tool name called, and the current timestamp. This forms an `ExternalObservation` (`src/observations/externalObservation.ts`):
   ```json
   { "symbol": "NVDABUSDT", "price": 228.11, "source": "binance-agent-os-mcp", "toolName": "mcp__binance-mcp-server__spot_tickerPrice", "observedAtIso": "2026-09-08T14:30:04.678Z" }
   ```

2. **Operator calls HedgeOS's `preview_with_agent_os_observations`** (new tool, `src/mcp/server.ts`), passing `ticker`, `contributionUsd`, `hedgeLeverage`, and the `externalObservations` array from step 1.

   HedgeOS does three things server-side, none of which trust the input:
   - Re-runs its own `discoverPair(ticker)` against public REST — independent instrument-identity validation (bStock `baseAsset` convention, futures `underlyingType`/`underlyingSubType` classification, cross-matched base assets — see `src/binance/client.ts`).
   - For each supplied observation, `validateExternalObservation()` checks: symbol matches a discovered leg, HedgeOS's own discovery marked that leg tradable, age ≤ 120s, price deviation from HedgeOS's own live price ≤ 2%.
   - Runs the deterministic 90/10 sizing engine (`sizeDcaHedgeContribution`) using **only** `discovery.spot.price` / `discovery.futures.markPrice` — HedgeOS's own numbers, fetched moments earlier in the same call.

   The response includes `agentOsObservations` (verdicts, for operator/demo corroboration) and `sizing` (what will actually execute). An operator can watch the two prices agree (or, if Agent OS ever disagreed, watch the rejection reason) without that agreement or disagreement changing what gets sized.

3. **Operator calls `create_paper_strategy`** (existing tool, unchanged) once satisfied with the preview.

4. **Operator calls `trigger_due_cycle`** (existing tool, unchanged) to run one contribution now, for the demo, through the exact same idempotent claim path (`scheduler/cycles.ts`) the persistent worker uses on its own schedule.

5. **Operator verifies via `get_strategy_status` / `list_receipts` / `list_executions`** (existing read tools, unchanged) — durable state, not an in-memory session, so this also works after restarting the MCP server process, and works identically against the VPS-deployed database over SSH.

## What this integration deliberately does NOT do

- It does not make the persistent VPS worker depend on Agent OS. The worker (`src/worker/index.ts`) still uses only public REST, because Agent OS has no headless/service-account auth (verified via `developers.binance.com`, restated in `INTEGRATION_SURFACES.md`). Nothing in the worker's runtime import graph references `preview_with_agent_os_observations` or any Agent OS tool.
- It does not let an Agent OS observation — or an LLM restating a price in conversation — reach the sizing engine. `sizeDcaHedgeContribution` is called with `discovery.spot.price`, a value HedgeOS fetched itself; `ExternalObservation.price` has no other consumer in the codebase (see the contract-level test in `tests/externalObservation.test.ts`).
- It does not place a live order. `preview_with_agent_os_observations` is read-only (writes nothing, per its `readOnlyHint` annotation); `trigger_due_cycle` refuses outright unless `HEDGEOS_MODE=paper`.

## Reproducing the demo

```bash
npx tsx scripts/agent-os-integration-demo.ts
```

Runs the real HedgeOS MCP server as a subprocess (disposable test DB, cleaned up on each run) and drives the five steps above with a real MCP client, using the two Agent OS observations actually captured in the build session (see the script's header comment for the verbatim tool-call results). Every fill it produces is a labeled **SIMULATED PAPER FILL**.
