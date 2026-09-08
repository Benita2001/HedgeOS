import { z } from "zod";
import type { PairDiscoveryResult } from "../binance/client.js";

/**
 * An operator-supplied market observation from an external MCP surface
 * (in practice: Binance's own Agent OS MCP server, called interactively by
 * the operator's Claude session — never by the unattended worker, which has
 * no OAuth session to use). HedgeOS never trusts this input as ground truth
 * for sizing; it is cross-checked against HedgeOS's own live discovery
 * (`discoverPair`, public REST) and only ever attached as source-attributed
 * evidence in a preview response.
 */
export const ExternalObservationSchema = z.object({
  /** Exchange symbol the observation claims to describe, e.g. "NVDABUSDT" or "NVDAUSDT" */
  symbol: z.string().min(1),
  /** Observed price. Never used for sizing — sizing always uses HedgeOS's own live discovery price. */
  price: z.number().positive(),
  /** Who supplied this observation. Only a named, known MCP surface is accepted. */
  source: z.enum(["binance-agent-os-mcp"]),
  /** The exact tool name that was called to obtain this observation, e.g. "mcp__binance-mcp-server__spot_tickerPrice" */
  toolName: z.string().min(1),
  /** ISO 8601 timestamp of when the observation was made (operator-supplied, not server-generated) */
  observedAtIso: z.string().datetime(),
});

export type ExternalObservation = z.infer<typeof ExternalObservationSchema>;

export interface ObservationVerdict {
  symbol: string;
  source: string;
  toolName: string;
  accepted: boolean;
  ageSeconds: number;
  deviationPct: number | null;
  ownPrice: number | null;
  reasons: string[];
}

const MAX_OBSERVATION_AGE_SECONDS = 120;
const MAX_DEVIATION_PCT = 2;

/**
 * Cross-checks one externally-supplied observation against HedgeOS's own
 * independently-fetched discovery result. This is a validation gate, not a
 * price source: the deterministic sizing engine never reads `price` off an
 * ExternalObservation, regardless of this verdict's outcome. Rejection here
 * only ever affects what is *displayed* to the operator as corroborating
 * evidence, never what is *sized* against real exchange filters.
 */
export function validateExternalObservation(
  obs: ExternalObservation,
  discovery: PairDiscoveryResult,
  now: Date = new Date(),
): ObservationVerdict {
  const reasons: string[] = [];

  const isSpotSymbol = obs.symbol === discovery.spotSymbol;
  const isFuturesSymbol = obs.symbol === discovery.futuresSymbol;
  if (!isSpotSymbol && !isFuturesSymbol) {
    reasons.push(`symbol ${obs.symbol} matches neither the discovered spot symbol (${discovery.spotSymbol}) nor futures symbol (${discovery.futuresSymbol})`);
  }

  const ownLeg = isSpotSymbol ? discovery.spot : isFuturesSymbol ? discovery.futures : undefined;
  const ownPrice = ownLeg && "price" in ownLeg ? (ownLeg as { price?: number }).price : ownLeg && "markPrice" in ownLeg ? (ownLeg as { markPrice?: number }).markPrice : undefined;

  if (ownLeg && !ownLeg.tradable) {
    reasons.push(`HedgeOS's own live discovery marked ${obs.symbol} as not tradable/usable (${(ownLeg as { reason?: string }).reason ?? "no reason given"}) — external observation cannot substitute for a failed identity check`);
  }

  const observedAt = new Date(obs.observedAtIso);
  const ageSeconds = (now.getTime() - observedAt.getTime()) / 1000;
  if (!Number.isFinite(ageSeconds) || Number.isNaN(observedAt.getTime())) {
    reasons.push(`observedAtIso "${obs.observedAtIso}" is not a valid timestamp`);
  } else if (ageSeconds < 0) {
    reasons.push(`observedAtIso is in the future (${ageSeconds.toFixed(1)}s) — refusing a claimed observation that can't yet have happened`);
  } else if (ageSeconds > MAX_OBSERVATION_AGE_SECONDS) {
    reasons.push(`observation is ${ageSeconds.toFixed(0)}s old, exceeding the ${MAX_OBSERVATION_AGE_SECONDS}s freshness policy`);
  }

  let deviationPct: number | null = null;
  if (typeof ownPrice === "number" && ownPrice > 0) {
    deviationPct = (Math.abs(obs.price - ownPrice) / ownPrice) * 100;
    if (deviationPct > MAX_DEVIATION_PCT) {
      reasons.push(`observed price ${obs.price} deviates ${deviationPct.toFixed(2)}% from HedgeOS's own live price ${ownPrice}, exceeding the ${MAX_DEVIATION_PCT}% policy`);
    }
  } else {
    reasons.push(`HedgeOS has no own live price for ${obs.symbol} to cross-check against`);
  }

  return {
    symbol: obs.symbol,
    source: obs.source,
    toolName: obs.toolName,
    accepted: reasons.length === 0,
    ageSeconds: Number.isFinite(ageSeconds) ? Math.round(ageSeconds * 10) / 10 : NaN,
    deviationPct: deviationPct === null ? null : Math.round(deviationPct * 100) / 100,
    ownPrice: typeof ownPrice === "number" ? ownPrice : null,
    reasons,
  };
}
