import type { ExecutionAdapter, Fill, SizedLeg, OrderIdempotencyContext } from "./execution.js";
import { newClientOrderId } from "./liveSigning.js";
import {
  buildNewFuturesOrderRequest,
  buildNewSpotOrderRequest,
  buildQueryFuturesOrderRequest,
  buildQuerySpotOrderRequest,
  buildUserTradesRequest,
  buildSpotMyTradesRequest,
  buildSetLeverageRequest,
  buildSetMarginTypeRequest,
  buildGetPositionSideDualRequest,
  buildFuturesAccountV3Request,
  buildFuturesOpenOrdersRequest,
  buildPositionRiskRequest,
  buildSpotAccountRequest,
  reconcileOrder,
  type RawOrderResponse,
  type RawUserTrade,
  type ReconciledFill,
} from "./liveRequests.js";
import { AmbiguousOutcomeError, BinanceApiError, RealLiveHttpClient, type LiveHttpClient } from "./liveHttp.js";

export interface LiveCredentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * Fail-closed gate: EVERY one of these must hold before LiveExecutionAdapter
 * will even construct, let alone place an order. None of these values exist
 * in this project's environment as of this writing — see
 * LIVE_TRADING_READINESS.md §6 for the human checklist that must be
 * completed first. This function does not create, request, or suggest a
 * way to set any of these; it only checks.
 */
export function assertLiveTradingGate(env: NodeJS.ProcessEnv = process.env): LiveCredentials {
  const mode = (env.HEDGEOS_MODE ?? "paper").toLowerCase();
  if (mode !== "live") {
    throw new Error("assertLiveTradingGate called but HEDGEOS_MODE is not 'live'");
  }
  const confirmed = env.HEDGEOS_LIVE_TRADING_CONFIRMED;
  if (confirmed !== "I_UNDERSTAND_THE_RISK") {
    throw new Error(
      "Live trading gate refused: HEDGEOS_LIVE_TRADING_CONFIRMED must be exactly 'I_UNDERSTAND_THE_RISK'. " +
        "This is a deliberate second confirmation independent of HEDGEOS_MODE=live, so a single misconfigured " +
        "env var can never silently enable real order placement.",
    );
  }
  const checklistDone = env.HEDGEOS_LIVE_CHECKLIST_COMPLETE;
  if (checklistDone !== "yes") {
    throw new Error(
      "Live trading gate refused: HEDGEOS_LIVE_CHECKLIST_COMPLETE must be 'yes'. " +
        "Complete every item in LIVE_TRADING_READINESS.md §6 (Futures onboarding, bStock/ADGM eligibility, " +
        "TradFi-Perps agreement, Futures-enabled API key) before setting this.",
    );
  }
  const apiKey = env.BINANCE_API_KEY;
  const apiSecret = env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error(
      "Live trading gate refused: BINANCE_API_KEY / BINANCE_API_SECRET are not set. " +
        "HedgeOS will not create, request, or fabricate credentials — set these yourself, in the environment only, never in source or chat.",
    );
  }
  return { apiKey, apiSecret };
}

function isOrderNotFoundError(err: unknown): boolean {
  // Binance's documented code for "order does not exist" on both Spot and
  // Futures query-order endpoints is -2013. We check the code, not a
  // fragile message string, but we do NOT invent other codes we haven't
  // verified — anything else is treated as a genuine, unresolved error.
  return err instanceof BinanceApiError && err.code === -2013;
}

/**
 * The core safety property for live order placement: a timeout or network
 * error means we do NOT know whether Binance received and processed the
 * order. We NEVER resubmit blindly. Instead, we query the order by its
 * stable clientOrderId (the same one we would have sent) — if Binance
 * knows about it, that's the real, authoritative outcome; if Binance
 * genuinely has no record of it (-2013), it is safe to place for the first
 * (and only) time. Any other query failure is surfaced as unresolved,
 * requiring manual reconciliation rather than a guess in either direction.
 */
