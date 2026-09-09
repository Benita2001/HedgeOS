# HedgeOS — Live Trading Readiness (Both Legs)

Status: **NO-GO for live execution right now — architecture is implemented, gated, and tested; the account is not.** Paper mode is the development/validation environment, not the end goal — live, authorized execution of the real 90/10 + 2x/3x-hedge strategy is the actual target, gated on the human prerequisites in §6. Nothing here changes the approved strategy, and no proxy/inverse-ETF substitute is proposed for the live proof — the hedge stays the exact matching TRADIFI_PERPETUAL short throughout.

**As of the 2026-09-08 build-review session, `LiveExecutionAdapter` is real code** (`src/binance/liveExecution.ts`, `src/binance/liveRequests.ts`, `src/binance/liveHttp.ts`) — authenticated order placement, reconciliation-against-independent-trade-data, ambiguous-outcome recovery (query before ever retrying), leverage/margin configuration, and a read-only preflight — covered by 27 unit tests against a mocked HTTP client (`tests/liveExecution.test.ts`), all passing, zero real network calls. It is still **structurally inert**: `getExecutionAdapter()` (`src/binance/execution.ts`) only constructs it after `assertLiveTradingGate()` passes FOUR independent checks — see §5 — and nothing in this repository, its defaults, or its deployment scripts sets any of them. No credentials created, no agreements signed, no permissions changed, no orders placed.

---

## 1. Verified official REST contracts (TRADIFI_PERPETUAL, USDⓈ-M Futures, `fapi.binance.com`)

**Order / leverage / margin (TRADE, HMAC-SHA256 signed, `X-MBX-APIKEY` header, `timestamp`+`recvWindow`):**
- `POST /fapi/v1/order` — place order (symbol, side, type, quantity, price, timeInForce, positionSide, reduceOnly)
- `GET /fapi/v1/order` — query one order (orderId or origClientOrderId)
- `DELETE /fapi/v1/order` — cancel order
- `POST /fapi/v1/leverage` — change initial leverage for a symbol
- `POST /fapi/v1/marginType` — set ISOLATED or CROSSED (cannot change while a position/open order exists on that symbol)
- `POST /fapi/v1/positionSide/dual` — one-way vs hedge position mode

**Reconciliation / read (USER_DATA):**
- `GET /fapi/v3/account` — account overview (replaces v2)
- `GET /fapi/v3/balance` — wallet balances (replaces v2)
- `GET /fapi/v3/positionRisk` — open positions, only symbols with a position or open order (replaces v2)
- `GET /fapi/v1/openOrders` — all open orders for a symbol
- `GET /fapi/v1/userTrades` — actual fills (the ground truth for "did this really execute," never inferred from the order-placement response alone)
- `GET /fapi/v1/symbolConfig` / `GET /fapi/v1/accountConfig` — per-symbol leverage/margin-type config (moved out of `/account` in v3)

