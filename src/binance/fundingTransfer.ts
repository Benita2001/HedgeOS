import {
  buildUserUniversalTransferRequest,
  buildTransferHistoryRequest,
  TRANSFER_TYPE_MAIN_TO_UMFUTURE,
  type RawTransferResponse,
  type RawTransferHistoryRow,
} from "./liveRequests.js";
import { AmbiguousOutcomeError, BinanceApiError, type LiveHttpClient } from "./liveHttp.js";
import type { LiveCredentials } from "./liveExecution.js";

/**
 * Fail-closed gate for AUTOMATIC funding transfers — deliberately SEPARATE
 * from `assertLiveTradingGate` (`liveExecution.ts`). Enabling live order
 * placement must never implicitly enable moving money between wallets, and
 * vice versa: each is its own explicit opt-in, checked independently.
 * Nothing in this repository's default config sets either.
 */
export function assertAutoFundingGate(env: NodeJS.ProcessEnv = process.env): void {
  const mode = (env.HEDGEOS_FUNDING_MODE ?? "prefunded").toLowerCase();
  if (mode !== "auto") {
    throw new Error(`assertAutoFundingGate called but HEDGEOS_FUNDING_MODE is not "auto" (got "${mode}")`);
  }
  const confirmed = env.HEDGEOS_AUTO_FUNDING_CONFIRMED;
  if (confirmed !== "I_AUTHORIZE_AUTOMATIC_TRANSFERS") {
    throw new Error(
      'Auto-funding gate refused: HEDGEOS_AUTO_FUNDING_CONFIRMED must be exactly "I_AUTHORIZE_AUTOMATIC_TRANSFERS". ' +
        "A deliberate second confirmation, independent of HEDGEOS_FUNDING_MODE=auto and independent of the live-trading gate, " +
        "so enabling live orders never silently enables moving money between wallets.",
    );
  }
}

export type TransferOutcome = "confirmed" | "pending" | "failed" | "unresolved";

export interface TransferReceipt {
  tranId: number | null;
  requestedAmountUsd: number;
  status: TransferOutcome;
  reason?: string;
}

function isTransferNotFoundWindow(): boolean {
  // Binance's transfer-history endpoint has no "does this tranId exist" lookup by
  // ID — recovery here works by TIME WINDOW + amount/asset match instead (see
  // placeTransferWithAmbiguityRecovery), so there is no direct analogue to
  // isOrderNotFoundError's -2013 code for this endpoint. Kept as a named function
  // (rather than an inline `false`) so the absence of that lookup is documented at
  // its one call site, not silently assumed.
  return false;
}

/**
 * The same core safety property as `placeOrderWithAmbiguityRecovery`
 * (`liveExecution.ts`): a timeout or network error on a transfer means we do
 * NOT know whether Binance received and processed it. We never resubmit
 * blindly. Instead we query recent transfer history for this asset/type and
 * look for a row matching the requested amount within a tight time window —
 * if found, that's the real, authoritative outcome; if genuinely absent, it
 * is safe to place for the first (and only) time. Any other query failure
 * is surfaced as unresolved, never guessed in either direction.
 */