async function placeOrderWithAmbiguityRecovery(
  client: LiveHttpClient,
  place: () => Promise<RawOrderResponse>,
  query: () => Promise<RawOrderResponse>,
): Promise<{ order: RawOrderResponse; recovered: boolean }> {
  try {
    const order = await place();
    return { order, recovered: false };
  } catch (err) {
    const ambiguous = err instanceof AmbiguousOutcomeError;
    // A duplicate newClientOrderId submission is also, functionally,
    // ambiguous from our side: we don't know if OUR earlier attempt placed
    // it or a genuinely different bug did. Recover the same way: ask
    // Binance what it actually knows about that clientOrderId.
    const duplicateLike = err instanceof BinanceApiError && /duplicate|already exist/i.test(err.apiMessage);
    if (!ambiguous && !duplicateLike) throw err;

    let existing: RawOrderResponse;
    try {
      existing = await query();
    } catch (queryErr) {
      if (isOrderNotFoundError(queryErr)) {
        // The original attempt genuinely never reached Binance. Safe to
        // surface as "not placed" — caller decides whether to place once,
        // for the first time, using the exact same clientOrderId.
        throw new AmbiguousOutcomeError(
          `original request was ambiguous (${(err as Error).message}) AND the order does not exist on Binance (-2013) — it was never placed. Safe to place once, same clientOrderId, not yet attempted.`,
          err,
        );
      }
      throw new Error(
        `CANNOT DETERMINE ORDER STATE after an ambiguous placement failure — original error: ${(err as Error).message}; recovery query also failed: ${(queryErr as Error).message}. Manual reconciliation required. Refusing to guess.`,
      );
    }
    return { order: existing, recovered: true };
  }
}

/**
 * A MARKET order's own response can say FILLED microseconds before the
 * trades-query endpoint has indexed the corresponding fills (eventual
 * consistency). Without this retry, that transient lag would make
 * `reconcileOrder` see order.status=FILLED but trades sum=0, and
 * DOWNGRADE a real, complete fill to "partially_filled" — a live-money
 * accounting error, not a cosmetic one. Retries a few times with a short
 * delay ONLY while the order's own status says FILLED/PARTIALLY_FILLED but
 * the independently-read trades don't yet agree; a genuine, stable
 * discrepancy (retried and still disagreeing) is still surfaced as such,
 * never silently accepted.
 */
async function fetchTradesWithReconciliationRetry(
  fetchTrades: () => Promise<RawUserTrade[]>,
  order: RawOrderResponse,
  requestedQty: number,
  maxAttempts = 3,
  delayMs = 400,
): Promise<ReconciledFill> {
  let last: ReconciledFill | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const trades = await fetchTrades();
    last = reconcileOrder(requestedQty, order, trades);
    const orderClaimsExecuted = order.status === "FILLED" || order.status === "PARTIALLY_FILLED";
    if (last.reconciled || !orderClaimsExecuted) return last;
    if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last!;
}

function toRawOrder(resp: {
  orderId: number;
  clientOrderId: string;
  status: string;
  executedQty: string;
  symbol: string;
}): RawOrderResponse {
  return resp;
}

/**
 * Places one leg's order against real, authenticated Binance REST endpoints
 * and reconciles it against independently-read trade data. This function
 * alone is NOT "live trading is on" — it is only ever reached through
 * `LiveExecutionAdapter.placeOrder`, which is only ever constructed after
 * `assertLiveTradingGate` passes (real credentials + two explicit
 * confirmations), which nothing in this repository or its default
 * configuration sets.
 */
export async function placeAndReconcileFuturesOrder(
  client: LiveHttpClient,
  creds: LiveCredentials,
  args: { symbol: string; side: "BUY" | "SELL"; quantity: number; clientOrderId: string; positionSide?: "BOTH" | "LONG" | "SHORT" },
): Promise<ReconciledFill> {
  const { order, recovered } = await placeOrderWithAmbiguityRecovery(
    client,
    () =>
      client.send<{ orderId: number; clientOrderId: string; status: string; executedQty: string; symbol: string }>(
        buildNewFuturesOrderRequest({
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          symbol: args.symbol,
          side: args.side,
          quantity: args.quantity,
          clientOrderId: args.clientOrderId,
          timestamp: Date.now(),
          positionSide: args.positionSide,
          reduceOnly: false,
        }),
      ),
    () =>
      client.send<{ orderId: number; clientOrderId: string; status: string; executedQty: string; symbol: string }>(
        buildQueryFuturesOrderRequest({
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          symbol: args.symbol,
          origClientOrderId: args.clientOrderId,
          timestamp: Date.now(),
        }),
      ),
  );

  const reconciled = await fetchTradesWithReconciliationRetry(
    () => client.send<RawUserTrade[]>(buildUserTradesRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, symbol: args.symbol, orderId: order.orderId, timestamp: Date.now() })),
    toRawOrder(order),
    args.quantity,
  );
  return recovered ? { ...reconciled, discrepancyNote: `${reconciled.discrepancyNote ?? ""} [recovered via query-before-retry after an ambiguous placement outcome]`.trim() } : reconciled;
}

