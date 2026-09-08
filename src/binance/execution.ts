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

export interface ExecutionAdapter {
  mode: "paper" | "live";
  placeOrder(symbol: string, side: "BUY" | "SELL", leg: SizedLeg, referencePrice: number): Promise<Fill>;
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
 * Live adapter is intentionally unimplemented in this build. Placing real
 * orders requires the user's own authorized Binance API credentials with
 * trade scope, which this agent will not create or request on its own.
 * Wiring this up is a deliberate, explicit step, not a silent fallback.
 */
export class LiveExecutionAdapter implements ExecutionAdapter {
  mode: "paper" | "live" = "live";

  async placeOrder(): Promise<Fill> {
    throw new Error(
      "Live execution is not wired up. Set HEDGEOS_MODE=paper, or implement authenticated order placement " +
        "against BINANCE_API_KEY/BINANCE_API_SECRET once you have created and authorized those credentials yourself.",
    );
  }
}

export function getExecutionAdapter(): ExecutionAdapter {
  const mode = (process.env.HEDGEOS_MODE ?? "paper").toLowerCase();
  if (mode === "live") return new LiveExecutionAdapter();
  return new PaperExecutionAdapter();
}
