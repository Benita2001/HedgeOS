# Self-hosted install (any user, any VPS)

`docs/VPS_DEPLOYMENT.md` documents one specific worked example (the founder's own VPS) as evidence that this actually runs somewhere real. **This document is the generic path** — nothing below is tied to that host, and the deploy tooling itself was already parameterized (verified this session): `grep`ing `src/` and `deploy/` for the founder's VPS IP or local filesystem paths found none.

## Requirements
- A Linux host you control, SSH key access, a `hedgeos` (or any) unprivileged system user you're willing to create.
- Node.js (the deploy script installs its own independent copy under `/opt/hedgeos/node` — it does not require or touch any Node already on the host, precisely so it can't collide with something else already running there).
- Nothing else — no database server (SQLite, file-based), no message queue, no external service dependency.

## Install
```bash
git clone <your-fork-or-checkout> hedgeos && cd hedgeos
npm install
cp .env.example .env   # fill in HEDGEOS_MODE=paper; leave BINANCE_API_KEY/SECRET blank for paper mode
npm test                # should show all tests passing before you deploy anything
```

## Deploy to your own VPS
```bash
export HEDGEOS_DEPLOY_HOST=root@<your-vps-ip-or-hostname>
./deploy/deploy.sh
```
This is the actual script this project's own VPS deployment used (`deploy/deploy.sh`) — it takes the host from `HEDGEOS_DEPLOY_HOST`, nothing hardcoded. It creates a dedicated unprivileged `hedgeos` system user, installs an independent Node runtime, rsyncs the app, writes a paper-mode `.env` **only if one doesn't already exist** (never overwrites), and installs three systemd units (`hedgeos-worker`, `hedgeos-dashboard`, `hedgeos-backup.timer`) bound to loopback/no-network as appropriate. See `docs/VPS_DEPLOYMENT.md` for the full rationale (why loopback-only, why a dedicated Node install, why `ProtectSystem=strict`) — that reasoning is host-agnostic even though the doc's specific numbers (RAM, disk, an example IP) are one deployment's.

## Ports / data paths
- Dashboard: `127.0.0.1:8766` by default (`HEDGEOS_DASHBOARD_PORT`) — never bound to a public interface by default. Access via SSH tunnel (`ssh -L 8766:127.0.0.1:8766 <host>`), same pattern regardless of whose VPS it is.
- Worker: no network port at all.
- MCP server: stdio only, spawned on demand by the operator's own client (locally or over SSH) — never a standing network listener.
- Data: `./data/hedgeos.db` (configurable via `HEDGEOS_DB_PATH`), a single SQLite file. Backups: `deploy/backup.sh` via a daily systemd timer, SQLite's own `.backup` command (safe against a live WAL writer), 14-day retention, pruned automatically.

## Restore from backup
```bash
sudo -u hedgeos cp /opt/hedgeos/backups/hedgeos-<timestamp>.db /opt/hedgeos/app/data/hedgeos.db
sudo systemctl restart hedgeos-worker hedgeos-dashboard
```
(Restart is the one operation this document explicitly authorizes touching, since it's your own freshly-restored data, not the founder's running service.)

## What you get, day one (single-tenant, one operator, one set of credentials)
A persistent paper-mode agent, restart-safe and idempotent, with a read-only dashboard and an MCP operator interface. Live trading requires the separate, much more involved account-onboarding path in `LIVE_TRADING_READINESS.md` — nothing above enables it.

## What this is NOT (yet)
Multi-user hosting. This install path stands up one instance for one operator with one Binance account. See `docs/MULTI_TENANT_ARCHITECTURE.md` for what a real multi-user version would need — documented, not implemented.
