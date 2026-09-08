import { describe, expect, it } from "vitest";
import { signQueryString, newClientOrderId } from "../src/binance/liveSigning.js";
import {
  buildNewFuturesOrderRequest,
  buildNewSpotOrderRequest,
  buildSetLeverageRequest,
  buildSetMarginTypeRequest,
  buildPositionRiskRequest,
  reconcileOrder,
  type RawOrderResponse,
  type RawUserTrade,
} from "../src/binance/liveRequests.js";

const FAKE_KEY = "test-api-key-not-real";
const FAKE_SECRET = "test-api-secret-not-real";

describe("liveSigning — HMAC signing (no real credentials, no network)", () => {
  it("produces a deterministic 64-character hex signature for the same input", () => {
    const q1 = signQueryString({ symbol: "NVDAUSDT", side: "SELL", timestamp: 1700000000000 }, FAKE_SECRET);
    const q2 = signQueryString({ symbol: "NVDAUSDT", side: "SELL", timestamp: 1700000000000 }, FAKE_SECRET);
    expect(q1).toEqual(q2); // same input -> same signature, always
    const signature = q1.split("signature=")[1];
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the signature if any parameter changes", () => {
    const q1 = signQueryString({ symbol: "NVDAUSDT", side: "SELL", timestamp: 1700000000000 }, FAKE_SECRET);
    const q2 = signQueryString({ symbol: "NVDAUSDT", side: "BUY", timestamp: 1700000000000 }, FAKE_SECRET);
    expect(q1).not.toEqual(q2);
  });

  it("changes the signature if the secret changes (proves the secret is actually used as the HMAC key)", () => {
    const q1 = signQueryString({ symbol: "NVDAUSDT" }, "secret-a");
    const q2 = signQueryString({ symbol: "NVDAUSDT" }, "secret-b");
    expect(q1.split("signature=")[1]).not.toEqual(q2.split("signature=")[1]);
  });

  it("generates a stable, collision-resistant client order id per (strategy, cycle, leg)", () => {
    expect(newClientOrderId(1, 5, "hedge")).toEqual(newClientOrderId(1, 5, "hedge"));
    expect(newClientOrderId(1, 5, "hedge")).not.toEqual(newClientOrderId(1, 5, "stock"));
    expect(newClientOrderId(1, 5, "hedge")).not.toEqual(newClientOrderId(2, 5, "hedge"));
  });
});

describe("liveRequests — signed request construction (pure, no fetch)", () => {
  it("builds a correctly-shaped futures MARKET order request", () => {
    const req = buildNewFuturesOrderRequest({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      symbol: "NVDAUSDT",
      side: "SELL",
      quantity: 0.08,
      clientOrderId: "hedgeos-1-5-hedge",
      timestamp: 1700000000000,
    });
    expect(req.method).toBe("POST");
    expect(req.url).toContain("https://fapi.binance.com/fapi/v1/order?");
    expect(req.url).toContain("symbol=NVDAUSDT");
    expect(req.url).toContain("side=SELL");
    expect(req.url).toContain("type=MARKET");
    expect(req.url).toContain("newClientOrderId=hedgeos-1-5-hedge");
    expect(req.url).toMatch(/signature=[0-9a-f]{64}$/);
    expect(req.headers["X-MBX-APIKEY"]).toBe(FAKE_KEY);
  });

  it("builds a correctly-shaped spot MARKET order request", () => {
    const req = buildNewSpotOrderRequest({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      symbol: "NVDABUSDT",
      side: "BUY",
      quantity: 0.386,
      clientOrderId: "hedgeos-1-5-stock",
      timestamp: 1700000000000,
    });
    expect(req.url).toContain("https://api.binance.com/api/v3/order?");
    expect(req.url).toContain("side=BUY");
  });

  it("builds leverage and margin-type requests against the verified endpoint paths", () => {
    const lev = buildSetLeverageRequest({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET, symbol: "NVDAUSDT", leverage: 2, timestamp: 1 });
    expect(lev.url).toContain("/fapi/v1/leverage?");
    expect(lev.url).toContain("leverage=2");

    const margin = buildSetMarginTypeRequest({
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      symbol: "NVDAUSDT",
      marginType: "ISOLATED",
      timestamp: 1,
    });
    expect(margin.url).toContain("/fapi/v1/marginType?");
    expect(margin.url).toContain("marginType=ISOLATED");
  });

  it("builds a position-risk read request (for reconciliation, not order placement)", () => {
    const req = buildPositionRiskRequest({ apiKey: FAKE_KEY, apiSecret: FAKE_SECRET, symbol: "NVDAUSDT", timestamp: 1 });
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/fapi/v3/positionRisk?");
  });
});

describe("reconcileOrder — never trusts the order response alone", () => {
  it("marks an order filled only when the order status AND independently-read trades agree", () => {
    const order: RawOrderResponse = { orderId: 42, clientOrderId: "hedgeos-1-5-hedge", status: "FILLED", executedQty: "0.08", symbol: "NVDAUSDT" };
    const trades: RawUserTrade[] = [{ orderId: 42, qty: "0.08", price: "233.20", commission: "0.0093", commissionAsset: "USDT" }];
    const result = reconcileOrder(0.08, order, trades);
    expect(result.status).toBe("filled");
    expect(result.reconciled).toBe(true);
    expect(result.avgFillPrice).toBeCloseTo(233.2, 6);
  });

  it("flags a discrepancy when the order says FILLED but trades don't add up — never silently trusts the order response", () => {
    const order: RawOrderResponse = { orderId: 43, clientOrderId: "x", status: "FILLED", executedQty: "0.08", symbol: "NVDAUSDT" };
    const trades: RawUserTrade[] = [{ orderId: 43, qty: "0.05", price: "233.20", commission: "0.005", commissionAsset: "USDT" }]; // only 0.05 actually traded
    const result = reconcileOrder(0.08, order, trades);
    expect(result.reconciled).toBe(false);
    expect(result.status).toBe("partially_filled"); // downgraded from FILLED because it couldn't be reconciled
    expect(result.discrepancyNote).toBeDefined();
  });

  it("marks REJECTED/EXPIRED orders as rejected regardless of any trade data", () => {
    const order: RawOrderResponse = { orderId: 44, clientOrderId: "x", status: "REJECTED", executedQty: "0", symbol: "NVDAUSDT" };
    const result = reconcileOrder(0.08, order, []);
    expect(result.status).toBe("rejected");
    expect(result.executedQty).toBe(0);
  });

  it("computes volume-weighted average price across multiple partial trades, not a naive average", () => {
    const order: RawOrderResponse = { orderId: 45, clientOrderId: "x", status: "FILLED", executedQty: "0.10", symbol: "NVDAUSDT" };
    const trades: RawUserTrade[] = [
      { orderId: 45, qty: "0.04", price: "230.00", commission: "0", commissionAsset: "USDT" },
      { orderId: 45, qty: "0.06", price: "240.00", commission: "0", commissionAsset: "USDT" },
    ];
    const result = reconcileOrder(0.1, order, trades);
    // VWAP = (0.04*230 + 0.06*240) / 0.10 = 236, NOT the naive average of 235
    expect(result.avgFillPrice).toBeCloseTo(236, 6);
  });
});
