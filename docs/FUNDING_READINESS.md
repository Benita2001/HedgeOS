# Funding readiness

## P0 (implemented): pre-funded wallets + read-only shortfall alerts

HedgeOS assumes the user funds their own Spot and Futures wallets themselves, through Binance's own UI, before activating a strategy. HedgeOS never moves money between wallets, never touches withdrawal, and never initiates a deposit.

What HedgeOS **does** do (`src/binance/fundingReadiness.ts`, exposed via the MCP tool `check_funding_readiness`):
- Computes what a proposed contribution actually requires — Spot USDT for the stock leg's real sized notional + estimated fee, Futures USDT margin for the hedge leg's real sized collateral + estimated fee — using the exact same deterministic sizing engine every execution path uses. Not the raw 90/10 split; the actual post-exchange-filter numbers.
- Reads the operator's own real balances (`GET /api/v3/account`, `GET /fapi/v3/account` — read-only, the same endpoints verified in this session's live preflight).
- Reports each leg's shortfall independently — a strategy can be Spot-funded but Futures-unfunded (or vice versa), and the report says which.
- A contribution too small to clear the exchange minimum on a leg reports that leg as requiring $0 (its budget is deferred, not funded) — never a false shortfall alarm.

This distinguishes exactly what the priority asked for: Spot funds, Futures collateral, contribution budget, available margin, fees, deferred budgets, and funding shortfalls — as five/six independently-tracked numbers, not one conflated balance.

**Generic across users and amounts**: `check_funding_readiness` takes `ticker`/`contributionUsd`/`hedgeLeverage` as arguments — nothing hardcoded. See `tests/fundingReadiness.test.ts` for evidence across $40/$100/$500 contributions and both funded/unfunded scenarios.

## Not implemented: automatic internal transfer

A future version could automatically move USDT from Spot to Futures (or vice versa) to cover a detected shortfall, using `POST /sapi/v1/asset/transfer` (Binance's documented internal-transfer endpoint, no withdrawal permission required). **This is deliberately not built.** If it is built later, it must have, at minimum:

- **Explicit per-transfer user authorization** — not a standing permission; the same "specific yes, not a general go-ahead" pattern already used for live orders in this project.
- **A per-cycle transfer limit** — a hard ceiling on how much can move in one contribution cycle, independent of and smaller than any single strategy's contribution budget, so a bug can't drain a wallet over many cycles.
- **Destination restrictions** — the transfer function must refuse any transfer type/target other than the specific Spot↔Futures pair this project needs; it must not become a general-purpose transfer capability.
- **Reconciliation** — verify the transfer actually completed (query balance before/after, or the transfer's own status) before treating the funds as available for an order, using the same "never trust a single response" pattern as order reconciliation (`reconcileOrder`).
- **The same fail-closed gate pattern as live trading** — a dedicated confirmation env var, separate from `HEDGEOS_LIVE_TRADING_CONFIRMED`, so enabling orders doesn't implicitly enable transfers.

None of this exists yet. `check_funding_readiness` only ever reads; it never calls a transfer endpoint, and no transfer request builder exists in this codebase.

## Credential onboarding (per user, least-privilege)

Each user creates their own Binance API key:
1. **Read-only first** — verify the key works (`check_funding_readiness`, or the fuller `scripts/live-preflight.ts`) before granting trade scope at all.
2. **Then narrow trade scope** — Spot + Margin + Futures trade, **withdrawal disabled**, **internal transfer disabled** (until/unless the workflow above is built and reviewed).
3. **IP-restrict the key** to the specific host that will run the worker (or the operator's own machine, for manual/interactive use).
4. **Store it in a protected file, never in chat, never in a shared multi-user config.** See `docs/LIVE_PREFLIGHT_SETUP.md` for the exact pattern (interactive `read -s`, `chmod 600`, owned by the dedicated service user) — this pattern is per-user by construction: each user's credential lives in their own file, under their own deployment, never a shared plaintext config holding multiple users' secrets (see `docs/MULTI_TENANT_ARCHITECTURE.md` for why a real multi-user deployment needs more than "one file per user" — P0 is single-tenant, one credential, one file).
