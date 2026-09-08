function round(n: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

export interface Fill {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  notionalUsd: number;
  mode: "paper" | "live";
  orderId: string;
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
 * Paper adapter: fills instantly at the real, live reference price fetched
 * moments earlier from Binance's public market-data API. No fabricated
 * prices — the market data is real, only the fill/settlement is simulated.
 * Every receipt is labeled mode="paper" so it can never be confused with a
 * real trade in the DB, dashboard, or MCP tool output.
 */
export class PaperExecutionAdapter implements ExecutionAdapter {
  mode: "paper" | "live" = "paper";
  private counter = 0;

  async placeOrder(symbol: string, side: "BUY" | "SELL", leg: SizedLeg, referencePrice: number): Promise<Fill> {
    this.counter += 1;
    const notionalUsd = leg.notionalUsd ?? leg.actualShortNotionalUsd ?? round(leg.quantity * referencePrice, 2);
    return {
      symbol,
      side,
      quantity: leg.quantity,
      price: referencePrice,
      notionalUsd,
      mode: "paper",
      orderId: `paper-${Date.now()}-${this.counter}`,
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
