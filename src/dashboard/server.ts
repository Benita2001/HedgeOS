import express from "express";
import {
  openDb,
  listStrategies,
  getPaperState,
  getLatestExecution,
  listExecutions,
  listReceipts,
} from "../db/index.js";
import { evaluateRiskAlerts, type LatestExecutionSummary } from "../risk/checks.js";
import { getExecutionAdapter } from "../binance/execution.js";

/**
 * Minimal, read-only dashboard. Built last, per plan, after the autonomous
 * core (worker/scheduler) and the operator interface (MCP server) were
 * solid. Reads the same SQLite database the worker and MCP server use — it
 * does not run the worker itself and has no write/trading capability of
 * its own. Every page prominently labels PAPER MODE; nothing here is ever
 * presented as a live exchange result.
 */

const db = openDb();
const app = express();
const port = Number(process.env.HEDGEOS_DASHBOARD_PORT ?? 8766);
const adapterMode = getExecutionAdapter().mode;

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>HedgeOS</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }
  .banner { background: #fef3c7; border: 1px solid #d97706; color: #92400e; padding: 0.6rem 1rem; border-radius: 6px; font-weight: 600; margin-bottom: 1.5rem; text-align: center; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1.5rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #e5e5e5; }
  th { color: #666; font-weight: 600; }
  .card { background: white; border: 1px solid #e5e5e5; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .stat { display: inline-block; margin-right: 2rem; }
  .stat .value { font-size: 1.3rem; font-weight: 700; }
  .stat .label { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: 0.03em; }
  .alert-warning { color: #b45309; } .alert-critical { color: #b91c1c; font-weight: 700; } .alert-info { color: #555; }
  .status-completed { color: #15803d; } .status-partial_failure { color: #b91c1c; } .status-unsupported_pair { color: #666; }
  code { background: #f1f1f1; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style></head>
<body>
<div class="banner">⚠ PAPER MODE (adapter: ${esc(adapterMode)}) — every fill on this page is simulated. No live order has ever been placed.</div>
${body}
</body></html>`;
}

app.get("/", (_req, res) => {
  const strategies = listStrategies(db);
  if (strategies.length === 0) {
    res.send(layout(`<h1>HedgeOS</h1><p>No strategies yet. Create one via <code>scripts/seed-strategy.ts</code> or the HedgeOS MCP server's <code>create_paper_strategy</code> tool.</p>`));
    return;
  }
  const rows = strategies
    .map(
      (s) =>
        `<tr><td><a href="/strategy/${s.id}">#${s.id} ${esc(s.ticker)}</a></td><td>$${s.contribution_usd}/${esc(s.frequency)}</td><td>${s.hedge_leverage}x</td><td>${esc(s.status)}</td><td>${esc(s.next_due_at)}</td></tr>`,
    )
    .join("\n");
  res.send(
    layout(
      `<h1>HedgeOS — Strategies</h1><table><tr><th>Strategy</th><th>Contribution</th><th>Leverage</th><th>Status</th><th>Next due</th></tr>${rows}</table>`,
    ),
  );
});

app.get("/strategy/:id", (req, res) => {
  const id = Number(req.params.id);
  const strategy = listStrategies(db).find((s) => s.id === id);
  if (!strategy) {
    res.status(404).send(layout(`<p>No strategy #${id}.</p>`));
    return;
  }

  const paperState = getPaperState(db, id);
  const latest = getLatestExecution(db, id) as unknown as LatestExecutionSummary | undefined;
  const riskAlerts = evaluateRiskAlerts(strategy, paperState, latest);
  const executions = listExecutions(db, id) as Array<Record<string, unknown>>;

  const alertsHtml = riskAlerts
    .map((a) => `<li class="alert-${a.level}">[${a.level.toUpperCase()}] ${esc(a.message)}</li>`)
    .join("\n");

  const execRows = executions
    .slice(0, 20)
    .map((e) => {
      const receipts = listReceipts(db, e.id as number) as Array<Record<string, unknown>>;
      const legLines = receipts
        .map((r) => `${esc(r.leg)}: ${r.side} ${r.quantity} @ $${r.price} (${esc(r.status)})`)
        .join("<br>");
      return `<tr><td>#${e.id}</td><td>${esc(e.ts)}</td><td class="status-${esc(e.status)}">${esc(e.status)}</td><td>$${e.contribution_usd}</td><td>${legLines || "—"}</td></tr>`;
    })
    .join("\n");

  res.send(
    layout(`
      <p><a href="/">&larr; all strategies</a></p>
      <h1>#${strategy.id} ${esc(strategy.ticker)} — $${strategy.contribution_usd}/${esc(strategy.frequency)} @ ${strategy.hedge_leverage}x (${esc(strategy.status)})</h1>

      <div class="card">
        <div class="stat"><div class="value">${paperState.contributionsCount}</div><div class="label">Contributions</div></div>
        <div class="stat"><div class="value">${paperState.cumulativeStockQty}</div><div class="label">Stock qty (${esc(strategy.spot_symbol)})</div></div>
        <div class="stat"><div class="value">${paperState.cumulativeHedgeQty}</div><div class="label">Hedge qty (${esc(strategy.futures_symbol)})</div></div>
        <div class="stat"><div class="value">$${paperState.cumulativeHedgeCollateralUsd.toFixed(2)}</div><div class="label">Hedge collateral used</div></div>
        <div class="stat"><div class="value">$${paperState.deferredHedgeBudgetUsd.toFixed(2)}</div><div class="label">Deferred hedge budget</div></div>
        <div class="stat"><div class="value">$${paperState.cumulativeFeesUsd.toFixed(4)}</div><div class="label">Est. fees</div></div>
      </div>

      <h2>Risk alerts (deterministic — never trigger automatic rebalancing)</h2>
      <ul>${alertsHtml || "<li>none</li>"}</ul>

      <h2>Cycle history</h2>
      <table><tr><th>Execution</th><th>Time</th><th>Status</th><th>Contribution</th><th>Legs (requested vs filled)</th></tr>${execRows || "<tr><td colspan=5>none yet</td></tr>"}</table>
    `),
  );
});

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  app.listen(port, () => {
    console.log(`[HedgeOS dashboard] http://localhost:${port} (PAPER MODE, adapter=${adapterMode})`);
  });
}

export { app };
