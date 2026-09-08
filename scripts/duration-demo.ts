/**
 * Real, non-mocked demonstration of "Invest $250 in AAPL every week for six
 * months": spawns the actual HedgeOS MCP server as a subprocess and drives
 * it as a real MCP client, exactly as an operator (Claude Code/Codex) would
 * after interpreting that sentence into a concrete endAt.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB_PATH = "./data/duration-demo.db";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB_PATH + suffix)) unlinkSync(TEST_DB_PATH + suffix);
}

function firstText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/server.ts"],
    env: { ...process.env, HEDGEOS_DB_PATH: TEST_DB_PATH, HEDGEOS_MODE: "paper" },
  });
  const client = new Client({ name: "hedgeos-duration-demo", version: "0.1.0" });
  await client.connect(transport);
  console.log("[demo] connected to real HedgeOS MCP server subprocess");

  // The AI operator interprets "for six months" starting NOW (real wall-clock time — the strategy's
  // first due slot defaults to datetime('now') since no firstDueAt is given below) into a concrete date.
  const now = new Date();
  const sixMonthsLater = new Date(now);
  sixMonthsLater.setUTCMonth(sixMonthsLater.getUTCMonth() + 6);
  const endAt = sixMonthsLater.toISOString();
  console.log(`[demo] "for six months" from ${now.toISOString()} -> endAt = ${endAt}`);

  console.log("\n[demo] create_paper_strategy: AAPL, $250/week, endAt =", endAt);
  const created = await client.callTool({
    name: "create_paper_strategy",
    arguments: { ticker: "AAPL", contributionUsd: 250, frequency: "weekly", hedgeLeverage: 2, endAt },
  });
  const createdData = JSON.parse(firstText(created));
  console.log("[demo] created:", JSON.stringify(createdData.created, null, 2));
  console.log("[demo] note:", createdData.note);
  if (createdData.created.end_at !== endAt) throw new Error("endAt was not persisted correctly");
  const strategyId = createdData.created.id;

  const status = await client.callTool({ name: "get_strategy_status", arguments: { strategyId } });
  const statusData = JSON.parse(firstText(status));
  console.log("\n[demo] get_strategy_status.scheduleEnded (should be false, we're at the start):", statusData.scheduleEnded);
  if (statusData.scheduleEnded !== false) throw new Error("schedule should not be ended yet");

  await client.close();
  console.log("\n[demo] ALL CHECKS PASSED — real MCP server, real strategy with an enforced end date, verified via a real client.");
}

main().catch((err) => {
  console.error("[demo] FAILED:", err);
  process.exit(1);
});
