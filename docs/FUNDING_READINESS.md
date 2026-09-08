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

## P1 (implemented, mock-tested, still gated): automatic internal transfer

Built this session (`src/binance/fundingReadiness.ts`'s `planFunding`, `src/binance/fundingTransfer.ts`) — a real, tested implementation, **never yet executed against a real account**. Endpoint paths confirmed against `developers.binance.com`'s Wallet Asset API endpoint list: `POST /sapi/v1/asset/transfer` (create), `GET /sapi/v1/asset/transfer` (history) — the exact `type` enum value and full response schema were not independently re-fetched field-by-field (the docs site did not render that detail to automated tools this session); a final manual doc check is recommended before real use.

Every requirement identified when this section was written as "not implemented" is now met:
- **Explicit per-strategy authorization**: `funding_mode` defaults to `'prefunded'` (no transfer ever attempted) and `createStrategy`/`create_paper_strategy` **refuse** `funding_mode='auto'` unless an explicit, positive `fundingPerCycleCapUsd` is also given — "invest $100" alone never enables automatic transfers.
- **A per-cycle transfer limit**: `FundingPolicy.perCycleCapUsd`, enforced in `planFunding` — the planned transfer amount is capped there, never the shortfall alone, never the account balance.
- **An optional period (e.g. daily) limit**: `FundingPolicy.periodCapUsd`, independent of the per-cycle cap.
- **Destination restriction**: `fundingTransfer.ts` only ever builds `MAIN_UMFUTURE` (Spot→Futures) requests — no other transfer type is reachable from this code.
- **Reconciliation, never trusting a single response**: `executeAutoFundingTransfer` places the transfer, then polls transfer history until the exchange reports `CONFIRMED`/`FAILED` (or exhausts its attempt budget, returning `"unresolved"` — never silently assumed successful).
- **Ambiguous-outcome recovery, no blind retries**: `placeTransferWithAmbiguityRecovery` mirrors the order-placement pattern in `liveExecution.ts` — a timeout/network error triggers a history lookup by amount+time-window (not a raw retry), and a genuinely unresolved outcome is reported as such, never guessed.
- **A separate fail-closed gate from live trading**: `assertAutoFundingGate` (`HEDGEOS_FUNDING_MODE=auto` + `HEDGEOS_AUTO_FUNDING_CONFIRMED=I_AUTHORIZE_AUTOMATIC_TRANSFERS`) — independent of `assertLiveTradingGate`'s four conditions. Enabling live orders never implicitly enables transfers, and vice versa.
- **Never double-counts shared-wallet funds**: `planFunding` accepts a `reservedFuturesUsd` figure (funds already earmarked by other strategies) and subtracts it before computing what's actually available.

**What was deliberately NOT done**: no transfer has ever been sent to a real account (all 28 new tests — `tests/fundingTransfer.test.ts`, `tests/autoFundingLifecycle.test.ts` — use a mocked HTTP client, zero real network calls). The `reservedFuturesUsd` figure is a parameter the caller supplies — a real multi-strategy aggregation query (summing other active strategies' pending/deferred budgets from the DB) was not wired up this session; it defaults to 0, a real gap, not silently assumed solved. The currently-installed real credential (see `LIVE_TRADING_READINESS.md`) has `enableInternalTransfer: false` — even a perfect implementation cannot be used until that permission is separately granted on a new or updated key.

## Credential onboarding (per user, least-privilege)

Each user creates their own Binance API key:
1. **Read-only first** — verify the key works (`check_funding_readiness`, or the fuller `scripts/live-preflight.ts`) before granting trade scope at all.
2. **Then narrow trade scope** — Spot + Margin + Futures trade, **withdrawal disabled**, **internal transfer disabled** (until/unless the workflow above is built and reviewed).
3. **IP-restrict the key** to the specific host that will run the worker (or the operator's own machine, for manual/interactive use).
4. **Store it in a protected file, never in chat, never in a shared multi-user config.** See `docs/LIVE_PREFLIGHT_SETUP.md` for the exact pattern (interactive `read -s`, `chmod 600`, owned by the dedicated service user) — this pattern is per-user by construction: each user's credential lives in their own file, under their own deployment, never a shared plaintext config holding multiple users' secrets (see `docs/MULTI_TENANT_ARCHITECTURE.md` for why a real multi-user deployment needs more than "one file per user" — P0 is single-tenant, one credential, one file).
