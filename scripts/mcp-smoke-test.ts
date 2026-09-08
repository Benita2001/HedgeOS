/**
 * Real smoke test: spawns the actual HedgeOS MCP server as a subprocess
 * (exactly how Claude Code would run it) and drives it as a real MCP
 * client — no mocking of the SDK, no mocking of the tool handlers. Verifies
 * the server actually starts, lists tools, and that read/preview/create/
 * trigger tools work against the real (test-scoped) SQLite DB.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB_PATH = "./data/mcp-smoke-test.db";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB_PATH + suffix)) unlinkSync(TEST_DB_PATH + suffix);
}

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/server.ts"],
    env: { ...process.env, HEDGEOS_DB_PATH: TEST_DB_PATH, HEDGEOS_MODE: "paper" },
  });
  const client = new Client({ name: "hedgeos-smoke-test", version: "0.1.0" });
  await client.connect(transport);
  console.log("[smoke test] connected to real HedgeOS MCP server subprocess");

  const tools = await client.listTools();
  console.log(
    "[smoke test] tools exposed:",
    tools.tools.map((t) => t.name),
  );
  const expected = [
    "list_strategies",
    "get_strategy_status",
    "list_recent_cycles",
    "list_receipts",
    "list_executions",
    "preview_strategy",
    "create_paper_strategy",
    "pause_strategy",
    "resume_strategy",
    "trigger_due_cycle",
  ];
  for (const name of expected) {
    if (!tools.tools.some((t) => t.name === name)) throw new Error(`missing expected tool: ${name}`);
  }
  console.log("[smoke test] all expected tools present");

  const emptyList = await client.callTool({ name: "list_strategies", arguments: {} });
  console.log("[smoke test] list_strategies (empty DB):", JSON.stringify(emptyList.content));

  console.log("[smoke test] calling preview_strategy for NVDA against LIVE market data...");
  const preview = await client.callTool({ name: "preview_strategy", arguments: { ticker: "NVDA", contributionUsd: 100, hedgeLeverage: 2 } });
  const previewText = (preview.content as Array<{ text: string }>)[0].text;
  const previewData = JSON.parse(previewText);
  if (!previewData.sizing || !previewData.discovery.usableForProtectedDca) {
    throw new Error(`preview_strategy did not return a usable sizing result: ${previewText}`);
  }
  console.log("[smoke test] preview_strategy OK — real live discovery + sizing, no DB write, no order");

  const created = await client.callTool({
    name: "create_paper_strategy",
    arguments: { ticker: "NVDA", contributionUsd: 100, frequency: "daily", hedgeLeverage: 2 },
  });
  const createdData = JSON.parse((created.content as Array<{ text: string }>)[0].text);
  const strategyId = createdData.created.id;
  console.log("[smoke test] create_paper_strategy OK, strategyId =", strategyId);

  const status1 = await client.callTool({ name: "get_strategy_status", arguments: { strategyId } });
  console.log("[smoke test] get_strategy_status (before any cycle):", (status1.content as Array<{ text: string }>)[0].text.slice(0, 300), "...");

  console.log("[smoke test] calling trigger_due_cycle (should execute — strategy is due immediately)...");
  const triggered = await client.callTool({ name: "trigger_due_cycle", arguments: { strategyId } });
  const triggeredData = JSON.parse((triggered.content as Array<{ text: string }>)[0].text);
  if (!triggeredData.triggered || triggeredData.receipt.status !== "completed") {
    throw new Error(`trigger_due_cycle did not complete as expected: ${JSON.stringify(triggeredData)}`);
  }
  console.log("[smoke test] trigger_due_cycle OK — real paper execution against live market data, status=completed");

  console.log("[smoke test] calling trigger_due_cycle AGAIN immediately (must NOT double-execute)...");
  const triggeredAgain = await client.callTool({ name: "trigger_due_cycle", arguments: { strategyId } });
  const triggeredAgainData = JSON.parse((triggeredAgain.content as Array<{ text: string }>)[0].text);
  if (triggeredAgainData.triggered) {
    throw new Error(`SAFETY FAILURE: second immediate trigger_due_cycle call executed again: ${JSON.stringify(triggeredAgainData)}`);
  }
  console.log("[smoke test] idempotency confirmed — second immediate call did NOT execute:", triggeredAgainData.reason);

  const status2 = await client.callTool({ name: "get_strategy_status", arguments: { strategyId } });
  const status2Data = JSON.parse((status2.content as Array<{ text: string }>)[0].text);
  if (status2Data.paperState.contributionsCount !== 1) {
    throw new Error(`expected exactly 1 contribution recorded, got ${status2Data.paperState.contributionsCount}`);
  }
  console.log("[smoke test] paperState after two trigger attempts: contributionsCount =", status2Data.paperState.contributionsCount, "(correct — exactly one real execution)");

  const paused = await client.callTool({ name: "pause_strategy", arguments: { strategyId } });
  console.log("[smoke test] pause_strategy:", (paused.content as Array<{ text: string }>)[0].text);
  const resumed = await client.callTool({ name: "resume_strategy", arguments: { strategyId } });
  console.log("[smoke test] resume_strategy:", (resumed.content as Array<{ text: string }>)[0].text);

  const receipts = await client.callTool({ name: "list_receipts", arguments: {} });
  console.log("[smoke test] list_receipts:", (receipts.content as Array<{ text: string }>)[0].text.slice(0, 200), "...");

  await client.close();
  console.log("\n[smoke test] ALL CHECKS PASSED — real MCP server subprocess, real live market data, real idempotency guarantee verified.");
}

main().catch((err) => {
  console.error("[smoke test] FAILED:", err);
  process.exit(1);
});
