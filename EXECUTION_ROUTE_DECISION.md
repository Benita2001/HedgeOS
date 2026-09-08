# HedgeOS — Hedge Execution Route Decision

Status: **BLOCKED pending human setup — recommendation is paper-mode hedge for the hackathon submission.**
This is a findings/decision document only. No code, schema, or strategy behavior was changed to produce it.

## 1. Confirmed MCP capability (from live inspection, prior turn)
`binance-mcp-server` exposes bStock Spot market-data/trading schemas and TradFi-perpetual market-data/position-read schemas. It exposes **no** Futures order-placement, leverage-change, or margin-type-change tools. The current credential additionally has Futures trading disabled at the account level. Neither fact is inferred — both were stated as already-verified in the prompt driving this task, not re-derived here.

## 2. Official USDⓈ-M Futures REST endpoints (verified via developers.binance.com)
Generic endpoints, all under `https://fapi.binance.com`:
- `POST /fapi/v1/order` — new order (TRADE)
- `GET /fapi/v1/order` — query order (USER_DATA)
- `GET /fapi/v1/userTrades` — account trade list / reconciliation (USER_DATA)
- `POST /fapi/v1/leverage` — change initial leverage (TRADE)
- `POST /fapi/v1/marginType` — change margin type, isolated/cross (TRADE)
- `POST /fapi/v1/positionSide/dual` — change position mode, hedge/one-way (TRADE)

Source: [Trade — Futures (USDⓈ-M) REST API catalog](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade)

**These are documented as generic — nothing in their own reference pages singles out TRADIFI_PERPETUAL contracts as unsupported.** That is a real signal, not proof of unrestricted access — see §3.

## 3. Product-specific restriction found (this is the answer to "does additional gating apply")
A separate, dedicated endpoint exists specifically for TradFi perpetuals:

- `POST /fapi/v1/stock/contract` — "sign TradFi-Perps agreement contract" (USER_DATA), added to the official changelog **2025-12-11**. A parallel Portfolio-Margin variant, `POST /papi/v1/um/stock/contract`, was added **2026-04-08**.