**Product-specific gate (confirmed real, not inferred from a generic endpoint's existence):**
- `POST /fapi/v1/stock/contract` — "sign TradFi-Perps agreement," added to Binance's official changelog **2025-12-11**. A parallel Portfolio-Margin route (`POST /papi/v1/um/stock/contract`) was added 2026-04-08. Exact error behavior for an unsigned account calling `/fapi/v1/order` on a TRADIFI_PERPETUAL symbol is **still unverified** — not found in any fetched doc content, and I won't guess it. HedgeOS's own error handling does not need to guess the exact code either: `placeAndReconcileFuturesOrder` propagates any `BinanceApiError` it doesn't specifically recognize as ambiguous/duplicate straight through, unmodified — an agreement/eligibility rejection surfaces as a real, visible failure regardless of its exact code (see `tests/liveExecution.test.ts`, "agreement/eligibility failure" case).
- **Re-verified 2026-09-08**: `New Order` (`POST /fapi/v1/order`) accepts `positionSide` (BOTH default for One-way Mode, LONG/SHORT required in Hedge Mode), `reduceOnly` (not usable in Hedge Mode), and `newOrderRespType` (`ACK` default returns immediately with no fill data; `RESULT` returns `status`/`executedQty`/`avgPrice` synchronously). HedgeOS's request builders (`liveRequests.ts`) now explicitly set `newOrderRespType: "RESULT"` on both new-order builders — reconciliation still independently re-derives fill state from `userTrades`/`myTrades` regardless of what this field reports.

Sources: [New Order — USDⓈ-M Futures REST API](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order), [Derivatives API Change Log](https://developers.binance.com/docs/derivatives/change-log), [Trade — Futures (USDⓈ-M) REST API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade), [Position Information V3](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Position-Information-V3), [Account Information V3](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Account-Information-V3).

## 2. Human steps: bStock eligibility, TradFi-Perps agreement, Futures-enabled credential

These are steps **you** take, in the Binance UI/app — not API calls I make on your behalf:

1. **Futures onboarding** — if the account has never traded Futures, Binance requires completing a risk-disclosure quiz in the app/website Futures section before the Futures wallet activates at all. ([Quick Start — Binance Open Platform](https://developers.binance.com/docs/derivatives/quick-start))
2. **bStock/ADGM eligibility** — separate from #1 and from the hackathon's own jurisdiction list. bStocks are issued through an Abu Dhabi Global Markets structure and are "not offered to US persons"; Binance states a country-eligibility check exists. Confirm directly in your account's bStocks section (I could not pin the exact public endpoint path — marking unknown rather than guessing). ([Binance Academy — What Are bStocks?](https://www.binance.com/en/academy/articles/what-are-bstocks-a-guide-to-tokenized-stocks-on-binance))
3. **TradFi-Perps agreement** — unverified whether this is satisfied by clicking through a one-time in-app disclosure the first time you open a TRADIFI_PERPETUAL trading pair's page (the common Binance UX pattern for gated products), or whether it strictly requires the `POST /fapi/v1/stock/contract` API call. **Recommended order of operations**: open the NVDAUSDT (or chosen symbol) trading page in the Binance app/website yourself first and see if a disclosure modal appears; that is very likely the intended flow and is safer than guessing at an API call's side effects.
4. **Futures-enabled API key** — create/edit the key only *after* Futures is active on the account (Binance's own guidance: a key generated before Futures activation may not reliably gain Futures scope even after editing permissions — safest is a fresh key). Restrict it to Futures **Trade** + **Read** only — no withdrawal, no transfer, IP-whitelisted if the deployment target's IP is known.

I will not perform any of these four steps. They require your login, your acceptance of Binance's terms, and your judgment about real financial exposure.

## 3. Agentic account vs. a separate permitted account — genuinely unverified, flagging rather than assuming

Two things are established, and one is not:
- **Established**: the currently-connected `binance-mcp-server` exposes no Futures order/leverage/margin *tools* at all, regardless of what scope is granted — this is a tool-catalog gap on Binance's MCP server, confirmed by direct inspection, not a permission setting I can toggle.
- **Established**: general Binance documentation says Agentic sub-account trading scopes can in principle span "Spot, Margin, Convert, USDⓈ-M Futures, and COIN-M Futures... depending on the specific scopes authorized... and account eligibility for each product" — but this describes the *product category*, not confirmation that the Agent OS consent screen or the Agentic sub-account type actually exposes a Futures wallet/toggle today.
- **Unverified — do not assume**: whether the Agentic sub-account itself can hold a Futures position at all, or whether the hedge leg fundamentally requires a separate, non-Agentic API key (main account or a standard sub-account) that you control directly outside of Agent OS. **Action for you**: check whether the Agentic sub-account (the one the MCP server operates against) has a Futures wallet tab in the Binance UI. If it does not, the hedge leg's live execution will need its own directly-authorized credential — this is not a blocker to the architecture (§5 of the prior decision already confirmed combining MCP + direct REST is officially sanctioned), just a second credential to manage.

## 4. Smallest exchange-valid live test — DEFAULT 2× POLICY, actual calculated requirement

**The earlier $30-contribution/3× proposal from a prior session is withdrawn — it is not approved and is superseded by this section.** It changed leverage (3× instead of the 2× default) specifically to force a smaller contribution to clear the exchange minimum, which is exactly the "never increase leverage merely to meet an order minimum" anti-pattern this project's frozen policy forbids. This section instead reports what the **default 2× policy** actually requires, computed by the real sizing engine against real filters — not assumed, not rounded to a "nice" number.

Reproduce with `npx tsx scripts/find-min-live-test-budget.ts <current-price>` (real filters: both legs `minNotional $5`; spot `stepSize 0.001`; futures `stepSize 0.01`, verified live via Binance Agent OS MCP — see `docs/INTEGRATION_SURFACES.md` §1). **Recalculated 2026-09-08, ~17:50 UTC, against the live price at that moment ($226.16, via a fresh real Agent OS MCP call, not a stale/cached figure):**

| Leverage | First fully-executable contribution | Stock leg | Hedge leg |
|---|---|---|---|
| **2× (default policy)** | **$34** | qty 0.135, notional $30.53 | qty 0.03, notional $6.78, collateral $3.39 |
| 3× (optional tier, for comparison only) | $23 | qty 0.091, notional $20.58 | qty 0.03, notional $6.78, collateral $2.26 |

The exact minimum moves a little with price (it was $35 a few hours earlier at $228.14) — this is expected and is why the sizing engine always re-fetches the live price at execution time rather than using any number written here.

**Dry-run at the proposed $40 contribution** (real discovery + real sizing engine, `previewContribution("NVDA", 40, 2)`, run 2026-09-08 17:50 UTC — **estimates below, not exchange-confirmed**; the exchange confirms only at actual order time):

| Field | Value | Status |
|---|---|---|
| Spot symbol / order type | `NVDABUSDT`, MARKET BUY | planned |
| Spot quantity | 0.159 | **estimate** — snapped to real `stepSize 0.001` against the price at preview time ($226.08); will be recomputed against the live price at the moment of actual execution |
| Spot estimated notional | $35.95 | **estimate** |
| Spot estimated fee | $0.036 (~0.1% taker) | **estimate**, not fee-tier-verified |
| Futures symbol / order type | `NVDAUSDT`, MARKET SELL, `positionSide` resolved from the account's actual position mode (confirmed one-way via preflight → `BOTH`) | planned |
| Futures quantity | 0.03 | **estimate** |
| Futures estimated notional | $6.78 (target $8 pre-rounding, snapped down) | **estimate** |
| Futures estimated collateral | $3.39 (at 2× leverage) | **estimate** |
| Futures estimated fee | $0.0034 (~0.05% taker) | **estimate** |
| Deferred hedge budget this cycle | $0.61 (the $4 hedge budget minus the $3.39 actually committed) | **estimate** — carried forward per existing deferred-budget accounting, not lost |

**Failure policy for this test** (implemented, see `runContribution.ts`/`liveExecution.ts`): stock leg places first; if it fills and the hedge leg then fails (rejected OR throws — both paths now correctly captured, see checkpoint 10 defect fix below), the execution is recorded `partial_failure`, the cycle is marked `failed_terminal` (never auto-retried — retrying would double the leg that already filled), and the real stock fill remains fully visible via `get_strategy_status`/`list_receipts`. No automatic reversal or liquidation of any resulting position is performed by any code path — recovery is a manual, explicit, human-authorized action.

**Funding needed** (see §3a below) — treat the $40 contribution as **a capital budget for this test, not a guaranteed maximum-loss cap**: ISOLATED margin bounds the hedge position's *posted-margin* exposure under normal conditions, but funding fees, a liquidation fee, or an extreme gap can mean realized loss is not strictly bounded at the posted collateral figure — this is stated plainly, not assumed away.

This is a **proof-of-execution** test, not a demo of the strategy's economics — its only job is to prove one real, authorized, reconciled fill on each leg exists.

## 3a. Exact funding amounts needed

Current state (per the real preflight run this session): **$0 Spot USDT**, **$0 Futures USDT/margin**. Both must be funded before any order can be attempted — this is the actual blocker right now, not permissions (those already passed).

| Wallet | Minimum needed for the $40 test | Recommended funding (buffer) | Why the buffer |
|---|---|---|---|
| **Spot USDT** | $36.04 ($36.00 stock budget + ~$0.04 estimated fee) | **$40** | Covers minor price upticks between now and order time without a last-second "insufficient balance" rejection; the sizing engine still only spends up to the $36 budget regardless of how much sits in the wallet |
| **Futures USDT (margin)** | $3.40 ($3.39 estimated collateral + ~$0.01 fee) | **$8** | This wallet is at $0 today — a small buffer avoids a wafer-thin margin ratio immediately after the position opens and covers the maintenance-margin cushion; unused margin stays available balance, it is not "spent" |
| **Total to transfer/deposit** | ~$39.44 | **$48** | Across both wallets combined |

You (not me) need to do the funding — deposit or convert USDT into Spot, and transfer/deposit USDT into the Futures wallet, using Binance's own UI. I have not initiated, and will not initiate, any transfer.

## 5. Gate before `LiveExecutionAdapter` is ever enabled

Two layers, both must pass:

**Layer A — code-level, machine-checked (`assertLiveTradingGate`, `src/binance/liveExecution.ts`, `getExecutionAdapter()` in `execution.ts`).** All FOUR required, checked independently, first failure wins:
1. `HEDGEOS_MODE=live`
2. `HEDGEOS_LIVE_TRADING_CONFIRMED=I_UNDERSTAND_THE_RISK` (exact string — a deliberate second confirmation, so `HEDGEOS_MODE=live` alone can never enable anything)
3. `HEDGEOS_LIVE_CHECKLIST_COMPLETE=yes` (meant to be set only after every item in §6 below is actually done)
4. Real, non-empty `BINANCE_API_KEY` / `BINANCE_API_SECRET`

Verified this session via real process invocation (not just a unit test): with 0, 1, 2, or 3 of these set, `getExecutionAdapter()` throws a specific, named error identifying exactly which gate failed. None of the four are set anywhere in this repository, its defaults, or its VPS deployment.

**Layer B — human/operational, before any specific order:**
1. Authenticated **read-only** preflight passes (`runLivePreflight`, `liveExecution.ts`): `GET /fapi/v3/account`, `GET /fapi/v3/positionRisk`, `GET /fapi/v1/openOrders`, position-mode read for the target symbol, `GET /api/v3/account` — confirming the credential actually has the permissions and the symbol is tradable *for this account specifically*, not just generally listed.
2. Deterministic sizing/risk tests already pass (94/94 as of this session, including 27 new live-adapter tests — see `PROGRESS_LOG.md` checkpoint 9).
3. A dry-run of the exact order payload (via the same code path, against a mocked client) is logged and reviewed by you before any real submission.
4. **Your explicit, per-order authorization** — not a standing "go ahead," a specific yes for this specific test, for the specific §4 budget.
5. Immediately after any live order: reconciliation via `GET /fapi/v1/order` + `GET /fapi/v1/userTrades` + `GET /fapi/v3/positionRisk` (already implemented in `reconcileOrder`/`placeAndReconcileFuturesOrder`), comparing actual fill qty/price against what was requested, before the receipt is ever labeled anything other than pending-verification.

Until Layer A passes (which requires you to complete §6 first), the code path is unreachable regardless of anyone's intent — this is enforced by `getExecutionAdapter()`, not by a promise not to call it.

## 6. Human checklist (for you — nothing here is performed by HedgeOS or by me)

- [ ] Futures risk quiz completed / Futures wallet active
- [ ] bStock/ADGM eligibility confirmed for this account
- [ ] Opened the target TRADIFI_PERPETUAL pair in the Binance UI and resolved whatever agreement/disclosure step appears
- [ ] Confirmed whether the Agentic sub-account has a Futures wallet, or decided to use a separate credential for the hedge leg
- [ ] Created/edited a Futures-enabled API key (Trade + Read only, no withdrawal), created *after* Futures activation
- [ ] Key placed in the VPS/local `.env` (`BINANCE_API_KEY` / `BINANCE_API_SECRET`) — never pasted into chat, never committed
- [ ] Reviewed and accepted the §4 minimal-test budget ($40 at the default 2×, or your chosen alternative) and its maximum-loss cap
- [ ] Only once every item above is genuinely done: set `HEDGEOS_LIVE_CHECKLIST_COMPLETE=yes` (this is Layer A gate #3 — setting it before the above is actually done defeats its purpose)
- [ ] Ready to give explicit per-order authorization at test time (Layer B gate #4) — setting the env vars does not itself authorize a specific order

## 7. Paper-mode work continues unblocked

This readiness track runs in parallel and changes nothing about the existing paper-mode worker, scheduler, or receipts. The autonomous demo path (discovery → deterministic sizing → paper execution → persistence → scheduling → crash recovery) remains the fallback and the current, working evidence — re-verified end-to-end against real market data in the same session this live architecture was built (`scripts/mcp-smoke-test.ts`, all checks passed). Paper mode is not inferior filler; it's the proven backbone regardless of how far live-readiness gets before the deadline.

## GO / NO-GO (updated after the real read-only preflight + code audit, 2026-09-08 ~17:50 UTC)

**Architecture: GO.** 107/107 tests passing, including 28 exercising the live adapter and 10 proving contribution sizing is generic (not hardcoded to any demo amount — see §8). A code audit against the actual implementation this session found and fixed one **critical** defect (checkpoint 10, below) before any live authorization: a thrown hedge-leg error used to propagate out of `runContribution` before the database write, meaning a real, exchange-confirmed stock fill could be lost with zero record anywhere in HedgeOS. Also fixed: a reconciliation race that could misreport a genuine full fill as partial due to trade-indexing lag, and a hardcoded `positionSide: "BOTH"` that would have been rejected outright had this account been in Hedge Mode (it isn't, per the real preflight, but the code is now correct generically, not by accident of this account's current setting).

**Account permissions: GO.** Real preflight, 10/10 checks passed: Spot+Margin+Futures trade-enabled, withdrawals disabled, IP-restricted, one-way position mode, no existing positions/orders on the target pair.

**Funding: NO-GO.** $0 in Spot USDT, $0 in Futures margin. See §3a for exact amounts.

**Agreement/eligibility: unverified.** No dedicated read endpoint exists (confirmed via official docs); resolved only by checking the Binance UI yourself or by an actual order attempt.

No authorized live order has been placed, reconciled, or verified against actual exchange state, and none is claimed to have been.

**Next step, when you're ready**: fund per §3a, then give a specific, per-order authorization (see the request in this session's response) for the exact $40 test — not a standing "go ahead."

**Agreement/eligibility update (confirmed by you, 2026-09-08)**: you opened the NVDAUSDT TradFi Perpetual page in the Binance app — market open, order form available, **no agreement or risk-quiz prompt appeared**. This is evidence (not a formal API confirmation, since none exists) that this specific product gate is already satisfied for this account. **You also reported the UI defaults to Cross margin, 20× leverage** for this never-before-configured symbol — see §9, this was a real, live-relevant finding that changed the code.

## 9. Verified-before-trusted leverage/margin configuration (checkpoint 11)

Your report that the account defaults to **Cross / 20×** on NVDAUSDT (not the 2×/ISOLATED this project's frozen policy requires) exposed a real gap: `configureHedgeAccount` sent the leverage/margin-type change requests but nothing then confirmed the account was actually in the requested state before an order would have been placed — it trusted the `POST` calls' success responses alone.

Fixed: `verifyHedgeAccountConfig()` (`src/binance/liveExecution.ts`) reads back `GET /fapi/v3/positionRisk` for the target symbol immediately after `configureHedgeAccount` runs, and **refuses to place the hedge order** if the real, read-back leverage or margin type doesn't match exactly what was requested — leverage-generic (works for 2× or 3×, never hardcoded), symbol-generic. 9 new tests cover this, including the literal scenario you observed (account shows 20×/Cross; verification catches it and refuses before any order is sent) and the correct-2×/ISOLATED pass-through case. **115/115 tests passing.**

This step now runs automatically as part of every hedge-leg order in `LiveExecutionAdapter.placeOrder` — sequence is: resolve real position mode → configure leverage+margin → **verify it actually took effect** → place order → reconcile. None of this is reachable without the full live gate (§5) passing, which nothing in this environment sets.

## 8. Audit: contribution sizing is generic, not hardcoded to $40/NVDA/any demo amount

Verified this session, not asserted. `grep -rnE "\b(40|100|500)\b" src/` found zero hardcoded contribution amounts in production code — every numeric hit was `Math.round(x * 100) / 100` (cent rounding, universal, unrelated to any specific dollar figure). `grep -rn "NVDA" src/` found zero functional special-casing — the only hits are a JSDoc example and a documented, symbol-agnostic maintenance-margin *estimate* constant in `risk/checks.ts` that happens to have been validated against NVDA's contract spec (a pre-existing, already-labeled limitation, not new).

`tests/contributionSizeSweep.test.ts` (10 new tests) runs the exact same `sizeDcaHedgeContribution` the live and paper adapters both call, across: two below-minimum amounts (defer safely, `executable:false`, budget still reported as deferred, never dropped or forced through), the calculated minimum-valid ($34), $40, $100, $500, $50,000, and $1,000,000 — and confirms at every size: the 90/10 split is computed only from the contribution argument, collateral never exceeds its budget, hedge notional never exceeds `budget × leverage`, quantities are always snapped down to the real exchange step, and 3× leverage scales the target notional proportionally from the *same* contribution rather than being tied to any amount. A separate test confirms doubling the contribution proportionally doubles both legs' notional.

## 9. Automatic Spot->Futures funding — real code, mock-tested, gated, and blocked by a real permission gap

Implemented this session: `planFunding`/`fundingTransfer.ts` — see `docs/FUNDING_READINESS.md` for the full design (per-cycle/period caps, shared-wallet reservation, ambiguous-outcome recovery, reconciliation-before-trust). Wired into the recurring lifecycle via an optional `ExecutionAdapter.prepareFunding` step, called before the hedge leg's order, gated separately from live trading (`assertAutoFundingGate`: `HEDGEOS_FUNDING_MODE=auto` + `HEDGEOS_AUTO_FUNDING_CONFIRMED`). 28 new tests, all against a mocked HTTP client — **no real transfer has ever been attempted.**

**Update: partially resolved, corrected after a deeper check.** `enableInternalTransfer: false` (the original blocker) is now `true` — the account owner enabled it, confirmed by a real `scripts/live-preflight.ts` run, `enableWithdrawals` still `false` and `ipRestrict` still `true` (unchanged). **But that check was incomplete**: a follow-up preflight run, now checking a second flag it previously missed, found **`permitsUniversalTransfer: false`** — independent sources describe this as the actual flag `POST /sapi/v1/asset/transfer` requires. **Automatic funding remains permission-blocked** until a real preflight shows `permitsUniversalTransfer: true` too. Separately, the Futures wallet showed $0.00 in the same check — funding is a second, independent blocker regardless of permissions. Also fixed this session: the shared-wallet reservation gap is now a real, atomically-locked reservation (`reserveFundingAtomically`, `db/index.ts`), not just a caller-supplied placeholder or an un-locked sum — see `docs/FUNDING_READINESS.md`.

## 10. Final live-test proposal, incorporating automatic funding

Unchanged in spirit from §2's proposal: a **user-selected amount**, not a hardcoded test value — the smallest amount that clears both legs' exchange minimums at the account owner's chosen leverage (2× by default; recompute against the live price at the time, per `scripts/find-min-live-test-budget.ts`). Two funding paths remain available, both requiring your explicit choice:
- **Prefunded** (recommended for the very first live cycle): you manually top up the Futures wallet per §3a's exact amounts; no new permission needed; simplest to reason about for a first real fill.
- **Automatic**: requires granting `enableInternalTransfer` on the credential first, then setting a small, explicit `fundingPerCycleCapUsd` (e.g., just enough to cover one cycle's collateral + buffer — never a round "test" number chosen for convenience) and the separate funding gate env vars. Recommended only after the prefunded path has produced at least one clean, reconciled live cycle — validating the order/reconciliation path before adding the transfer step to what's being trusted with real money in the same run.

## 11. First real cycle executed — 2026-09-08 23:55 UTC — partial result, documented honestly

Executed exactly as §10 describes: NVDA, $34, 2×, auto-funding capped at $3.40, one-cycle-only authorization (10-minute `end_at`, `capital_limit_usd=$34`). **Real preflight run immediately before** (10/10 checks, `permitsUniversalTransfer: true`, Spot USDT $36.26, Futures $0.00) and **immediately after** (Spot USDT $5.82, a new `NVDAB` asset present, Futures still $0.00/no position/no orders — independently confirmed against the exchange, not only HedgeOS's own record).

**Result: the stock leg filled for real (0.135 NVDABUSDT @ avg $225.52, order id `55280737`); the hedge leg deferred** — re-deriving the hedge budget from the actual (not estimated) fill notional pushed the quantity below the $5 exchange minimum notional. No automatic funding transfer was attempted (never reached that step, since the hedge was never executable). Full root-cause analysis and a permanent regression test using these exact real numbers: `tests/sizing.test.ts`, describe block "REAL CASE, 2026-09-08 23:55 UTC". Full account-level evidence: `README.md`'s "Live (real-money) proof" section.

**This is not yet a validated complete cycle.** The account currently holds a real, unhedged NVDA position. §10's proposal (a fresh amount, re-run preflight, explicit approval) should be treated as still-open for producing an actual complete hedged cycle — ideally with a small safety margin above the bare calculated minimum next time, given what this attempt demonstrated about zero-margin amounts and normal fill slippage.