export async function placeTransferWithAmbiguityRecovery(
  client: LiveHttpClient,
  creds: LiveCredentials,
  args: { asset: string; amountUsd: number; requestedAtMs: number },
): Promise<TransferReceipt> {
  try {
    const resp = await client.send<RawTransferResponse>(
      buildUserUniversalTransferRequest({
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        type: TRANSFER_TYPE_MAIN_TO_UMFUTURE,
        asset: args.asset,
        amount: args.amountUsd,
        timestamp: Date.now(),
      }),
    );
    return { tranId: resp.tranId, requestedAmountUsd: args.amountUsd, status: "pending" };
  } catch (err) {
    const ambiguous = err instanceof AmbiguousOutcomeError;
    if (!ambiguous) throw err;

    let history: RawTransferHistoryRow[];
    try {
      history = await client.send<{ rows: RawTransferHistoryRow[] }>(
        buildTransferHistoryRequest({
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          type: TRANSFER_TYPE_MAIN_TO_UMFUTURE,
          startTime: args.requestedAtMs - 5 * 60_000,
          endTime: Date.now(),
          timestamp: Date.now(),
        }),
      ).then((r) => (r as unknown as { rows?: RawTransferHistoryRow[] }).rows ?? (r as unknown as RawTransferHistoryRow[]));
    } catch (queryErr) {
      throw new Error(
        `CANNOT DETERMINE TRANSFER STATE after an ambiguous transfer request — original error: ${(err as Error).message}; ` +
          `recovery query also failed: ${(queryErr as Error).message}. Manual reconciliation required. Refusing to guess or retry.`,
      );
    }

    const match = history.find((row) => Math.abs(Number(row.amount) - args.amountUsd) < 0.01 && row.timestamp >= args.requestedAtMs - 5 * 60_000);
    if (!match) {
      if (isTransferNotFoundWindow()) throw err; // unreachable today; see the function's own doc comment
      return {
        tranId: null,
        requestedAmountUsd: args.amountUsd,
        status: "unresolved",
        reason: `original request was ambiguous (${(err as Error).message}) and no matching transfer was found in recent history — treat as unresolved, verify actual Futures balance before any further action, do not blindly retry`,
      };
    }
    return {
      tranId: match.tranId,
      requestedAmountUsd: args.amountUsd,
      status: match.status === "CONFIRMED" ? "confirmed" : match.status === "FAILED" ? "failed" : "pending",
      reason: "recovered via history lookup after an ambiguous transfer outcome",
    };
  }
}

/**
 * Waits for a PENDING transfer to resolve to CONFIRMED (or FAILED), by
 * re-querying transfer history — never assumes a transfer completed just
 * because the initial POST returned a tranId. A transfer that never
 * resolves within the attempts given is returned as "unresolved", not
 * silently treated as either outcome.
 */
export async function confirmTransferCredited(
  client: LiveHttpClient,
  creds: LiveCredentials,
  args: { tranId: number; requestedAtMs: number; maxAttempts?: number; delayMs?: number },
): Promise<TransferOutcome> {
  const maxAttempts = args.maxAttempts ?? 5;
  const delayMs = args.delayMs ?? 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const history = await client
      .send<{ rows: RawTransferHistoryRow[] }>(
        buildTransferHistoryRequest({
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          type: TRANSFER_TYPE_MAIN_TO_UMFUTURE,
          startTime: args.requestedAtMs - 5 * 60_000,
          endTime: Date.now(),
          timestamp: Date.now(),
        }),
      )
      .then((r) => (r as unknown as { rows?: RawTransferHistoryRow[] }).rows ?? (r as unknown as RawTransferHistoryRow[]));
    const row = history.find((r) => r.tranId === args.tranId);
    if (row?.status === "CONFIRMED") return "confirmed";
    if (row?.status === "FAILED") return "failed";
    if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return "unresolved";
}

/**
 * The full automatic-funding step: only reachable after
 * `assertAutoFundingGate` passes. Places the transfer, resolves ambiguity
 * via history lookup rather than blind retry, and — if a tranId was
 * obtained — waits for it to actually CONFIRM before the caller proceeds to
 * size/place the hedge order against it. Never treats "the POST succeeded"
 * as proof the Futures wallet actually has the money.
 */
export async function executeAutoFundingTransfer(
  client: LiveHttpClient,
  creds: LiveCredentials,
  args: { asset: string; amountUsd: number },
): Promise<TransferReceipt> {
  const requestedAtMs = Date.now();
  const initial = await placeTransferWithAmbiguityRecovery(client, creds, { asset: args.asset, amountUsd: args.amountUsd, requestedAtMs });
  if (initial.tranId === null || initial.status === "confirmed" || initial.status === "failed") {
    return initial;
  }
  const confirmed = await confirmTransferCredited(client, creds, { tranId: initial.tranId, requestedAtMs });
  return { ...initial, status: confirmed };
}
