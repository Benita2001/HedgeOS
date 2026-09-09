/**
 * The single, explicitly-authorized real-money execution for this project.
 * Connects to a REAL, EPHEMERAL HedgeOS MCP server session over SSH, with
 * the live-trading and auto-funding gates set ONLY for this one process
 * (never written to the persistent worker's systemd environment). Runs
 * create_live_strategy -> authorize_live_strategy -> trigger_live_cycle,
 * exactly once, for a strategy configured to structurally allow only one
 * cycle (a tight endAt + a capital limit matching the authorized maximum).
 *
 * Authorized configuration (see the conversation this was approved in):
 *   NVDA, $34 USDT total contribution, 2x leverage, 90/10 split,
 *   ISOLATED margin, one-way position mode, auto-funding capped at $3.40.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function firstText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

async function main() {
  const host = process.env.HEDGEOS_DEPLOY_HOST;
  if (!host) throw new Error("Set HEDGEOS_DEPLOY_HOST, e.g. root@<your-host>");

  // The gate confirmation strings below are NOT secrets — they are fixed
  // literal confirmation phrases the code itself requires, unrelated to any
  // credential. The real BINANCE_API_KEY/SECRET are sourced server-side from
  // the protected secrets file and never appear in this script or its args.
  const remoteCommand =
    "sudo -u hedgeos bash -c '" +
    "export PATH=/opt/hedgeos/node/bin:/usr/bin:/bin; " +
    "set -a; source /opt/hedgeos/secrets/live-preflight.env; set +a; " +
    "export HEDGEOS_MODE=live HEDGEOS_LIVE_TRADING_CONFIRMED=I_UNDERSTAND_THE_RISK HEDGEOS_LIVE_CHECKLIST_COMPLETE=yes " +
    "HEDGEOS_FUNDING_MODE=auto HEDGEOS_AUTO_FUNDING_CONFIRMED=I_AUTHORIZE_AUTOMATIC_TRANSFERS " +
    "HEDGEOS_LIVE_HEDGE_LEVERAGE=2; " +
    "cd /opt/hedgeos/app && npx tsx src/mcp/server.ts'";

  const transport = new StdioClientTransport({ command: "ssh", args: ["-o", "BatchMode=yes", host, remoteCommand] });
  const client = new Client({ name: "hedgeos-real-controlled-cycle", version: "0.1.0" });
  await client.connect(transport);
  console.log("[real-cycle] connected — ephemeral MCP session, live+funding gates set for THIS PROCESS ONLY");

  const endAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes — structurally allows only one due cycle
  console.log(`\n[real-cycle] create_live_strategy: NVDA, $34, 2x, endAt=${endAt} (10 min window -> one cycle only)`);
  const created = await client.callTool({
    name: "create_live_strategy",
    arguments: {
      ticker: "NVDA",
      contributionUsd: 34,
      frequency: "daily",
      hedgeLeverage: 2,
      intervalMinutes: 100000, // ~69 days — irrelevant given the 10-minute endAt below; belt-and-suspenders against a second cycle
      endAt,
      capitalLimitUsd: 34, // matches the authorized maximum exactly
      fundingMode: "auto",
      fundingBufferUsd: 0,
      fundingPerCycleCapUsd: 3.40, // the exact authorized cap
      fundingPeriodCapUsd: 3.40,
    },
  });
  console.log(firstText(created));
  const createdData = JSON.parse(firstText(created));
  if (createdData.error) throw new Error(`create_live_strategy failed: ${createdData.error}`);
  const strategyId = createdData.created.id;
  console.log(`[real-cycle] strategy id: ${strategyId}`);

  console.log(`\n[real-cycle] authorize_live_strategy(${strategyId}):`);
  const authorized = await client.callTool({ name: "authorize_live_strategy", arguments: { strategyId } });
  console.log(firstText(authorized));
  const authorizedData = JSON.parse(firstText(authorized));
  if (authorizedData.error) throw new Error(`authorize_live_strategy failed: ${authorizedData.error}`);

  console.log(`\n[real-cycle] trigger_live_cycle(${strategyId}) — THIS IS THE REAL EXECUTION:`);
  const triggered = await client.callTool({ name: "trigger_live_cycle", arguments: { strategyId } });
  console.log(firstText(triggered));

  console.log(`\n[real-cycle] get_strategy_status(${strategyId}) after execution:`);
  const status = await client.callTool({ name: "get_strategy_status", arguments: { strategyId } });
  console.log(firstText(status));

  console.log(`\n[real-cycle] list_receipts for this execution:`);
  const triggeredData = JSON.parse(firstText(triggered));
  if (triggeredData.receipt?.executionId) {
    const receipts = await client.callTool({ name: "list_receipts", arguments: { executionId: triggeredData.receipt.executionId } });
    console.log(firstText(receipts));
  }

  await client.close();
  console.log("\n[real-cycle] session closed. The live/funding gate env vars existed only inside that ephemeral SSH-spawned process — nothing persisted to the worker's systemd environment.");
}

main().catch((err) => {
  console.error("[real-cycle] FAILED:", (err as Error).message);
  process.exit(1);
});
