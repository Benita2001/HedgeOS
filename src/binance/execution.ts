function round(n: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

export type FillStatus = "filled" | "partially_filled" | "rejected";

export interface Fill {
  symbol: string;
  side: "BUY" | "SELL";
  /** Quantity actually filled — may be less than requested (partial fill) or 0 (rejected). */
  quantity: number;
  price: number;
  notionalUsd: number;
  mode: "paper" | "live";
  orderId: string;
  status: FillStatus;
  /** Present when status is "rejected" or "partially_filled" — a paper-mode-simulated reason, explicitly labeled as such. */
  reason?: string;
}

/** Minimal shape both StockLegSizingResult and HedgeLegSizingResult satisfy — an executable leg's quantity/notional. */
export interface SizedLeg {
  quantity: number;
  notionalUsd?: number;
  actualShortNotionalUsd?: number;
}

export interface OrderIdempotencyContext {
  strategyId: number;
  cycleId: number;
  leg: "stock" | "hedge";
}

export interface ExecutionAdapter {
  mode: "paper" | "live";
  /**
   * `idempotencyContext` is optional for the paper adapter (which needs no
   * stable id) but is REQUIRED in practice for the live adapter — it
   * derives the stable clientOrderId a real order must carry so a retry
   * after an ambiguous outcome can never double-submit. See
   * `liveExecution.ts`.
   */
  placeOrder(symbol: string, side: "BUY" | "SELL", leg: SizedLeg, referencePrice: number, idempotencyContext?: OrderIdempotencyContext): Promise<Fill>;
}

/**
 * Injectable simulation hook for tests/demos that need to exercise partial
 * fills, rejections, or slippage deterministically. Returning undefined
 * falls through to the adapter's default (full fill, configured slippage).
 */
export type PaperFillSimulator = (
  symbol: string,
  side: "BUY" | "SELL",
  leg: SizedLeg,
  referencePrice: number,
) => Partial<Pick<Fill, "quantity" | "price" | "status" | "reason">> | undefined;

export interface PaperExecutionConfig {
  /** Adverse slippage in basis points applied to every default (non-simulated) fill. 0 by default — no behavior change unless explicitly configured. */
  slippageBps?: number;
  /** Test/demo-only hook to force a specific fill outcome (partial fill, rejection) for a given order. */
  simulateFill?: PaperFillSimulator;
}

/**
 * Paper adapter: fills at the real, live reference price fetched moments
 * earlier from Binance's public market-data API, adjusted by an explicit,
 * documented slippage assumption (0 unless configured). No fabricated
 * prices — the market data is real, only the fill/settlement is simulated.
 * Every receipt is labeled mode="paper" so it can never be confused with a
 * real trade in the DB, dashboard, or MCP tool output.
 *
 * Default behavior (no config) is unchanged from Milestone 1/2: full fill,
 * zero slippage, status "filled" — existing demos and tests are unaffected.
 * Partial fills and rejections are opt-in via `simulateFill`, so realism
 * testing never introduces nondeterminism into the normal paper-demo path.
 */
export class PaperExecutionAdapter implements ExecutionAdapter {
  mode: "paper" | "live" = "paper";
  private counter = 0;

  constructor(private readonly config: PaperExecutionConfig = {}) {}

  async placeOrder(symbol: string, side: "BUY" | "SELL", leg: SizedLeg, referencePrice: number): Promise<Fill> {
    this.counter += 1;
    const orderId = `paper-${Date.now()}-${this.counter}`;

    const override = this.config.simulateFill?.(symbol, side, leg, referencePrice);

    if (override?.status === "rejected") {
      return {
        symbol,
        side,
        quantity: 0,
        price: 0,
        notionalUsd: 0,
        mode: "paper",
        orderId,
        status: "rejected",
        reason: override.reason ?? "simulated rejection",
      };
    }

    const slippageBps = this.config.slippageBps ?? 0;
    // Adverse slippage: buys fill higher, sells (the hedge short) fill lower — both worse than the observed reference price, never favorable.
    const slippageMultiplier = side === "BUY" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
    const defaultPrice = round(referencePrice * slippageMultiplier, 8);

    const quantity = override?.quantity ?? leg.quantity;
    const price = override?.price ?? defaultPrice;
    const status: FillStatus = override?.status ?? (quantity < leg.quantity ? "partially_filled" : "filled");
    const notionalUsd = round(quantity * price, 2);

    return {
      symbol,
      side,
      quantity,
      price,
      notionalUsd,
      mode: "paper",
      orderId,
      status,
      reason: status === "partially_filled" ? (override?.reason ?? "simulated partial fill — insufficient simulated liquidity at reference price") : undefined,
    };
  }
}

/**
 * Constructs the real live adapter ONLY after every gate in
 * `liveExecution.ts#assertLiveTradingGate` passes: HEDGEOS_MODE=live,
 * HEDGEOS_LIVE_TRADING_CONFIRMED='I_UNDERSTAND_THE_RISK',
 * HEDGEOS_LIVE_CHECKLIST_COMPLETE='yes', and real BINANCE_API_KEY/SECRET.
 * None of these are set anywhere in this repository, its defaults, or its
 * deployment scripts — this remains structurally inert until a human sets
 * all four, deliberately, outside of any code this project ships. The
 * import itself is inert: `liveExecution.ts`/`liveHttp.ts` define request
 * builders and a fetch wrapper, nothing runs at module load time.
 */
export async function getExecutionAdapter(): Promise<ExecutionAdapter> {
  const mode = (process.env.HEDGEOS_MODE ?? "paper").toLowerCase();
  if (mode === "live") {
    const { assertLiveTradingGate, LiveExecutionAdapter } = await import("./liveExecution.js");
    const creds = assertLiveTradingGate();
    const hedgeLeverage = Number(process.env.HEDGEOS_LIVE_HEDGE_LEVERAGE ?? "2");
    return new LiveExecutionAdapter(creds, hedgeLeverage);
  }
  return new PaperExecutionAdapter();
}
