# HedgeOS — Project Plan

## Deadline (VERIFIED)
2026-09-08 23:59 UTC. Source: https://www.binance.com/en/blog/community/8802181509900814931
Today: 2026-09-07. ~24-28h remaining. Track A submission = video/demo + GitHub repo, posted as a reply to Binance's own hackathon announcement on X, plus a survey. Not a formal upload platform.

## Track
Track A ($20K pool; per-winner prizes are small — $2000/$1500/$1000/then $300 x 50). Requirement: genuine autonomous agent built on Agent OS, not a bare MCP-trading connector (that's Track B).

## Eligibility (UNVERIFIED for this user)
Excluded jurisdictions: US, UK, EEA, Hong Kong, Singapore, Binance-prohibited list. User has not confirmed jurisdiction. Not a blocker to building; is a blocker to submitting. Must confirm before submission.

## Product
Headless protected-DCA agent: user says "invest $X into <asset> every <period>", agent automatically splits 90% stock / 10% hedge per contribution (not portfolio-based), executes both legs, persists state, reconciles, and keeps running unattended.

## Verified technical facts (live public API, 2026-09-07)
- `NVDABUSDT` spot bStock: TRADING, minNotional $5, price ~$232.70, real volume.
- `NVDAUSDT` futures: `contractType=TRADIFI_PERPETUAL`, `underlyingType=EQUITY`, TRADING, minNotional $5, mark ~$232.90, funding 0%.
- Both legs exist, both are live-tradable, prices track almost exactly. This is real evidence the "exact matching short perpetual" architecture is viable for at least NVDA.
- Sizing: at ~$233/share, $10 hedge budget at 1x leverage clears the $5 min-notional easily (~0.03-0.04 contracts). Contributions below ~$56 total (10% < $5.60) would put the hedge leg under the exchange minimum — needs an explicit skip-or-accumulate policy.
- NOT verified: Binance MCP server's actual tool schema/names (no Binance MCP connected in this dev session — only Bitget's MCP is connected here). NOT verified: authenticated trading behavior, since that needs the user's own Binance API key setup, which this agent will not create unilaterally.

## Asset selection: user-chosen, not hardcoded
The user may name any ticker ("invest $100 into Tesla every week"). Before accepting a strategy, HedgeOS runs a deterministic discovery step against live Binance `exchangeInfo`:
- spot: does `<TICKER>BUSDT` exist and have `status: TRADING`?
- futures: does `<TICKER>USDT` exist with `contractType: TRADIFI_PERPETUAL` and `status: TRADING`?
Only if both are true is the pair accepted for the protected-DCA strategy. If either leg is missing, the agent reports the gap (no matching perpetual / no bStock listed) instead of substituting, guessing, or hardcoding a fallback asset. This discovery result is cached per symbol, not re-derived by an LLM at execution time.

## Critical Demo Path (P0, demo asset: NVDA, but path is symbol-agnostic)
1. User instructs: "invest $100 into <TICKER> every week."
2. Discovery step confirms `<TICKER>BUSDT` + `<TICKER>USDT` (TRADIFI_PERPETUAL) both exist and are TRADING.
3. Scheduler fires a DCA event (demo: manually triggerable, not just cron-wait).
4. Deterministic risk/sizing engine computes: $90 → `<TICKER>BUSDT` buy qty, $10 → `<TICKER>USDT` short qty, both snapped to exchange filters (minNotional/stepSize), leverage fixed and low (documented, not "guaranteed hedge"). This math is never delegated to the LLM.
4. Both orders submitted through Binance (paper/testnet mode if live keys unavailable in the build window; clearly labeled which mode is active — never presented as live if it isn't).
5. Receipts + resulting position state persisted to DB.
6. Dashboard (minimal) shows: schedule, last execution, both legs, running P&L view, receipts.
7. HedgeOS-owned MCP server exposes read tools (status, positions, receipts, schedule) so Claude Code can inspect the running agent live, proving it's a real autonomous service and not just a chat session.
8. Reconciliation check: agent detects and reports state drift on restart (proves persistence + recovery, a Track A differentiator vs Track B).

## Non-goals (explicit, per user)
No chatbot UI, no multi-agent swarm, no price prediction/sentiment, no proxy hedging, no options, no custom token, no x402 flow, no continuous rebalancing on price moves, no guaranteed-hedge claims.

## Runtime architecture (P0)
- Node/TypeScript, single process worker (persistent, restart-safe) — not dependent on Claude Code staying open.
- SQLite (better-sqlite3) for strategies/schedules/executions/receipts — swappable later, not now.
- Deterministic engine module: pure functions, unit-testable, no LLM in the money-math path.
- Binance integration layer: REST client wrapping public + (when keys exist) authenticated endpoints; execution adapter has a `paper` mode (simulated fills against real market data) and a `live` mode, switched by config, never silently.
- Node-cron (or equivalent) scheduler inside the same worker.
- HedgeOS MCP server (stdio or local HTTP) exposing read/inspect tools for Claude Code.
- Minimal dashboard: static page or lightweight server reading the same DB, no auth complexity for demo.

## Hedge execution route (decided — see EXECUTION_ROUTE_DECISION.md)
Stock leg: supported via connected Binance MCP (bStock Spot). Hedge leg (TRADIFI_PERPETUAL): MCP does not expose Futures order/leverage/margin tools and the current credential has Futures trading disabled; the documented direct-REST path (`/fapi/v1/order` etc.) is officially sanctioned to combine with MCP, but is blocked pending human-only steps (a Futures-enabled API key, signing `POST /fapi/v1/stock/contract`, and unverified bStock/ADGM-specific eligibility). Decision: keep the hedge in clearly-labeled paper mode for the hackathon submission rather than rush live execution or substitute a different instrument.

## Blockers / kill criteria
- If user is in a restricted jurisdiction: cannot submit under this user's account — would need a different eligible account, or accept it's a portfolio exercise, not a live submission entry. ASK USER.
- If no live Binance API key can be created/authorized before the deadline: fall back to paper-mode demo against real market data (still evidence-backed, clearly labeled) rather than fabricating fills.
- If Binance MCP server tool schema, once connected, doesn't expose stock/bStock or TradFi-perp order placement at all (contradicting the Agent OS announcement): fall back to direct authenticated REST calls for those two legs, keep MCP for what it does support (crypto spot/futures, balances), and document the gap honestly in the submission.

## Immediate next milestone
Scaffold repo structure + symbol discovery + deterministic engine + DB schema + paper execution adapter against live market data, demoed with NVDA but not hardcoded to it. Get one full simulated DCA+hedge cycle running end-to-end today, before touching dashboard polish or MCP server plumbing.
