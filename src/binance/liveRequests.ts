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
}): SignedRequest {
  const query = signQueryString(
    {
      symbol: args.symbol,
      side: args.side,
      type: "MARKET",
      quantity: args.quantity,
      newClientOrderId: args.clientOrderId,
      timestamp: args.timestamp,
      recvWindow: args.recvWindow ?? 5000,
    },
    args.apiSecret,
  );
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
      timestamp: args.timestamp,
      recvWindow: args.recvWindow ?? 5000,
    },
    args.apiSecret,
  );
  return { method: "POST", url: `${SPOT_BASE}/api/v3/order?${query}`, headers: authHeaders(args.apiKey) };
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
