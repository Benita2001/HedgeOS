# HedgeOS VPS Deployment

Paper mode only. This document describes the actual deployed state as of this session — see `PROGRESS_LOG.md` for the run-by-run evidence.

## Target
Existing Linux VPS (also hosts Hermes and firecrawl — untouched by this deployment). Ubuntu 24.04, 4 vCPU, 7.8GB RAM, 89GB disk, Node v24.20.0 pre-installed. Access: SSH key auth already established (`root@<host>`), no new credentials created.

## Conflict check performed before deploying
- Hermes runs as a **root user-level systemd unit** (`~/.config/systemd/user/hermes-gateway.service`), not a system service — not visible to `systemctl` (system) at all, so there is zero unit-name collision risk, and HedgeOS's system-level units cannot accidentally order against it.
- `firecrawl` lives at `/opt/firecrawl`, untouched; HedgeOS lives entirely under `/opt/hedgeos`, a sibling directory.
- `ufw` is **inactive** on this host — no firewall is enforced at the OS level. Because of this, every HedgeOS network-facing process binds to `127.0.0.1` only (see below); no port is opened to `0.0.0.0`, and no firewall rule was touched.
- No conflicting port usage: before deployment, only `:22` (SSH) was listening.
- A dedicated, unprivileged system user `hedgeos` (`useradd --system --shell /usr/sbin/nologin`) owns everything under `/opt/hedgeos` and runs all HedgeOS services — it cannot log in, has no password, and is not a new "credential" in the access-control sense used elsewhere in this project (no key, no secret, no external access path).

## Layout
```
/opt/hedgeos/
  app/            the repository (rsynced from the local machine, not a git clone — nothing has been pushed to GitHub)
    data/         SQLite DB, owned by hedgeos:hedgeos
    .env          paper-mode config, chmod 600, owned by hedgeos:hedgeos, never overwritten if already present
  backups/        daily SQLite snapshots (see below)
```

## Services (systemd, system-level, distinct `hedgeos-*` names)
| Unit | What | Binds to |
|---|---|---|
| `hedgeos-worker.service` | persistent scheduler/worker | no network port |
| `hedgeos-dashboard.service` | read-only dashboard | `127.0.0.1:8766` only |
| `hedgeos-backup.timer` + `.service` | daily SQLite `.backup` snapshot, 14-day retention | n/a |

All three: `Restart=always`, `RestartSec=5`, `NoNewPrivileges=true`, `ProtectSystem=strict` with `data/` as the only writable path, `ProtectHome=true`, `PrivateTmp=true`. Enabled with `systemctl enable` so they start on boot — **boot-survival itself has not been tested** (that would require rebooting a shared production server, not done without separate approval); only `systemctl restart`/process-crash recovery has actually been verified.

## Secure access — no new open ports
- **Dashboard**: bound to loopback only. Access via SSH tunnel: `ssh -L 8766:127.0.0.1:8766 root@<host>`, then `http://localhost:8766` on your Mac. No public HTTP exposure, no auth layer needed because there is no public listener.
- **HedgeOS MCP operator server**: not run as a standing service at all — it's stdio-based by design. Claude Code reaches it by spawning it over the *existing* SSH connection on demand:
  ```bash
  claude mcp add hedgeos-remote --transport stdio -- ssh root@<host> "cd /opt/hedgeos/app && HEDGEOS_MODE=paper npx tsx src/mcp/server.ts"
  ```
  This opens zero new ports and uses zero new credentials — the same SSH key access already in use for everything else in this session.

## Environment / secrets
`/opt/hedgeos/app/.env`, mode 600, owned by `hedgeos`: `HEDGEOS_MODE=paper`, `HEDGEOS_DB_PATH`, `HEDGEOS_DASHBOARD_PORT=8766`, `HEDGEOS_DASHBOARD_HOST=127.0.0.1`, `HEDGEOS_TICK_MS=60000`. No Binance API keys — paper mode needs none. The deploy script refuses to overwrite an existing `.env`.

## Backups
`hedgeos-backup.timer` fires daily (±30min randomized) and runs `deploy/backup.sh`, which uses SQLite's own `.backup` command (safe against a live WAL writer, unlike copying the file directly) into `/opt/hedgeos/backups/hedgeos-<timestamp>.db`, pruning anything older than 14 days.

## Health / logs
```bash
systemctl status hedgeos-worker hedgeos-dashboard
journalctl -u hedgeos-worker -f      # live worker logs
journalctl -u hedgeos-dashboard -f
```
The worker logs every cycle creation/claim/completion with timestamps (same format verified locally). The dashboard's own `/` and `/strategy/:id` routes double as a liveness check — a 200 response with real data means the DB is reachable and the process is healthy.

## What was NOT done
- No firewall rule changed (`ufw` left exactly as found: inactive).
- No public port opened.
- Hermes and firecrawl were not stopped, restarted, or reconfigured.
- No git push, no GitHub involvement — the deployed code was `rsync`'d directly from the local machine.
- No reboot test performed.
- No live trading enabled — `HEDGEOS_MODE=paper` throughout; the worker independently refuses to start under `HEDGEOS_MODE=live` regardless of this config.
