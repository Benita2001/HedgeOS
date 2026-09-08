# HedgeOS — Live Trading Readiness (Hedge Leg)

Status: **NO-GO for live execution right now.** This corrects the prior framing: paper mode is the development/fallback environment, not the end goal — live, authorized execution of the real 90/10 + 2x/3x-hedge strategy is the actual target, gated on the human prerequisites below. Nothing here changes the approved strategy, and no proxy/inverse-ETF substitute is proposed for the live proof — the hedge stays the exact matching TRADIFI_PERPETUAL short throughout.

This document is planning/verification only. No credentials created, no agreements signed, no permissions changed, no orders placed. `LiveExecutionAdapter` remains hard-disabled (the worker refuses to start under `HEDGEOS_MODE=live`, unchanged from Milestone 2) until every item below is checked off **by you**.

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
- `POST /fapi/v1/stock/contract` — "sign TradFi-Perps agreement," added to Binance's official changelog **2025-12-11**. A parallel Portfolio-Margin route (`POST /papi/v1/um/stock/contract`) was added 2026-04-08. Exact error behavior for an unsigned account calling `/fapi/v1/order` on a TRADIFI_PERPETUAL symbol is **still unverified** — not found in any fetched doc content, and I won't guess it.

Sources: [Trade — Futures (USDⓈ-M) REST API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade), [Position Information V3](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Position-Information-V3), [Account Information V3](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Account-Information-V3), [Derivatives API Change Log](https://developers.binance.com/docs/derivatives/change-log).

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

## 4. Smallest exchange-valid live test — proposed budget

Using the approved 90/10 split and the live exchange filters already verified in Phase 0/Milestone 1 (both legs: `minNotional $5`; spot `stepSize 0.001`; futures `stepSize 0.01`) and current prices (~$230s at time of writing, will drift — the deterministic sizing engine re-reads live prices at execution time regardless):

| Parameter | Value | Why |
|---|---|---|
| Total contribution | **$30** | Smallest amount where both legs clear $5 minNotional with comfortable rounding headroom |
| Stock allocation (90%) | $27 → NVDABUSDT buy | Well above $5 min; a few % of rounding slack costs nothing |
| Hedge collateral budget (10%) | $3 | Per policy — this is the margin budget, not the notional |
| Hedge leverage | **3x** (the optional tier, not the 2x default) | At $3 budget, 3x gives a $9 pre-rounding target notional — safely clear of the $5 floor after step-rounding. At 2x the pre-rounding target is only $6, which is thinner margin against rounding pushing it under $5 and getting deferred instead of executed — not what you want for a proof-of-execution test. |
| Target hedge notional | ~$9 (pre-rounding) | `hedgeBudget × leverage`, per the already-implemented and tested sizing engine |
| Margin mode | **ISOLATED**, not CROSS | Caps this position's maximum possible loss at the ~$3 posted margin — it cannot draw down the rest of the account. Explicitly recommended, not the exchange default. |
| Estimated fees | ~$0.03 total | $27 × ~0.1% spot taker + $9 × ~0.05% futures taker, both documented estimates, not fee-tier-verified |
| Maintenance margin cushion | $9 × 2.5% ≈ $0.23 vs. ~$3 posted margin | Enormous buffer at this size — real risk here is operational (did the order do what we asked), not liquidation risk |
| **Strict maximum loss budget** | **$30 (the full contribution)**, hard cap | Worst case: stock leg goes to zero (not realistic in a test window) + hedge margin ($3, isolated) fully lost. Set this as a walk-away number before starting — if anything about the fills looks wrong, stop and reconcile rather than continuing. |

This is a **proof-of-execution** test, not a demo of the strategy's economics — its only job is to prove one real, authorized, reconciled fill on each leg exists.

## 5. Gate before `LiveExecutionAdapter` is ever enabled — unchanged, restated explicitly

All of the following must be true, in this order, before any live order is placed:
1. Authenticated **read-only** checks pass: `GET /fapi/v3/account`, `GET /fapi/v3/positionRisk`, `GET /fapi/v1/symbolConfig` for the target symbol — confirming the credential actually has the permissions and the symbol is tradable *for this account specifically* (not just generally listed).
2. Deterministic sizing/risk tests already pass (they do — 31/31 from Milestones 1–2, unchanged).
3. A dry-run of the exact order payload is logged and reviewed by you before submission.
4. **Your explicit, per-order authorization** — not a standing "go ahead," a specific yes for this specific test.
5. Immediately after any live order: reconciliation via `GET /fapi/v1/order` + `GET /fapi/v1/userTrades` + `GET /fapi/v3/positionRisk`, comparing actual fill qty/price against what was requested, before the receipt is ever labeled anything other than pending-verification.

Until all five are true, `HEDGEOS_MODE=live` continues to hard-refuse at worker startup, exactly as built in Milestone 2.

## 6. Human checklist (for you — nothing here is performed by HedgeOS or by me)

- [ ] Futures risk quiz completed / Futures wallet active
- [ ] bStock/ADGM eligibility confirmed for this account
- [ ] Opened the target TRADIFI_PERPETUAL pair in the Binance UI and resolved whatever agreement/disclosure step appears
- [ ] Confirmed whether the Agentic sub-account has a Futures wallet, or decided to use a separate credential for the hedge leg
- [ ] Created/edited a Futures-enabled API key (Trade + Read only, no withdrawal), created *after* Futures activation
- [ ] Key placed in `.env` (`BINANCE_API_KEY` / `BINANCE_API_SECRET`) — never pasted into chat, never committed
- [ ] Reviewed and accepted the §4 minimal-test budget and §4 maximum-loss cap
- [ ] Ready to give explicit per-order authorization at test time

## 7. Paper-mode work continues unblocked

This readiness track runs in parallel and changes nothing about the existing paper-mode worker, scheduler, or receipts (Milestones 1–2). The autonomous demo path (discovery → deterministic sizing → paper execution → persistence → scheduling → crash recovery) remains the fallback and the current, working evidence — this document does not put it on hold, and paper mode is not being presented as inferior filler; it's the proven backbone regardless of how far live-readiness gets before the deadline.

## GO / NO-GO

**NO-GO for live execution as of this writing.** Every item in §6 is unchecked, and at least two are genuine unknowns requiring your direct confirmation in the Binance UI (bStock/ADGM eligibility specifically, and whether the Agentic sub-account supports Futures at all), not just paperwork I can rush through. I have not claimed, and will not claim, that live execution "works" until an actual authorized order and its independent read-back both exist.

**If you complete §6** before the deadline, the next concrete step is a small **read-only preflight script** (`GET /fapi/v3/account`, `GET /fapi/v3/positionRisk`, `GET /fapi/v1/symbolConfig`) to verify the credential's real permissions against this account — built and run only once a credential actually exists, since there's nothing to test against before then.
