/** One-off real MCP smoke test for the funding-policy fields on create_paper_strategy. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB_PATH = "./data/funding-policy-demo.db";
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(TEST_DB_PATH + suffix)) unlinkSync(TEST_DB_PATH + suffix);

function firstText(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/server.ts"],
    env: { ...process.env, HEDGEOS_DB_PATH: TEST_DB_PATH, HEDGEOS_MODE: "paper" },
  });
  const client = new Client({ name: "funding-policy-demo", version: "0.1.0" });
  await client.connect(transport);

  console.log("[demo] create_paper_strategy with fundingMode='auto', explicit buffer + per-cycle cap:");
  const created = await client.callTool({
    name: "create_paper_strategy",
    arguments: { ticker: "AAPL", contributionUsd: 63, frequency: "weekly", hedgeLeverage: 2, fundingMode: "auto", fundingBufferUsd: 1, fundingPerCycleCapUsd: 20 },
  });
  console.log(firstText(created));
  const createdData = JSON.parse(firstText(created));
  if (createdData.created.funding_mode !== "auto" || createdData.created.funding_per_cycle_cap_usd !== 20) {
    throw new Error("funding policy fields were not persisted correctly");
  }

  console.log("\n[demo] create_paper_strategy with fundingMode='auto' but NO cap given — must be refused:");
  const rejected = await client.callTool({
    name: "create_paper_strategy",
    arguments: { ticker: "MSFT", contributionUsd: 63, frequency: "weekly", hedgeLeverage: 2, fundingMode: "auto" },
  });
  console.log(firstText(rejected));
  const rejectedData = JSON.parse(firstText(rejected));
  if (!rejectedData.error || !/explicit, positive fundingPerCycleCapUsd/.test(rejectedData.error)) {
    throw new Error("expected create_paper_strategy to refuse auto mode without an explicit cap");
  }

  console.log("\n[demo] default (no fundingMode given) — confirms prefunded stays the default:");
  const defaulted = await client.callTool({
    name: "create_paper_strategy",
    arguments: { ticker: "TSLA", contributionUsd: 63, frequency: "weekly", hedgeLeverage: 2 },
  });
  const defaultedData = JSON.parse(firstText(defaulted));
  if (defaultedData.created.funding_mode !== "prefunded") throw new Error("expected default funding_mode to be prefunded");
  console.log("funding_mode:", defaultedData.created.funding_mode, "(confirmed default)");

  await client.close();
  console.log("\n[demo] ALL CHECKS PASSED — real MCP server, real create_paper_strategy calls, funding policy fields verified.");
}

main().catch((err) => {
  console.error("[demo] FAILED:", err);
  process.exit(1);
});
