import { createHmac } from "node:crypto";

/**
 * Binance's documented authentication scheme for signed (TRADE/USER_DATA)
 * REST endpoints: HMAC-SHA256 over the query string, using the API secret
 * as the key, with the resulting hex signature appended as a `signature`
 * parameter. See https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api
 * ("New Order") for the parameter set this is used against.
 */
export function signQueryString(params: Record<string, string | number | boolean>, apiSecret: string): string {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const signature = createHmac("sha256", apiSecret).update(query).digest("hex");
  return `${query}&signature=${signature}`;
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { "X-MBX-APIKEY": apiKey };
}

/**
 * A per-order client identifier HedgeOS controls, independent of whatever
 * order ID Binance assigns. Used for idempotency and reconciliation: if a
 * request times out, re-sending the SAME clientOrderId lets Binance itself
 * reject a true duplicate rather than HedgeOS guessing whether the first
 * attempt succeeded.
 */
export function newClientOrderId(strategyId: number, cycleId: number, leg: "stock" | "hedge"): string {
  return `hedgeos-${strategyId}-${cycleId}-${leg}`;
}
