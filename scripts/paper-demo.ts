/**
 * One-off script: runs a single paper-mode DCA+hedge contribution against
 * REAL, LIVE Binance public market data for a caller-supplied ticker. This
 * is not a scheduler and not a persistent worker — it starts, executes
 * exactly one contribution, prints the structured receipt, and exits.
 * Boundary: HEDGEOS_MODE is forced to "paper" here; LiveExecutionAdapter is
 * never reachable from this script.
 *
 * Usage: npx tsx scripts/paper-demo.ts NVDA 100 2
 *        npx tsx scripts/paper-demo.ts DOESNOTEXIST 100 2   (unsupported-pair path)
 */
import { openDb, createStrategy } from "../src/db/index.js";
import { PaperExecutionAdapter } from "../src/binance/execution.js";
import { runContribution } from "../src/worker/runContribution.js";

async function main() {
  const [ticker = "NVDA", contributionArg = "100", leverageArg = "2"] = process.argv.slice(2);
  const contributionUsd = Number(contributionArg);
  const hedgeLeverage = Number(leverageArg);

  const db = openDb(":memory:"); // scratch DB for this one-off demo run only
  const strategy = createStrategy(db, {
    ticker: ticker.toUpperCase(),
    spotSymbol: `${ticker.toUpperCase()}BUSDT`,
    futuresSymbol: `${ticker.toUpperCase()}USDT`,
    contributionUsd,
    frequency: "weekly",
    hedgeLeverage,
  });

  console.log(`\n[HedgeOS paper demo] contribution=$${contributionUsd} ticker=${ticker.toUpperCase()} leverage=${hedgeLeverage}x`);
  console.log("[HedgeOS paper demo] fetching LIVE Binance market data for symbol discovery + pricing...\n");

  const receipt = await runContribution(db, strategy, new PaperExecutionAdapter());

  console.log("=== STRUCTURED RECEIPT (mode=paper, SIMULATED — no live order was placed) ===");
  console.log(JSON.stringify(receipt, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  db.close();
}

main().catch((err) => {
  console.error("[HedgeOS paper demo] failed:", err.message);
  process.exit(1);
});
