/**
 * One-off seeding script for the Milestone 2 worker demo: creates a single
 * strategy, due immediately, in the real on-disk DB the worker reads from.
 * Not a persistent process itself — inserts one row and exits.
 */
import { openDb, createStrategy } from "../src/db/index.js";

const [ticker = "NVDA", contributionArg = "100", leverageArg = "2", frequency = "daily"] = process.argv.slice(2);

const db = openDb();
const strategy = createStrategy(db, {
  ticker: ticker.toUpperCase(),
  spotSymbol: `${ticker.toUpperCase()}BUSDT`,
  futuresSymbol: `${ticker.toUpperCase()}USDT`,
  contributionUsd: Number(contributionArg),
  frequency: frequency as "daily" | "weekly" | "monthly",
  hedgeLeverage: Number(leverageArg),
  firstDueAt: new Date().toISOString(), // due immediately, for demo purposes
});

console.log(`Seeded strategy #${strategy.id}: ${strategy.ticker} $${strategy.contribution_usd}/${strategy.frequency} @${strategy.hedge_leverage}x, due at ${strategy.next_due_at}`);
db.close();
