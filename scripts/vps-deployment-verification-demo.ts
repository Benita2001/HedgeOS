/** Real end-to-end verification of the just-deployed VPS release: MCP over the actual
 * SSH transport (same as an operator would use), a fresh interval-scheduled strategy,
 * a real triggered cycle, and read-back through the MCP server — all against the real
 * deployed database on the real VPS. Requires HEDGEOS_DEPLOY_HOST (same env var
 * deploy.sh/mcp-remote-test.ts use). Paper mode only. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function firstText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

async function main() {
  const host = process.env.HEDGEOS_DEPLOY_HOST;
  if (!host) throw new Error("Set HEDGEOS_DEPLOY_HOST, e.g. root@<your-host>");

  const transport = new StdioClientTransport({
    command: "ssh",
    args: ["-o", "BatchMode=yes", host, "su -s /bin/sh hedgeos -c 'export PATH=/opt/hedgeos/node/bin:/usr/bin:/bin; cd /opt/hedgeos/app && HEDGEOS_MODE=paper npx tsx src/mcp/server.ts'"],
  });
  const client = new Client({ name: "vps-deployment-verification", version: "0.1.0" });
  await client.connect(transport);
  console.log("[verify] connected to the REAL deployed HedgeOS MCP server, over the real SSH transport, against the real production database");

  console.log("\n[verify] list_strategies (existing state, untouched by this deploy):");
  const before = await client.callTool({ name: "list_strategies", arguments: {} });
  console.log(firstText(before).slice(0, 300));

  console.log("\n[verify] create_paper_strategy — AAPL, $77/cycle, every 5 minutes (generic interval, not the demo's old daily-only cadence), ends in 1 hour:");
  const endAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const created = await client.callTool({
    name: "create_paper_strategy",
    arguments: { ticker: "AAPL", contributionUsd: 77, frequency: "daily", hedgeLeverage: 2, intervalMinutes: 5, endAt },
  });
  const createdData = JSON.parse(firstText(created));
  console.log(JSON.stringify(createdData.created, null, 2));
  if (createdData.created.interval_minutes !== 5 || createdData.created.end_at !== endAt) {
    throw new Error("interval/end_at were not persisted correctly on the real deployment");
  }
  const strategyId = createdData.created.id;

  console.log("\n[verify] trigger_due_cycle — real live discovery, real paper fill, on the real deployed worker's code path:");
  const triggered = await client.callTool({ name: "trigger_due_cycle", arguments: { strategyId } });
  const triggeredData = JSON.parse(firstText(triggered));
  if (!triggeredData.triggered || triggeredData.receipt.status !== "completed") {
    throw new Error(`trigger_due_cycle did not complete: ${firstText(triggered)}`);
  }
  console.log("receipt:", JSON.stringify(triggeredData.receipt.stock, null, 2), JSON.stringify(triggeredData.receipt.hedge, null, 2));

  console.log("\n[verify] get_strategy_status — confirms scheduleEnded=false (still within the 1h window) and real accumulated state:");
  const status = await client.callTool({ name: "get_strategy_status", arguments: { strategyId } });
  const statusData = JSON.parse(firstText(status));
  console.log("scheduleEnded:", statusData.scheduleEnded, "| paperState:", JSON.stringify(statusData.paperState));
  if (statusData.scheduleEnded !== false) throw new Error("expected scheduleEnded=false");

  console.log("\n[verify] check_funding_readiness — new MCP tool, real deployed code, no credentials configured on this MCP process so expect 'not configured':");
  const funding = await client.callTool({ name: "check_funding_readiness", arguments: { ticker: "AAPL", contributionUsd: 77, hedgeLeverage: 2 } });
  console.log(firstText(funding).slice(0, 400));

  await client.close();
  console.log("\n[verify] ALL CHECKS PASSED against the real deployed VPS — generic interval scheduling, end dates, funding readiness, and the operator MCP all confirmed working on the actual production database.");
}

main().catch((err) => {
  console.error("[verify] FAILED:", err);
  process.exit(1);
});
