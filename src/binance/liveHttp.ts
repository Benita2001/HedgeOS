import type { SignedRequest } from "./liveRequests.js";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A real Binance REST error response: `{ "code": -1234, "msg": "..." }`.
 * Distinct from a network/timeout failure — this means Binance *received*
 * the request and rejected it, which is a different recovery path (do not
 * retry blindly) than "we don't know if it arrived" (query before retry).
 */
export class BinanceApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: number | undefined,
    public readonly apiMessage: string,
  ) {
    super(`Binance API error ${httpStatus}${code !== undefined ? ` (code ${code})` : ""}: ${apiMessage}`);
    this.name = "BinanceApiError";
  }
}

/**
 * The request timed out or a network-layer error occurred (DNS, connection
 * reset, etc.) — we genuinely do NOT know whether Binance received and
 * processed the order. Callers MUST treat this as ambiguous, never as
 * "it failed, retry" — see `resolveAmbiguousOrderOutcome` in
 * `liveExecution.ts`, which queries actual order state before ever
 * re-submitting.
 */
export class AmbiguousOutcomeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AmbiguousOutcomeError";
  }
}

export interface LiveHttpClient {
  send<T>(req: SignedRequest): Promise<T>;
}

/**
 * Real HTTP transport for signed Binance REST calls. Not used anywhere in
 * this codebase's default runtime path — only `LiveExecutionAdapter`
 * (`liveExecution.ts`) constructs one, and only when `HEDGEOS_MODE=live`
 * plus the full explicit confirmation gate all pass. Every other adapter,
 * and every existing test, is unaffected by this file's existence.
 */
export class RealLiveHttpClient implements LiveHttpClient {
  async send<T>(req: SignedRequest): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(req.url, { method: req.method, headers: req.headers, signal: controller.signal });
    } catch (err) {
      // Network-layer failure or abort: we do not know if Binance received
      // this request. Never classify this as a plain rejection.
      throw new AmbiguousOutcomeError(
        `network error / timeout calling ${req.method} ${req.url.split("?")[0]} — order outcome is UNKNOWN, do not retry blindly: ${(err as Error).message}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    if (!res.ok) {
      const parsed = body as { code?: number; msg?: string } | undefined;
      throw new BinanceApiError(res.status, parsed?.code, parsed?.msg ?? text ?? `HTTP ${res.status}`);
    }
    return body as T;
  }
}