export async function placeAndReconcileSpotOrder(
  client: LiveHttpClient,
  creds: LiveCredentials,
  args: { symbol: string; side: "BUY" | "SELL"; quantity: number; clientOrderId: string },
): Promise<ReconciledFill> {
  const { order, recovered } = await placeOrderWithAmbiguityRecovery(
    client,
    () =>
      client.send<{ orderId: number; clientOrderId: string; status: string; executedQty: string; symbol: string }>(
        buildNewSpotOrderRequest({
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          symbol: args.symbol,
          side: args.side,
          quantity: args.quantity,
          clientOrderId: args.clientOrderId,
          timestamp: Date.now(),
        }),
      ),
    () =>
      client.send<{ orderId: number; clientOrderId: string; status: string; executedQty: string; symbol: string }>(
        buildQuerySpotOrderRequest({
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          symbol: args.symbol,
          origClientOrderId: args.clientOrderId,
          timestamp: Date.now(),
        }),
      ),
  );

  const reconciled = await fetchTradesWithReconciliationRetry(
    () => client.send<RawUserTrade[]>(buildSpotMyTradesRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, symbol: args.symbol, orderId: order.orderId, timestamp: Date.now() })),
    toRawOrder(order),
    args.quantity,
  );
  return recovered ? { ...reconciled, discrepancyNote: `${reconciled.discrepancyNote ?? ""} [recovered via query-before-retry after an ambiguous placement outcome]`.trim() } : reconciled;
}

/**
 * Sets leverage and ISOLATED margin type for the hedge symbol before the
 * short order. Both calls are idempotent by Binance's own design (setting
 * the same leverage/margin type again is a no-op success, not an error) —
 * EXCEPT margin type specifically errors if an open position or order
 * already exists on that symbol at a different margin type (documented
 * behavior), which we surface rather than swallow, since silently
 * continuing with the wrong margin mode is a real-money risk.
 */
export async function configureHedgeAccount(
  client: LiveHttpClient,
  creds: LiveCredentials,
  symbol: string,
  leverage: number,
): Promise<void> {
  await client.send(buildSetLeverageRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, symbol, leverage, timestamp: Date.now() }));
  try {
    await client.send(buildSetMarginTypeRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, symbol, marginType: "ISOLATED", timestamp: Date.now() }));
  } catch (err) {
    // -4046 "No need to change margin type" is the documented no-op case
    // when it's already ISOLATED — anything else (e.g. an open position
    // blocking the change) is rethrown, never swallowed.
    if (err instanceof BinanceApiError && err.code === -4046) return;
    throw err;
  }
}

/**
 * `configureHedgeAccount` SENDS the leverage/margin-type change requests,
 * but a 200 response from `POST /fapi/v1/leverage` / `marginType` is not,
 * by this codebase's own stated principle, proof that the account is
 * actually in the requested state — so this reads it back independently
 * via `GET /fapi/v3/positionRisk` (which reports the account's live
 * leverage/marginType for a symbol even with zero open position, per
 * Binance's stable Futures position-risk schema) and REFUSES to proceed if
 * it doesn't match. This exists specifically because a real account's
 * default (observed this session, via the Binance UI: Cross margin, 20×
 * leverage on a symbol never before configured) can be very different from
 * the 2×/ISOLATED this project's frozen policy requires — silently trusting
 * the "set" call's success response was not good enough for real money.
 */
