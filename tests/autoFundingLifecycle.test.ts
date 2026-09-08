import { describe, expect, it, vi } from "vitest";
import { LiveExecutionAdapter } from "../src/binance/liveExecution.js";
import { sizeDcaHedgeContribution } from "../src/engine/sizing.js";
import type { SymbolFilters } from "../src/engine/types.js";
import type { LiveHttpClient } from "../src/binance/liveHttp.js";

const CREDS = { apiKey: "test-key", apiSecret: "test-secret" };
const SPOT_FILTERS: SymbolFilters = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
const HEDGE_FILTERS: SymbolFilters = { stepSize: 0.01, minQty: 0.01, minNotional: 5 };
const PRICE = 226.16;

function mockClient(...responses: Array<unknown | Error>): LiveHttpClient {
  let i = 0;
  const send = vi.fn(async () => {
    const next = responses[i++];
    if (next instanceof Error) throw next;
    return next;
  });
  return { send } as unknown as LiveHttpClient;
}

describe("LiveExecutionAdapter.prepareFunding — the real class, real wiring, mocked HTTP only", () => {
  it("mode='prefunded' (the default): never calls the auto-funding gate or the transfer endpoint, even with a real shortfall", async () => {
    const sizing = sizeDcaHedgeContribution(63, PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
    const client = mockClient({ availableBalance: "0" }); // Futures wallet empty
    const adapter = new LiveExecutionAdapter(CREDS, 2, client); // default policy: prefunded
    const result = await adapter.prepareFunding(sizing, { strategyId: 1, cycleId: 1, leg: "hedge" });
    expect(result.attempted).toBe(false);
    expect(result.plan?.action).toBe("top_up_required");
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // only the balance read, no transfer attempt
  });

  it("mode='auto' with the gate NOT set in env: throws rather than silently transferring", async () => {
    delete process.env.HEDGEOS_FUNDING_MODE;
    delete process.env.HEDGEOS_AUTO_FUNDING_CONFIRMED;
    const sizing = sizeDcaHedgeContribution(63, PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
    const client = mockClient({ availableBalance: "0" });
    const adapter = new LiveExecutionAdapter(CREDS, 2, client, { mode: "auto", bufferUsd: 1, perCycleCapUsd: 20 });
    await expect(adapter.prepareFunding(sizing, { strategyId: 1, cycleId: 1, leg: "hedge" })).rejects.toThrow(/not "auto"/);
  });

  it("mode='auto' WITH the gate set: executes the exact planned transfer, then the caller can proceed to the hedge order — full wiring proven end-to-end", async () => {
    process.env.HEDGEOS_FUNDING_MODE = "auto";
    process.env.HEDGEOS_AUTO_FUNDING_CONFIRMED = "I_AUTHORIZE_AUTOMATIC_TRANSFERS";
    try {
      const sizing = sizeDcaHedgeContribution(63, PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
      const transferAmount = Math.round((sizing.hedge.actualCollateralUsd + sizing.hedge.estimatedFeeUsd + 1) * 100) / 100; // +$1 buffer, matches policy below
      const client = mockClient(
        { availableBalance: "0" }, // prepareFunding's own balance read
        { tranId: 555 }, // the transfer POST
        { rows: [{ asset: "USDT", amount: String(transferAmount), type: "MAIN_UMFUTURE", status: "CONFIRMED", tranId: 555, timestamp: Date.now() }] }, // confirmation poll
      );
      const adapter = new LiveExecutionAdapter(CREDS, 2, client, { mode: "auto", bufferUsd: 1, perCycleCapUsd: 20 });
      const result = await adapter.prepareFunding(sizing, { strategyId: 1, cycleId: 1, leg: "hedge" });
      expect(result.attempted).toBe(true);
      expect(result.transfer?.status).toBe("confirmed");
      expect(result.transfer?.tranId).toBe(555);
      expect(result.plan?.transferAmountUsd).toBeCloseTo(transferAmount, 2);
      expect(result.plan?.transferAmountUsd).toBeLessThanOrEqual(20); // never exceeds the configured per-cycle cap
    } finally {
      delete process.env.HEDGEOS_FUNDING_MODE;
      delete process.env.HEDGEOS_AUTO_FUNDING_CONFIRMED;
    }
  });

  it("mode='auto' but no shortfall exists: never attempts a transfer even with the gate set", async () => {
    process.env.HEDGEOS_FUNDING_MODE = "auto";
    process.env.HEDGEOS_AUTO_FUNDING_CONFIRMED = "I_AUTHORIZE_AUTOMATIC_TRANSFERS";
    try {
      const sizing = sizeDcaHedgeContribution(63, PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
      const client = mockClient({ availableBalance: "1000" }); // already plenty
      const adapter = new LiveExecutionAdapter(CREDS, 2, client, { mode: "auto", bufferUsd: 1, perCycleCapUsd: 20 });
      const result = await adapter.prepareFunding(sizing, { strategyId: 1, cycleId: 1, leg: "hedge" });
      expect(result.attempted).toBe(false);
      expect(result.plan?.action).toBe("none_sufficient");
      expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // balance read only, no transfer call
    } finally {
      delete process.env.HEDGEOS_FUNDING_MODE;
      delete process.env.HEDGEOS_AUTO_FUNDING_CONFIRMED;
    }
  });

  it("hedge leg not executable (below exchange minimum): prepareFunding reports the deferral, reads no balance, attempts nothing", async () => {
    const sizing = sizeDcaHedgeContribution(10, PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
    expect(sizing.hedge.executable).toBe(false);
    const client = mockClient();
    const adapter = new LiveExecutionAdapter(CREDS, 2, client, { mode: "auto", bufferUsd: 1, perCycleCapUsd: 20 });
    const result = await adapter.prepareFunding(sizing, { strategyId: 1, cycleId: 1, leg: "hedge" });
    expect(result.attempted).toBe(false);
    expect(result.plan?.action).toBe("hedge_deferred_no_funding_needed");
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0); // no network call at all
  });

  it("shared-wallet reservation is honored end-to-end through the real adapter — a strategy never treats another strategy's earmarked funds as its own", async () => {
    const sizing = sizeDcaHedgeContribution(63, PRICE, SPOT_FILTERS, HEDGE_FILTERS, { stockFraction: 0.9, hedgeFraction: 0.1, hedgeLeverage: 2 });
    const client = mockClient({ availableBalance: "10" }); // enough for THIS strategy alone, not after reservation
    const adapter = new LiveExecutionAdapter(CREDS, 2, client, { mode: "prefunded", bufferUsd: 1, perCycleCapUsd: 0 }, /* reservedFuturesUsd */ 10);
    const result = await adapter.prepareFunding(sizing, { strategyId: 2, cycleId: 1, leg: "hedge" });
    expect(result.plan?.unreservedFuturesAvailableUsd).toBe(0);
    expect(result.plan?.action).toBe("top_up_required");
  });
});
