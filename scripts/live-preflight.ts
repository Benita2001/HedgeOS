/**
 * Authenticated, READ-ONLY live-account preflight. Deliberately does NOT
 * import assertLiveTradingGate or LiveExecutionAdapter — this script never
 * enables live mode, never requires HEDGEOS_LIVE_TRADING_CONFIRMED or
 * HEDGEOS_LIVE_CHECKLIST_COMPLETE, and calls nothing but GET endpoints.
 * It cannot place an order, change leverage/margin, or sign any agreement.
 *
 * Credentials: reads BINANCE_API_KEY / BINANCE_API_SECRET from process.env
 * ONLY. It never accepts them as CLI arguments (would land in shell
 * history/process list) and never prints them, in full or in part — not
 * even a masked fragment. If you're piping an env file into this process,
 * that file's permissions are your only real control point; this script
 * adds no logging that could leak the values further.
 *
 * Usage (on the VPS, as the hedgeos user, once BINANCE_API_KEY/SECRET are
 * installed in a SEPARATE file from the paper service's .env — see
 * docs/LIVE_PREFLIGHT_SETUP.md):
 *   sudo -u hedgeos bash -c 'set -a; source /opt/hedgeos/secrets/live-preflight.env; set +a; \
 *     cd /opt/hedgeos/app && /opt/hedgeos/node/bin/npx tsx scripts/live-preflight.ts NVDA'
 *
 * Output: a redacted JSON report (permission flags, endpoint success/
 * failure, coarse balance summary, position/order counts, exchange
 * filters) — never full account identifiers, IPs, emails, or any
 * credential fragment.
 */
import {
  buildApiRestrictionsRequest,
  buildAccountStatusRequest,
  buildAccountInfoRequest,
  buildSpotAccountRequest,
  buildSpotOpenOrdersRequest,
  buildFuturesAccountV3Request,
  buildFuturesOpenOrdersRequest,
  buildGetPositionSideDualRequest,
  buildPositionRiskRequest,
} from "../src/binance/liveRequests.js";
import { RealLiveHttpClient, BinanceApiError } from "../src/binance/liveHttp.js";
import { discoverPair } from "../src/binance/client.js";

const ticker = (process.argv[2] ?? "NVDA").toUpperCase();
const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;

interface CheckResult {
  check: string;
  endpoint: string;
  ok: boolean;
  summary: Record<string, unknown> | string;
}

async function safeCheck(check: string, endpoint: string, fn: () => Promise<Record<string, unknown> | string>): Promise<CheckResult> {
  try {
    return { check, endpoint, ok: true, summary: await fn() };
  } catch (err) {
    const message = err instanceof BinanceApiError ? `${err.httpStatus} code=${err.code} ${err.apiMessage}` : (err as Error).message;
    return { check, endpoint, ok: false, summary: message };
  }
}

