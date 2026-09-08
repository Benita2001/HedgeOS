/**
 * Verifies the HedgeOS MCP server as it will actually be used from Claude
 * Code: spawned over SSH on the deployed VPS, stdio transport, using the
 * SAME existing SSH key access already in use throughout this session — no
 * new port, no new credential. Read tools only exercised here (state-
 * changing tools already proven safe in scripts/mcp-smoke-test.ts against
 * the local server; this script's job is to prove the SSH transport path
 * itself works, not to re-run every tool).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "ssh",
    args: [
      "-o", "BatchMode=yes",
      "root@173.212.234.24",
      "su -s /bin/sh hedgeos -c 'export PATH=/opt/hedgeos/node/bin:/usr/bin:/bin; cd /opt/hedgeos/app && HEDGEOS_MODE=paper npx tsx src/mcp/server.ts'",
    ],
  });
  const client = new Client({ name: "hedgeos-remote-verify", version: "0.1.0" });
  await client.connect(transport);
  console.log("[remote MCP test] connected to HedgeOS MCP server over SSH stdio (real VPS, real SSH key, no new port/credential)");

  const tools = await client.listTools();
  console.log("[remote MCP test] tools:", tools.tools.map((t) => t.name));

  const strategies = await client.callTool({ name: "list_strategies", arguments: {} });
  console.log("[remote MCP test] list_strategies:", (strategies.content as Array<{ text: string }>)[0].text);

  const status = await client.callTool({ name: "get_strategy_status", arguments: { strategyId: 1 } });
  console.log("[remote MCP test] get_strategy_status:", (status.content as Array<{ text: string }>)[0].text);

  await client.close();
  console.log("[remote MCP test] PASSED");
}

main().catch((e) => {
  console.error("[remote MCP test] FAILED:", e);
  process.exit(1);
});