export async function verifyHedgeAccountConfig(
  client: LiveHttpClient,
  creds: LiveCredentials,
  symbol: string,
  expectedLeverage: number,
): Promise<{ leverage: number; marginType: string }> {
  const rows = await client.send<Array<{ symbol: string; leverage: string; marginType: string }>>(
    buildPositionRiskRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, symbol, timestamp: Date.now() }),
  );
  const row = rows.find((r) => r.symbol === symbol);
  if (!row) {
    throw new Error(`verifyHedgeAccountConfig: positionRisk returned no row for ${symbol} — cannot confirm leverage/margin configuration before placing an order. Refusing to proceed.`);
  }
  const actualLeverage = Number(row.leverage);
  const actualMarginType = row.marginType?.toUpperCase();
  if (actualLeverage !== expectedLeverage) {
    throw new Error(
      `verifyHedgeAccountConfig: ${symbol} leverage is ${actualLeverage}x on the real account, expected ${expectedLeverage}x. ` +
        `The leverage-change call did not take effect as requested (or was overridden). Refusing to place an order at the wrong leverage.`,
    );
  }
  if (actualMarginType !== "ISOLATED") {
    throw new Error(
      `verifyHedgeAccountConfig: ${symbol} margin type is ${row.marginType} on the real account, expected ISOLATED. ` +
        `Refusing to place an order under CROSS margin — this project's policy requires ISOLATED so this position's risk is contained to its own posted margin.`,
    );
  }
  return { leverage: actualLeverage, marginType: actualMarginType };
}

export interface PreflightResult {
  futuresAccountReadable: boolean;
  futuresPositionMode: "one-way" | "hedge" | "unknown";
  spotAccountReadable: boolean;
  existingOpenFuturesOrders: number;
  notes: string[];
}

/**
 * Authenticated, READ-ONLY preflight — run once before a live cycle, not
 * per-order. Confirms the credential can actually read account/position
 * state for THIS account (not just that the symbol is generally listed),
 * per LIVE_TRADING_READINESS.md §5 step 1. Throws nothing on its own;
 * callers decide whether the result is good enough to proceed.
 */
export async function runLivePreflight(client: LiveHttpClient, creds: LiveCredentials, futuresSymbol: string): Promise<PreflightResult> {
  const notes: string[] = [];
  let futuresAccountReadable = false;
  let spotAccountReadable = false;
  let positionMode: "one-way" | "hedge" | "unknown" = "unknown";
  let openOrders = 0;

  try {
    await client.send(buildFuturesAccountV3Request({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, timestamp: Date.now() }));
    futuresAccountReadable = true;
  } catch (err) {
    notes.push(`futures account read failed: ${(err as Error).message}`);
  }

  try {
    await client.send(buildSpotAccountRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, timestamp: Date.now() }));
    spotAccountReadable = true;
  } catch (err) {
    notes.push(`spot account read failed: ${(err as Error).message}`);
  }

  try {
    const dual = await client.send<{ dualSidePosition: boolean }>(
      buildGetPositionSideDualRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, timestamp: Date.now() }),
    );
    positionMode = dual.dualSidePosition ? "hedge" : "one-way";
  } catch (err) {
    notes.push(`position mode read failed: ${(err as Error).message}`);
  }

  try {
    const orders = await client.send<unknown[]>(
      buildFuturesOpenOrdersRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, symbol: futuresSymbol, timestamp: Date.now() }),
    );
    openOrders = orders.length;
  } catch (err) {
    notes.push(`open orders read failed: ${(err as Error).message}`);
  }

  try {
    await client.send(buildPositionRiskRequest({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, symbol: futuresSymbol, timestamp: Date.now() }));
  } catch (err) {
    notes.push(`position risk read failed: ${(err as Error).message}`);
  }

  return { futuresAccountReadable, futuresPositionMode: positionMode, spotAccountReadable, existingOpenFuturesOrders: openOrders, notes };
}

