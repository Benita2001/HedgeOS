import { describe, expect, it, vi } from "vitest";
import {
  assertLiveTradingGate,
  placeAndReconcileFuturesOrder,
  placeAndReconcileSpotOrder,
  configureHedgeAccount,
  verifyHedgeAccountConfig,
  runLivePreflight,
  LiveExecutionAdapter,
} from "../src/binance/liveExecution.js";
import { AmbiguousOutcomeError, BinanceApiError, type LiveHttpClient } from "../src/binance/liveHttp.js";

const CREDS = { apiKey: "test-key", apiSecret: "test-secret" };
const FULL_GATE_ENV = {
  HEDGEOS_MODE: "live",
  HEDGEOS_LIVE_TRADING_CONFIRMED: "I_UNDERSTAND_THE_RISK",
  HEDGEOS_LIVE_CHECKLIST_COMPLETE: "yes",
  BINANCE_API_KEY: "real-looking-key",
  BINANCE_API_SECRET: "real-looking-secret",
} as NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// Fail-closed gate
// ---------------------------------------------------------------------------

describe("assertLiveTradingGate — fail-closed, every condition required", () => {
  it("throws if HEDGEOS_MODE is not 'live'", () => {
    expect(() => assertLiveTradingGate({ HEDGEOS_MODE: "paper" } as NodeJS.ProcessEnv)).toThrow(/HEDGEOS_MODE is not 'live'/);
  });

  it("throws if the second confirmation is missing or wrong, even with mode=live", () => {
    expect(() => assertLiveTradingGate({ HEDGEOS_MODE: "live" } as NodeJS.ProcessEnv)).toThrow(/HEDGEOS_LIVE_TRADING_CONFIRMED/);
    expect(() => assertLiveTradingGate({ HEDGEOS_MODE: "live", HEDGEOS_LIVE_TRADING_CONFIRMED: "yes please" } as NodeJS.ProcessEnv)).toThrow(
      /HEDGEOS_LIVE_TRADING_CONFIRMED/,
    );
  });

  it("throws if the checklist confirmation is missing", () => {
    expect(() =>
      assertLiveTradingGate({ HEDGEOS_MODE: "live", HEDGEOS_LIVE_TRADING_CONFIRMED: "I_UNDERSTAND_THE_RISK" } as NodeJS.ProcessEnv),
    ).toThrow(/HEDGEOS_LIVE_CHECKLIST_COMPLETE/);
  });

  it("throws if credentials are missing, even with both confirmations present", () => {
    const { BINANCE_API_KEY, BINANCE_API_SECRET, ...withoutCreds } = FULL_GATE_ENV;
    expect(() => assertLiveTradingGate(withoutCreds as NodeJS.ProcessEnv)).toThrow(/BINANCE_API_KEY/);
  });

  it("passes and returns credentials only when every gate holds", () => {
    expect(assertLiveTradingGate(FULL_GATE_ENV)).toEqual({ apiKey: "real-looking-key", apiSecret: "real-looking-secret" });
  });

  it("this project's actual current environment does NOT pass the gate (no real credentials exist)", () => {
    // Documents, as a runtime-checked fact rather than an assertion in prose,
    // that this repository cannot accidentally place a live order today.
    expect(() => assertLiveTradingGate(process.env)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mock LiveHttpClient — a scripted queue of responses/errors, no network
// ---------------------------------------------------------------------------

function mockClient(...responses: Array<unknown | Error>): LiveHttpClient {
  let i = 0;
  const send = vi.fn(async () => {
    const next = responses[i++];
    if (next instanceof Error) throw next;
    return next;
  });
  return { send } as unknown as LiveHttpClient;
}

const RAW_ORDER_FILLED = { orderId: 1, clientOrderId: "hedgeos-1-1-hedge", status: "FILLED", executedQty: "0.08", symbol: "NVDAUSDT" };
const TRADES_FULL = [{ orderId: 1, qty: "0.08", price: "228.00", commission: "0.0091", commissionAsset: "USDT" }];

describe("placeAndReconcileFuturesOrder — successful two-leg-shaped execution", () => {
  it("places and reconciles a clean fill", async () => {
    const client = mockClient(RAW_ORDER_FILLED, TRADES_FULL);
    const result = await placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" });
    expect(result.status).toBe("filled");
    expect(result.reconciled).toBe(true);
    expect(result.executedQty).toBe(0.08);
  });

  it("reports a reconciliation discrepancy when order status and trade sum disagree (never trusts the order response alone) — retried a few times for a persistent discrepancy, not accepted on the first read", async () => {
    const shortTrades = [{ orderId: 1, qty: "0.05", price: "228.00", commission: "0.006", commissionAsset: "USDT" }];
    // Queued 3x: the retry-on-discrepancy loop (fetchTradesWithReconciliationRetry) re-reads trades
    // up to 3 times when the order claims FILLED but the trade sum doesn't yet agree, before accepting
    // it as a genuine (not just transient-indexing-lag) discrepancy.
    const client = mockClient(RAW_ORDER_FILLED, shortTrades, shortTrades, shortTrades);
    const result = await placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" });
    expect(result.reconciled).toBe(false);
    expect(result.status).toBe("partially_filled");
    expect(result.discrepancyNote).toBeDefined();
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4); // order + 3 trade-read attempts
  }, 10000);

  it("marks a rejected order as rejected, no trades assumed", async () => {
    const rejected = { ...RAW_ORDER_FILLED, status: "REJECTED", executedQty: "0" };
    const client = mockClient(rejected, []);
    const result = await placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" });
    expect(result.status).toBe("rejected");
  });
});

describe("placeAndReconcileSpotOrder — stock leg", () => {
  it("places and reconciles a clean spot fill", async () => {
    const order = { orderId: 2, clientOrderId: "hedgeos-1-1-stock", status: "FILLED", executedQty: "0.4", symbol: "NVDABUSDT" };
    const trades = [{ orderId: 2, qty: "0.4", price: "228.00", commission: "0.09", commissionAsset: "USDT" }];
    const client = mockClient(order, trades);
    const result = await placeAndReconcileSpotOrder(client, CREDS, { symbol: "NVDABUSDT", side: "BUY", quantity: 0.4, clientOrderId: "hedgeos-1-1-stock" });
    expect(result.status).toBe("filled");
    expect(result.avgFillPrice).toBeCloseTo(228, 6);
  });
});

// ---------------------------------------------------------------------------
// Ambiguous-outcome recovery: the core "never blindly retry" safety property
// ---------------------------------------------------------------------------

describe("ambiguous outcome recovery — timeouts and duplicate client order ids", () => {
  it("timeout BEFORE exchange acceptance: query confirms the order genuinely does not exist (-2013) — surfaced as never-placed, not silently retried", async () => {
    const client = mockClient(new AmbiguousOutcomeError("network error / timeout"), new BinanceApiError(400, -2013, "Order does not exist."));
    await expect(
      placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" }),
    ).rejects.toThrow(/never placed|not yet attempted/);
  });

  it("timeout AFTER exchange acceptance: query finds the real order that DID go through, and reconciliation uses that real state, not a resubmission", async () => {
    const client = mockClient(new AmbiguousOutcomeError("network error / timeout"), RAW_ORDER_FILLED, TRADES_FULL);
    const result = await placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" });
    expect(result.status).toBe("filled");
    expect(result.discrepancyNote).toMatch(/recovered via query-before-retry/);
    // exactly 3 calls: place (failed), query, trades — never a second place() call
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("duplicate clientOrderId rejection is treated the same way: recover via query, never resubmit", async () => {
    const client = mockClient(new BinanceApiError(400, -4015, "Duplicate order sent."), RAW_ORDER_FILLED, TRADES_FULL);
    const result = await placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" });
    expect(result.status).toBe("filled");
  });

  it("a genuinely unresolved recovery (query itself fails with something other than -2013) refuses to guess", async () => {
    const client = mockClient(new AmbiguousOutcomeError("timeout"), new BinanceApiError(500, undefined, "Internal error"));
    await expect(
      placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" }),
    ).rejects.toThrow(/CANNOT DETERMINE ORDER STATE/);
  });
});

// ---------------------------------------------------------------------------
// Terminal errors that must NOT be treated as ambiguous/recoverable
// ---------------------------------------------------------------------------

describe("terminal errors propagate as-is — never swallowed, never retried", () => {
  it("insufficient margin/balance error propagates unmodified", async () => {
    const client = mockClient(new BinanceApiError(400, -2019, "Margin is insufficient."));
    await expect(
      placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" }),
    ).rejects.toThrow(/Margin is insufficient/);
  });

  it("permission/API-key-scope failure propagates unmodified", async () => {
    const client = mockClient(new BinanceApiError(401, -2015, "Invalid API-key, IP, or permissions for action."));
    await expect(
      placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" }),
    ).rejects.toThrow(/Invalid API-key/);
  });

  it("agreement/eligibility failure (e.g. TradFi-Perps agreement not signed) propagates unmodified, not misclassified as a network issue", async () => {
    const client = mockClient(new BinanceApiError(400, -2010, "Account has not accepted the required trading agreement."));
    await expect(
      placeAndReconcileFuturesOrder(client, CREDS, { symbol: "NVDAUSDT", side: "SELL", quantity: 0.08, clientOrderId: "hedgeos-1-1-hedge" }),
    ).rejects.toThrow(/required trading agreement/);
  });
});

// ---------------------------------------------------------------------------
// Hedge account configuration (leverage / margin type)
// ---------------------------------------------------------------------------

describe("configureHedgeAccount — leverage + isolated margin, idempotent", () => {
  it("sets leverage then margin type successfully", async () => {
    const client = mockClient({ leverage: 2, symbol: "NVDAUSDT" }, { symbol: "NVDAUSDT", marginType: "ISOLATED" });
    await expect(configureHedgeAccount(client, CREDS, "NVDAUSDT", 2)).resolves.toBeUndefined();
  });

  it("treats 'no need to change margin type' (-4046) as a no-op success, not an error", async () => {
    const client = mockClient({ leverage: 2 }, new BinanceApiError(400, -4046, "No need to change margin type."));
    await expect(configureHedgeAccount(client, CREDS, "NVDAUSDT", 2)).resolves.toBeUndefined();
  });

  it("a margin-type change blocked by an existing position is surfaced, never silently ignored", async () => {
    const client = mockClient({ leverage: 2 }, new BinanceApiError(400, -4048, "Margin type cannot be changed if there exists open orders/positions."));
    await expect(configureHedgeAccount(client, CREDS, "NVDAUSDT", 2)).rejects.toThrow(/cannot be changed/);
  });
});

describe("verifyHedgeAccountConfig — never trust the configure call's success response alone", () => {
  it("passes when the read-back confirms the expected leverage and ISOLATED margin", async () => {
    const client = mockClient([{ symbol: "NVDAUSDT", leverage: "2", marginType: "ISOLATED" }]);
    const result = await verifyHedgeAccountConfig(client, CREDS, "NVDAUSDT", 2);
    expect(result).toEqual({ leverage: 2, marginType: "ISOLATED" });
  });

  it("REFUSES when leverage doesn't match — the real-world case observed this session (account defaulted to 20x)", async () => {
    const client = mockClient([{ symbol: "NVDAUSDT", leverage: "20", marginType: "ISOLATED" }]);
    await expect(verifyHedgeAccountConfig(client, CREDS, "NVDAUSDT", 2)).rejects.toThrow(/leverage is 20x on the real account, expected 2x/);
  });

  it("REFUSES when margin type is still CROSS — the real-world case observed this session (account defaulted to Cross)", async () => {
    const client = mockClient([{ symbol: "NVDAUSDT", leverage: "2", marginType: "CROSS" }]);
    await expect(verifyHedgeAccountConfig(client, CREDS, "NVDAUSDT", 2)).rejects.toThrow(/margin type is CROSS.*expected ISOLATED/);
  });

  it("REFUSES when positionRisk returns no row for the symbol at all — never assumes success from silence", async () => {
    const client = mockClient([{ symbol: "SOMEOTHERUSDT", leverage: "2", marginType: "ISOLATED" }]);
    await expect(verifyHedgeAccountConfig(client, CREDS, "NVDAUSDT", 2)).rejects.toThrow(/no row for NVDAUSDT/);
  });

  it("is leverage-generic — verifies against whatever expectedLeverage is passed (2x or 3x), never a hardcoded value", async () => {
    const client3x = mockClient([{ symbol: "NVDAUSDT", leverage: "3", marginType: "ISOLATED" }]);
    await expect(verifyHedgeAccountConfig(client3x, CREDS, "NVDAUSDT", 3)).resolves.toEqual({ leverage: 3, marginType: "ISOLATED" });
    const mismatch = mockClient([{ symbol: "NVDAUSDT", leverage: "3", marginType: "ISOLATED" }]);
    await expect(verifyHedgeAccountConfig(mismatch, CREDS, "NVDAUSDT", 2)).rejects.toThrow(/leverage is 3x on the real account, expected 2x/);
  });
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe("runLivePreflight — read-only account/permission checks", () => {
  it("aggregates successful reads and reports position mode", async () => {
    const client = mockClient(
      { totalWalletBalance: "100" }, // futures account
      { balances: [] }, // spot account
      { dualSidePosition: false }, // position mode
      [], // open orders
      { symbol: "NVDAUSDT" }, // position risk
    );
    const result = await runLivePreflight(client, CREDS, "NVDAUSDT");
    expect(result.futuresAccountReadable).toBe(true);
    expect(result.spotAccountReadable).toBe(true);
    expect(result.futuresPositionMode).toBe("one-way");
    expect(result.existingOpenFuturesOrders).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it("reports hedge position mode distinctly from one-way", async () => {
    const client = mockClient({}, {}, { dualSidePosition: true }, [], {});
    const result = await runLivePreflight(client, CREDS, "NVDAUSDT");
    expect(result.futuresPositionMode).toBe("hedge");
  });

  it("captures partial failures as notes rather than throwing — a preflight report should always come back", async () => {
    const client = mockClient(
      new BinanceApiError(401, -2015, "Invalid API-key, IP, or permissions for action."),
      {},
      { dualSidePosition: false },
      [],
      {},
    );
    const result = await runLivePreflight(client, CREDS, "NVDAUSDT");
    expect(result.futuresAccountReadable).toBe(false);
    expect(result.notes.some((n) => n.includes("futures account read failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LiveExecutionAdapter — the ExecutionAdapter-shaped entry point
// ---------------------------------------------------------------------------

describe("LiveExecutionAdapter", () => {
  it("refuses to place an order without an idempotency context — never generates an ad-hoc clientOrderId", async () => {
    const client = mockClient();
    const adapter = new LiveExecutionAdapter(CREDS, 2, client);
    await expect(adapter.placeOrder("NVDAUSDT", "SELL", { quantity: 0.08 }, 228)).rejects.toThrow(/OrderIdempotencyContext/);
  });

  const VERIFIED_2X_ISOLATED = [{ symbol: "NVDAUSDT", leverage: "2", marginType: "ISOLATED" }];

  it("resolves the account's REAL position mode, configures leverage/margin, VERIFIES it actually took effect, then places+reconciles the hedge leg", async () => {
    const client = mockClient(
      { dualSidePosition: false }, // resolvePositionSide — this account is one-way mode
      {}, // leverage
      {}, // margin type
      VERIFIED_2X_ISOLATED, // verifyHedgeAccountConfig read-back — confirms 2x/ISOLATED actually took effect
      RAW_ORDER_FILLED, // order
      TRADES_FULL, // trades
    );
    const adapter = new LiveExecutionAdapter(CREDS, 2, client);
    const fill = await adapter.placeOrder("NVDAUSDT", "SELL", { quantity: 0.08 }, 228, { strategyId: 1, cycleId: 1, leg: "hedge" });
    expect(fill.status).toBe("filled");
    expect(fill.mode).toBe("live");
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
  });

  it("uses positionSide=SHORT (never BOTH) when the account is actually in Hedge Mode — the real defect this fixes", async () => {
    const client = mockClient({ dualSidePosition: true }, {}, {}, VERIFIED_2X_ISOLATED, RAW_ORDER_FILLED, TRADES_FULL);
    const adapter = new LiveExecutionAdapter(CREDS, 2, client);
    await adapter.placeOrder("NVDAUSDT", "SELL", { quantity: 0.08 }, 228, { strategyId: 1, cycleId: 1, leg: "hedge" });
    // Call index 4 is the new-order request — its URL must carry positionSide=SHORT, not BOTH.
    const orderCallReq = (client.send as ReturnType<typeof vi.fn>).mock.calls[4][0] as { url: string };
    expect(orderCallReq.url).toContain("positionSide=SHORT");
  });

  it("stock leg skips leverage/margin configuration entirely", async () => {
    const order = { orderId: 3, clientOrderId: "hedgeos-1-1-stock", status: "FILLED", executedQty: "0.4", symbol: "NVDABUSDT" };
    const trades = [{ orderId: 3, qty: "0.4", price: "228.00", commission: "0.09", commissionAsset: "USDT" }];
    const client = mockClient(order, trades);
    const adapter = new LiveExecutionAdapter(CREDS, 2, client);
    const fill = await adapter.placeOrder("NVDABUSDT", "BUY", { quantity: 0.4 }, 228, { strategyId: 1, cycleId: 1, leg: "stock" });
    expect(fill.status).toBe("filled");
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2); // order + trades only, no leverage/margin calls
  });

  it("a genuinely unresolved order (still non-terminal after one reconciliation read) is reported as rejected/unresolved, never as filled", async () => {
    const pending = { ...RAW_ORDER_FILLED, status: "NEW", executedQty: "0" };
    const client = mockClient({ dualSidePosition: false }, {}, {}, VERIFIED_2X_ISOLATED, pending, []);
    const adapter = new LiveExecutionAdapter(CREDS, 2, client);
    const fill = await adapter.placeOrder("NVDAUSDT", "SELL", { quantity: 0.08 }, 228, { strategyId: 1, cycleId: 1, leg: "hedge" });
    expect(fill.status).toBe("rejected");
    expect(fill.reason).toMatch(/unresolved/);
  });

  it("REFUSES to place the hedge order if, after configuring, the account is still NOT at the requested leverage — the exact real-world scenario observed this session (account defaulted to Cross/20x)", async () => {
    const client = mockClient(
      { dualSidePosition: false },
      {}, // leverage call "succeeds" per Binance's response...
      {}, // margin call "succeeds"...
      [{ symbol: "NVDAUSDT", leverage: "20", marginType: "CROSS" }], // ...but the read-back proves it did NOT actually take effect
    );
    const adapter = new LiveExecutionAdapter(CREDS, 2, client);
    await expect(adapter.placeOrder("NVDAUSDT", "SELL", { quantity: 0.08 }, 228, { strategyId: 1, cycleId: 1, leg: "hedge" })).rejects.toThrow(/leverage is 20x.*expected 2x/);
  });

  it("REFUSES to place the hedge order if leverage is correct but margin type is still CROSS, not ISOLATED", async () => {
    const client = mockClient({ dualSidePosition: false }, {}, {}, [{ symbol: "NVDAUSDT", leverage: "2", marginType: "CROSS" }]);
    const adapter = new LiveExecutionAdapter(CREDS, 2, client);
    await expect(adapter.placeOrder("NVDAUSDT", "SELL", { quantity: 0.08 }, 228, { strategyId: 1, cycleId: 1, leg: "hedge" })).rejects.toThrow(/margin type is CROSS/);
  });
});