async function main() {
  if (!apiKey || !apiSecret) {
    console.error(
      "BINANCE_API_KEY / BINANCE_API_SECRET are not set in this process's environment. " +
        "This script reads them from the environment only — see docs/LIVE_PREFLIGHT_SETUP.md for how to install and source them securely. Refusing to proceed.",
    );
    process.exit(1);
  }

  console.log(`[live-preflight] MAIN-ACCOUNT REST credential detected (length only, never printed). Ticker: ${ticker}. This is a read-only check — no order, leverage, margin, or agreement call will be made.\n`);

  const client = new RealLiveHttpClient();
  const creds = { apiKey, apiSecret };
  const ts = () => Date.now();
  const results: CheckResult[] = [];

  results.push(
    await safeCheck("API key permission flags", "GET /sapi/v1/account/apiRestrictions", async () => {
      const r = await client.send<Record<string, unknown>>(buildApiRestrictionsRequest({ ...creds, timestamp: ts() }));
      // permitsUniversalTransfer is a DISTINCT flag from enableInternalTransfer — confirmed via a real
      // Agent OS read earlier this project (a different account showed enableInternalTransfer:false
      // AND permitsUniversalTransfer:true simultaneously) and via community/official-doc search this
      // session. The universal-transfer endpoint (POST /sapi/v1/asset/transfer) requires this flag
      // specifically per Binance's own documentation ("enable Permits Universal Transfer for the API
      // Key") — checking only enableInternalTransfer was an incomplete check, now fixed.
      const { ipRestrict, enableReading, enableWithdrawals, enableInternalTransfer, permitsUniversalTransfer, enableMargin, enableFutures, enableSpotAndMarginTrading } =
        r as Record<string, boolean>;
      return { ipRestrict, enableReading, enableWithdrawals, enableInternalTransfer, permitsUniversalTransfer, enableMargin, enableFutures, enableSpotAndMarginTrading };
    }),
  );

  results.push(
    await safeCheck("Account status", "GET /sapi/v1/account/status", async () => {
      const r = await client.send<{ data?: string }>(buildAccountStatusRequest({ ...creds, timestamp: ts() }));
      return { status: r.data ?? "(no data field returned)" };
    }),
  );

  results.push(
    await safeCheck("Account info (margin/futures/options enabled)", "GET /sapi/v1/account/info", async () => {
      const r = await client.send<Record<string, unknown>>(buildAccountInfoRequest({ ...creds, timestamp: ts() }));
      const { isMarginEnabled, isFutureEnabled, isOptionsEnabled } = r as Record<string, boolean>;
      return { isMarginEnabled, isFutureEnabled, isOptionsEnabled };
    }),
  );

  results.push(
    await safeCheck("Spot account access (main account — NOT the Agentic sub-account)", "GET /api/v3/account", async () => {
      const r = await client.send<{ balances: Array<{ asset: string; free: string; locked: string }>; canTrade?: boolean }>(
        buildSpotAccountRequest({ ...creds, timestamp: ts() }),
      );
      const nonZero = r.balances.filter((b) => Number(b.free) > 0 || Number(b.locked) > 0);
      // Surfaces the USDT amount specifically (the one figure actually needed to plan a real
      // contribution) — not a secret or account identifier, explicitly requested by the account
      // owner. Every other asset's amount stays redacted to a bare symbol, as before.
      const usdt = r.balances.find((b) => b.asset === "USDT");
      return {
        canTrade: r.canTrade,
        nonZeroAssetCount: nonZero.length,
        nonZeroAssets: nonZero.map((b) => b.asset),
        spotUsdtFree: usdt ? Number(usdt.free) : 0,
        spotUsdtLocked: usdt ? Number(usdt.locked) : 0,
      };
    }),
  );

  results.push(
    await safeCheck("USDⓈ-M Futures account access (main account)", "GET /fapi/v3/account", async () => {
      const r = await client.send<{ totalWalletBalance?: string; availableBalance?: string; canTrade?: boolean; assets?: Array<{ asset: string; walletBalance: string }> }>(
        buildFuturesAccountV3Request({ ...creds, timestamp: ts() }),
      );
      const nonZeroAssets = (r.assets ?? []).filter((a) => Number(a.walletBalance) > 0).map((a) => a.asset);
      return { canTrade: r.canTrade, totalWalletBalance: r.totalWalletBalance, availableBalance: r.availableBalance, nonZeroAssets };
    }),
  );

  const discovery = await discoverPair(ticker);
  results.push({
    check: `Exact instrument identity + exchange filters for ${ticker} (public data, not authenticated)`,
    endpoint: "GET /api/v3/exchangeInfo + GET /fapi/v1/exchangeInfo",
    ok: discovery.usableForProtectedDca,
    summary: {
      spotSymbol: discovery.spotSymbol,
      spotTradable: discovery.spot.tradable,
      spotFilters: discovery.spot.filters,
      futuresSymbol: discovery.futuresSymbol,
      futuresTradable: discovery.futures.tradable,
      futuresFilters: discovery.futures.filters,
      futuresContractType: discovery.futures.contractType,
      usableForProtectedDca: discovery.usableForProtectedDca,
    },
  });

  if (discovery.futures.tradable) {
    results.push(
      await safeCheck(`Position mode (One-way vs Hedge)`, "GET /fapi/v1/positionSide/dual", async () => {
        const r = await client.send<{ dualSidePosition: boolean }>(buildGetPositionSideDualRequest({ ...creds, timestamp: ts() }));
        return { dualSidePosition: r.dualSidePosition, mode: r.dualSidePosition ? "hedge" : "one-way" };
      }),
    );

    results.push(
      await safeCheck(`Existing position for ${discovery.futuresSymbol}`, "GET /fapi/v3/positionRisk", async () => {
        const r = await client.send<Array<{ positionAmt: string; entryPrice: string; leverage: string; marginType: string }>>(
          buildPositionRiskRequest({ ...creds, symbol: discovery.futuresSymbol, timestamp: ts() }),
        );
        const withPosition = r.filter((p) => Number(p.positionAmt) !== 0);
        return { openPositionCount: withPosition.length, positions: withPosition.map((p) => ({ positionAmt: p.positionAmt, leverage: p.leverage, marginType: p.marginType })) };
      }),
    );

    results.push(
      await safeCheck(`Open futures orders for ${discovery.futuresSymbol}`, "GET /fapi/v1/openOrders", async () => {
        const r = await client.send<unknown[]>(buildFuturesOpenOrdersRequest({ ...creds, symbol: discovery.futuresSymbol, timestamp: ts() }));
        return { openOrderCount: r.length };
      }),
    );
  }

  if (discovery.spot.tradable) {
    results.push(
      await safeCheck(`Open spot orders for ${discovery.spotSymbol}`, "GET /api/v3/openOrders", async () => {
        const r = await client.send<unknown[]>(buildSpotOpenOrdersRequest({ ...creds, symbol: discovery.spotSymbol, timestamp: ts() }));
        return { openOrderCount: r.length };
      }),
    );
  }

  console.log(JSON.stringify({ ticker, accountContext: "main account (direct REST credential) — NOT the Agentic sub-account", results }, null, 2));

  const anyFailed = results.some((r) => !r.ok);
  console.log(`\n[live-preflight] ${results.filter((r) => r.ok).length}/${results.length} checks succeeded.${anyFailed ? " See failures above for remaining blockers." : ""}`);
  console.log("[live-preflight] LiveExecutionAdapter remains disabled. No order, leverage, margin, or agreement call was made by this script.");
}

main().catch((err) => {
  console.error("[live-preflight] fatal:", (err as Error).message);
  process.exit(1);
});