function reconciledToFill(symbol: string, side: "BUY" | "SELL", reconciled: ReconciledFill): Fill {
  const status: Fill["status"] = reconciled.status === "pending" ? "rejected" : reconciled.status === "filled" ? "filled" : reconciled.status;
  return {
    symbol,
    side,
    quantity: reconciled.executedQty,
    price: reconciled.avgFillPrice,
    notionalUsd: Math.round(reconciled.executedQty * reconciled.avgFillPrice * 100) / 100,
    mode: "live",
    orderId: String(reconciled.orderId),
    status,
    reason: reconciled.status === "pending" ? "order left in a non-terminal state after placement + one reconciliation read — treat as unresolved, requires manual review, do not assume filled or rejected" : reconciled.discrepancyNote,
  };
}

/**
 * The real, credential-authenticated execution adapter. Structurally
 * inert everywhere in this project as shipped: `getExecutionAdapter()`
 * (`execution.ts`) only constructs this after `assertLiveTradingGate`
 * passes, and nothing in this repository, its default env, or its
 * deployment scripts sets HEDGEOS_LIVE_TRADING_CONFIRMED,
 * HEDGEOS_LIVE_CHECKLIST_COMPLETE, or real BINANCE_API_KEY/SECRET values.
 */
export class LiveExecutionAdapter implements ExecutionAdapter {
  mode: "paper" | "live" = "live";
  private cachedPositionSide: "BOTH" | "LONG" | "SHORT" | undefined;

  constructor(
    private readonly creds: LiveCredentials,
    private readonly hedgeLeverage: number,
    private readonly client: LiveHttpClient = new RealLiveHttpClient(),
  ) {}

  /**
   * Reads the account's REAL position mode once (cached for this adapter
   * instance's lifetime — position mode cannot be changed while any
   * position/order is open, so it cannot legitimately change mid-run) and
   * derives the correct `positionSide` for a SHORT-opening SELL order.
   * Hardcoding "BOTH" was a real defect: Binance requires `positionSide`
   * to be `LONG`/`SHORT` (never `BOTH`) when the account is in Hedge Mode,
   * and REJECTS an order that gets this wrong — this must reflect this
   * account's actual configuration, not an assumption.
   */
  private async resolvePositionSide(): Promise<"BOTH" | "LONG" | "SHORT"> {
    if (this.cachedPositionSide) return this.cachedPositionSide;
    const dual = await this.client.send<{ dualSidePosition: boolean }>(
      buildGetPositionSideDualRequest({ apiKey: this.creds.apiKey, apiSecret: this.creds.apiSecret, timestamp: Date.now() }),
    );
    this.cachedPositionSide = dual.dualSidePosition ? "SHORT" : "BOTH";
    return this.cachedPositionSide;
  }

  async placeOrder(symbol: string, side: "BUY" | "SELL", leg: SizedLeg, _referencePrice: number, idempotencyContext?: OrderIdempotencyContext): Promise<Fill> {
    if (!idempotencyContext) {
      throw new Error(
        `LiveExecutionAdapter.placeOrder called for ${symbol} without an OrderIdempotencyContext (strategyId/cycleId/leg). ` +
          `Live orders require a stable clientOrderId derived from the specific due cycle — refusing rather than generating a fresh id that could double-submit on retry.`,
      );
    }
    const clientOrderId = newClientOrderId(idempotencyContext.strategyId, idempotencyContext.cycleId, idempotencyContext.leg);

    if (idempotencyContext.leg === "hedge") {
      const positionSide = await this.resolvePositionSide();
      await configureHedgeAccount(this.client, this.creds, symbol, this.hedgeLeverage);
      // Read back and verify the account is ACTUALLY at the requested
      // leverage/ISOLATED margin before placing any order — never trust the
      // configure call's success response alone. Throws (refuses to place
      // the order) if the real account state doesn't match.
      await verifyHedgeAccountConfig(this.client, this.creds, symbol, this.hedgeLeverage);
      const reconciled = await placeAndReconcileFuturesOrder(this.client, this.creds, { symbol, side, quantity: leg.quantity, clientOrderId, positionSide });
      return reconciledToFill(symbol, side, reconciled);
    }

    const reconciled = await placeAndReconcileSpotOrder(this.client, this.creds, { symbol, side, quantity: leg.quantity, clientOrderId });
    return reconciledToFill(symbol, side, reconciled);
  }
}
