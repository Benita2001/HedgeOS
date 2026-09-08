import { authHeaders, signQueryString } from "./liveSigning.js";

const SPOT_BASE = "https://api.binance.com";
const FUTURES_BASE = "https://fapi.binance.com";

export interface SignedRequest {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
}

/**
 * Pure request builders for the official, verified endpoints (see
 * LIVE_TRADING_READINESS.md §1). These do NOT call fetch — they only
 * construct the exact signed request a live adapter would send, so they
 * can be unit-tested against fixtures without any network access or real
 * credentials, and reviewed for correctness before any live wiring exists.
 */

export function buildNewFuturesOrderRequest(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  clientOrderId: string;
  timestamp: number;
  recvWindow?: number;
  /** BOTH for One-way position mode (the common default), LONG/SHORT required if the account is in Hedge Mode. */
  positionSide?: "BOTH" | "LONG" | "SHORT";
  reduceOnly?: boolean;
}): SignedRequest {
  const params: Record<string, string | number | boolean> = {
    symbol: args.symbol,
    side: args.side,
    type: "MARKET",
    quantity: args.quantity,
    newClientOrderId: args.clientOrderId,
    // RESULT (not the default ACK) returns executedQty/status/avgPrice directly in
    // the response — verified via official docs (New Order, USDⓈ-M Futures REST API).
    // Reconciliation still independently re-derives fill state from userTrades
    // (see reconcileOrder) regardless of what this response says.
    newOrderRespType: "RESULT",
    timestamp: args.timestamp,
    recvWindow: args.recvWindow ?? 5000,
  };
  if (args.positionSide) params.positionSide = args.positionSide;
  if (args.reduceOnly !== undefined) params.reduceOnly = args.reduceOnly;
  const query = signQueryString(params, args.apiSecret);
  return { method: "POST", url: `${FUTURES_BASE}/fapi/v1/order?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildNewSpotOrderRequest(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  clientOrderId: string;
  timestamp: number;
  recvWindow?: number;
}): SignedRequest {
  const query = signQueryString(
    {
      symbol: args.symbol,
      side: args.side,
      type: "MARKET",
      quantity: args.quantity,
      newClientOrderId: args.clientOrderId,
      newOrderRespType: "RESULT",
      timestamp: args.timestamp,
      recvWindow: args.recvWindow ?? 5000,
    },
    args.apiSecret,
  );
  return { method: "POST", url: `${SPOT_BASE}/api/v3/order?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildQuerySpotOrderRequest(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  origClientOrderId: string;
  timestamp: number;
}): SignedRequest {
  const query = signQueryString(
    { symbol: args.symbol, origClientOrderId: args.origClientOrderId, timestamp: args.timestamp },
    args.apiSecret,
  );
  return { method: "GET", url: `${SPOT_BASE}/api/v3/order?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildSpotMyTradesRequest(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  orderId: number;
  timestamp: number;
}): SignedRequest {
  const query = signQueryString({ symbol: args.symbol, orderId: args.orderId, timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${SPOT_BASE}/api/v3/myTrades?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildSpotAccountRequest(args: { apiKey: string; apiSecret: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${SPOT_BASE}/api/v3/account?${query}`, headers: authHeaders(args.apiKey) };
}

/** GET /sapi/v1/account/apiRestrictions — this credential's own permission flags (enableFutures, enableSpotAndMarginTrading, ipRestrict, etc). Verified via official docs 2026-09-08. */
export function buildApiRestrictionsRequest(args: { apiKey: string; apiSecret: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${SPOT_BASE}/sapi/v1/account/apiRestrictions?${query}`, headers: authHeaders(args.apiKey) };
}

/** GET /sapi/v1/account/status — coarse account status (e.g. "Normal"). */
export function buildAccountStatusRequest(args: { apiKey: string; apiSecret: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${SPOT_BASE}/sapi/v1/account/status?${query}`, headers: authHeaders(args.apiKey) };
}

/** GET /sapi/v1/account/info — isMarginEnabled/isFutureEnabled/isOptionsEnabled flags for this account. */
export function buildAccountInfoRequest(args: { apiKey: string; apiSecret: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${SPOT_BASE}/sapi/v1/account/info?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildFuturesAccountV3Request(args: { apiKey: string; apiSecret: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${FUTURES_BASE}/fapi/v3/account?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildFuturesOpenOrdersRequest(args: { apiKey: string; apiSecret: string; symbol: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ symbol: args.symbol, timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${FUTURES_BASE}/fapi/v1/openOrders?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildSpotOpenOrdersRequest(args: { apiKey: string; apiSecret: string; symbol: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ symbol: args.symbol, timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${SPOT_BASE}/api/v3/openOrders?${query}`, headers: authHeaders(args.apiKey) };
}

/** Reads current position mode (One-way vs Hedge) — required to know whether `positionSide` must be sent on new orders. */
export function buildGetPositionSideDualRequest(args: { apiKey: string; apiSecret: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${FUTURES_BASE}/fapi/v1/positionSide/dual?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildQueryFuturesOrderRequest(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  origClientOrderId: string;
  timestamp: number;
}): SignedRequest {
  const query = signQueryString(
    { symbol: args.symbol, origClientOrderId: args.origClientOrderId, timestamp: args.timestamp },
    args.apiSecret,
  );
  return { method: "GET", url: `${FUTURES_BASE}/fapi/v1/order?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildUserTradesRequest(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  orderId: number;
  timestamp: number;
}): SignedRequest {
  const query = signQueryString({ symbol: args.symbol, orderId: args.orderId, timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${FUTURES_BASE}/fapi/v1/userTrades?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildPositionRiskRequest(args: { apiKey: string; apiSecret: string; symbol: string; timestamp: number }): SignedRequest {
  const query = signQueryString({ symbol: args.symbol, timestamp: args.timestamp }, args.apiSecret);
  return { method: "GET", url: `${FUTURES_BASE}/fapi/v3/positionRisk?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildSetLeverageRequest(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  leverage: number;
  timestamp: number;
}): SignedRequest {
  const query = signQueryString({ symbol: args.symbol, leverage: args.leverage, timestamp: args.timestamp }, args.apiSecret);
  return { method: "POST", url: `${FUTURES_BASE}/fapi/v1/leverage?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildSetMarginTypeRequest(args: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  marginType: "ISOLATED" | "CROSSED";
  timestamp: number;
}): SignedRequest {
  const query = signQueryString({ symbol: args.symbol, marginType: args.marginType, timestamp: args.timestamp }, args.apiSecret);
  return { method: "POST", url: `${FUTURES_BASE}/fapi/v1/marginType?${query}`, headers: authHeaders(args.apiKey) };
}

// ---------------------------------------------------------------------------
// Reconciliation: never trust the order-placement response alone. Fill state
// is derived from the order's own status field PLUS an independent read of
// actual trades, and the two must agree before anything is treated as filled.
// ---------------------------------------------------------------------------

export interface RawOrderResponse {
  orderId: number;
  clientOrderId: string;
  status: string; // "NEW" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED" | "EXPIRED" | ...
  executedQty: string;
  symbol: string;
}

export interface RawUserTrade {
  orderId: number;
  qty: string;
  price: string;
  commission: string;
  commissionAsset: string;
}

export interface ReconciledFill {
  orderId: number;
  clientOrderId: string;
  status: "filled" | "partially_filled" | "rejected" | "pending";
  requestedQty: number;
  executedQty: number;
  /** Volume-weighted average fill price computed from actual trades, not a single reported field. */
  avgFillPrice: number;
  totalFeeUsd: number;
  /** True only when the order's own status AND the independently-read trade sum agree on executed quantity. */
  reconciled: boolean;
  discrepancyNote?: string;
}

export function reconcileOrder(requestedQty: number, order: RawOrderResponse, trades: RawUserTrade[]): ReconciledFill {
  const relevantTrades = trades.filter((t) => t.orderId === order.orderId);
  const tradeQty = relevantTrades.reduce((sum, t) => sum + Number(t.qty), 0);
  const orderExecutedQty = Number(order.executedQty);
  const feeUsd = relevantTrades.reduce((sum, t) => sum + Number(t.commission), 0); // assumes fee already in USD-equivalent asset; a real implementation must convert by commissionAsset

  const avgFillPrice =
    tradeQty > 0 ? relevantTrades.reduce((sum, t) => sum + Number(t.qty) * Number(t.price), 0) / tradeQty : 0;

  const qtyDiscrepancy = Math.abs(tradeQty - orderExecutedQty);
  const reconciled = qtyDiscrepancy < 1e-8;

  let status: ReconciledFill["status"];
  if (order.status === "REJECTED" || order.status === "EXPIRED") status = "rejected";
  else if (order.status === "FILLED" && reconciled) status = "filled";
  else if (order.status === "PARTIALLY_FILLED" || (order.status === "FILLED" && !reconciled)) status = "partially_filled";
  else status = "pending";

  return {
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    status,
    requestedQty,
    executedQty: tradeQty, // trust the independently-read trade sum, not the order response's own field, as the ground truth
    avgFillPrice,
    totalFeeUsd: feeUsd,
    reconciled,
    discrepancyNote: reconciled
      ? undefined
      : `order.executedQty=${orderExecutedQty} but sum(userTrades.qty)=${tradeQty} for orderId ${order.orderId} — treat as unresolved until reconciled`,
  };
}

// ---------------------------------------------------------------------------
// Internal Spot<->Futures transfer (POST/GET /sapi/v1/asset/transfer).
// Verified this session: endpoint paths confirmed against developers.binance.com's
// Wallet Asset API endpoint list ("User Universal Transfer" / "Query User Universal
// Transfer History"). The exact `type` enum value and full response schema were
// NOT independently re-fetched field-by-field this session (the docs site did not
// render that detail to automated fetches) — MAIN_UMFUTURE / UMFUTURE_MAIN below
// reflect Binance's long-stable, well-established universal-transfer type naming
// convention, not a fresh line-by-line doc read. Recommend a final manual doc
// check before this is ever used against a real account.
// ---------------------------------------------------------------------------

/** Spot (main) wallet -> USDⓈ-M Futures wallet, the only direction HedgeOS ever needs. */
export const TRANSFER_TYPE_MAIN_TO_UMFUTURE = "MAIN_UMFUTURE";
/** The reverse — kept only for completeness/testing, HedgeOS never initiates this direction. */
export const TRANSFER_TYPE_UMFUTURE_TO_MAIN = "UMFUTURE_MAIN";

export interface RawTransferResponse {
  tranId: number;
}

export interface RawTransferHistoryRow {
  asset: string;
  amount: string;
  type: string;
  status: string; // "CONFIRMED" | "PENDING" | "FAILED", per Binance's documented values
  tranId: number;
  timestamp: number;
}

/**
 * Requires the `enableInternalTransfer` API-key permission specifically —
 * distinct from `enableWithdrawals` (never required or requested by this
 * project) and from `enableSpotAndMarginTrading`/`enableFutures` (trading
 * permissions, already held by this project's real credential per the
 * checkpoint-10 preflight). This is the ONE additional narrow permission
 * automatic funding needs — it does not touch withdrawal capability.
 */
export function buildUserUniversalTransferRequest(args: {
  apiKey: string;
  apiSecret: string;
  type: string;
  asset: string;
  amount: number;
  timestamp: number;
}): SignedRequest {
  const query = signQueryString({ type: args.type, asset: args.asset, amount: args.amount, timestamp: args.timestamp }, args.apiSecret);
  return { method: "POST", url: `${SPOT_BASE}/sapi/v1/asset/transfer?${query}`, headers: authHeaders(args.apiKey) };
}

export function buildTransferHistoryRequest(args: {
  apiKey: string;
  apiSecret: string;
  type: string;
  startTime?: number;
  endTime?: number;
  timestamp: number;
}): SignedRequest {
  const params: Record<string, string | number> = { type: args.type, timestamp: args.timestamp };
  if (args.startTime !== undefined) params.startTime = args.startTime;
  if (args.endTime !== undefined) params.endTime = args.endTime;
  const query = signQueryString(params, args.apiSecret);
  return { method: "GET", url: `${SPOT_BASE}/sapi/v1/asset/transfer?${query}`, headers: authHeaders(args.apiKey) };
}