Source: [Binance Derivatives API Change Log](https://developers.binance.com/docs/derivatives/change-log); endpoint stub also indexed at [Sign TradFi-Perps agreement](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/TradFi-Perps) (full parameter/error-code detail not retrievable through automated fetch — flagged as **unknown, needs direct doc/console confirmation**, not fabricated).

**Verdict on item 2 of the task**: YES, a product-specific restriction is documented — a one-time agreement-signing step gates TradFi-Perps trading, separate from and prior to ordinary `/fapi/v1/order` use. This is the standard Binance pattern for gated products (options, leveraged tokens, etc.), so its existence here is consistent, not surprising. Whether an unsigned account gets a hard error or soft warning on `/fapi/v1/order` for a TRADIFI_PERPETUAL symbol is **unverified** — the exact error code isn't in the fetched content.

## 4. Eligibility (bStocks specifically — a separate, likely stricter gate than the hackathon's own jurisdiction list)
Per Binance's own bStocks explainer: bStocks are issued through an Abu Dhabi Global Markets (ADGM) structure, "not offered to US persons," with the prospectus "only accessible to ADGM-located users," and Binance states it provides "a public REST API with a country eligibility endpoint" for third parties to verify jurisdiction eligibility.

Source: [What Are bStocks? — Binance Academy](https://www.binance.com/en/academy/articles/what-are-bstocks-a-guide-to-tokenized-stocks-on-binance)

**Important finding, not previously flagged**: this ADGM-linked eligibility is likely a *separate, possibly stricter* gate than the hackathon's own US/UK/EEA/HK/Singapore exclusion list you already confirmed you clear. Being hackathon-eligible does not automatically mean bStock/ADGM-eligible. I could not locate the exact eligibility-check endpoint path through search — **unknown, needs direct confirmation** (check inside your own Binance account's bStocks section, or the referenced country-eligibility endpoint once its exact path is found in the console/docs directly).

## 5. Architecture: MCP + direct REST combination — documented, not inferred
Binance's own Agent OS announcement states: "Future releases will add on-chain and payment functionality. Developers can integrate these capabilities immediately through other Binance APIs." This is an explicit, official statement that mixing MCP for what it covers with direct REST for what it doesn't is the sanctioned pattern — not a workaround HedgeOS is inventing.

Source: same Agent OS announcement fetched in Phase 0 ([developers.binance.com/en/docs/agent-native/mcp-server/agentic](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic)).

## 6. No undocumented alternative execution path found
Searched for an official alternative Futures execution interface beyond the connected MCP server and the standard REST API above. Found none. The only additional artifact discovered is the TradFi-Perps agreement-signing endpoint (§3), which is a *prerequisite*, not an *alternative* — it doesn't replace `/fapi/v1/order`, it unlocks it for this product. No undocumented endpoints were used or are being proposed.

## 7. Discovery design correction (documented here; **not yet applied to code**)
Current `discoverPair()` in `src/binance/client.ts` accepts any symbol matching the constructed string `<TICKER>BUSDT` as a bStock purely by naming pattern, without checking the actual metadata Binance returns. This is a real design gap, not just a style nit: a coincidental symbol match (unlikely but not impossible as Binance lists more assets) would be silently accepted as a "verified" bStock.

**Correction identified** (to implement in a future milestone, not now, per this task's boundary):
- Treat the **futures leg** as authoritative for "this ticker is a real TradFi underlying": the already-fetched `underlyingType: "EQUITY"` and `underlyingSubType: ["TradFi"]` fields on the futures contract (confirmed present in the live `NVDAUSDT` response from Phase 0) are Binance's own classification, not a guess.
- Cross-check the **spot leg** by verifying the exchangeInfo response's actual `baseAsset` field equals `<TICKER>B` exactly (this field is already fetched by our code today but never compared — currently unused for validation).
- Best available further authority: a dedicated "Tokenized Assets" / "Exchange Info" endpoint appears to exist under Binance's **Tokenized Stocks Trading API** (sidebar-referenced alongside the confirmed `/sapi/v1/equity/tokenized/{mint,redeem,convert-status,history}` endpoints at [this catalog page](https://developers.binance.com/en/docs/catalog/advanced-trading-stocks-trading/api/rest-api/tokenized)), which would be the most authoritative registry of `underlyingAsset` ↔ `tokenizedAsset` pairs. Its exact path could not be confirmed through automated fetch (the page's JS-rendered sidebar wasn't fully retrievable) — **smallest next validation step**: open that catalog page in a real browser session and copy the exact Market Data endpoint path, or query it directly once available.

## 8. Execution-route decision

| Leg | Route | Status |
|---|---|---|
| Stock (90%, bStock Spot) | Connected `binance-mcp-server` | **Supported** (per your already-verified live inspection) |
| Hedge (10%, TRADIFI_PERPETUAL short) | `binance-mcp-server` | **Unsupported** — no Futures order/leverage/margin tools exposed, and Futures trading is disabled on the current credential |
| Hedge (10%, TRADIFI_PERPETUAL short) | Direct `fapi.binance.com` REST (`/fapi/v1/order`, `/fapi/v1/leverage`, `/fapi/v1/marginType`) | **Documented, officially sanctioned pattern (§5) — but currently UNKNOWN/BLOCKED for this account**, pending: (a) a separate API key with Futures trading permission enabled — none exists; (b) signing the TradFi-Perps agreement via `POST /fapi/v1/stock/contract` — not done; (c) confirming bStock/ADGM-style eligibility doesn't also gate this specific product — unverified |

**This is not a permanent "unsupported" verdict** — it's "the documented path exists, but every prerequisite to use it requires a human action I cannot and should not take unilaterally" (creating credentials, signing a trading agreement, or placing a live order without your explicit authorization).

## 9. Recommendation
**Retain the existing, clearly-labeled paper-mode hedge for the hackathon submission.** Reasons:
- The live-execution path has three unresolved human-gated prerequisites, at least one of which (bStock/ADGM eligibility for the TradFi-perp side specifically) is a genuine unknown, not just paperwork.
- Attempting to rush through credential creation + agreement signing + a live order in the remaining hackathon window risks either a real financial mistake or a rejected/ambiguous order muddying the demo.
- Milestone 1 and 2 already produce a real, evidence-backed autonomous loop (discovery → deterministic sizing → paper execution → persistence → scheduling → recovery) against live market data. Paper mode is explicitly permitted by your own product policy ("Paper execution must remain explicitly labeled simulated") and does not require inventing a substitute instrument — it's the same NVDAUSDT/NVDABUSDT pair, same math, unexecuted live.
- This is **not** a silent scope change: the hedge instrument stays the exact matching TRADIFI_PERPETUAL short, per policy. Nothing is replaced with an inverse ETF or proxy.

If you want to pursue live hedge execution before the deadline anyway, the smallest safe validation step is: you personally (1) create or authorize a Binance API key with Futures trading enabled, (2) call `POST /fapi/v1/stock/contract` once yourself (or explicitly direct me to, with that key made available only via environment variable, never pasted in chat) to sign the agreement, then (3) we attempt one minimal-size order against a TRADIFI_PERPETUAL symbol to observe the actual accept/reject behavior — only after you've explicitly authorized a live order, per the standing Phase 0 rule.

## Unknowns carried forward (explicitly not resolved)
- Exact error/response behavior of `/fapi/v1/order` for an unsigned TradFi-Perps account.
- Exact bStock/ADGM country-eligibility endpoint path and whether it differs from the hackathon's own jurisdiction list.
- Exact path of the Tokenized Stocks "Exchange Info"/"Tokenized Assets" market-data endpoint referenced in the catalog sidebar.
