# Multi-tenant architecture — documented, NOT implemented

Every current deployment of HedgeOS (this project's VPS, and `docs/SELF_HOSTED_INSTALL.md`'s generic path) is **single-tenant**: one worker process, one SQLite file, one operator, one Binance credential. This document is a design sketch for what a real multi-user version would need. None of it exists in code today — do not describe HedgeOS as multi-tenant based on this document.

## What would need to change

**Tenant-isolated credentials.** Today, one `.env` (or one secrets file, per `docs/LIVE_PREFLIGHT_SETUP.md`) holds one user's Binance key. Multi-tenant needs per-user secret storage — at minimum, one file per user with correct ownership, more realistically a proper secrets manager (Vault, cloud KMS, or similar) keyed by user ID, never a shared plaintext config file holding multiple users' credentials in one place (explicitly ruled out in this session's instructions, and for good reason — one file compromise would leak every user's key at once).

**Account-scoped strategy state.** The `strategies`/`executions`/`receipts`/`cycles` tables (`src/db/schema.sql`) have no `user_id` column and no row-level scoping anywhere in `src/db/index.ts`'s queries. Multi-tenant needs a `user_id` (or `tenant_id`) foreign key on every table, and every query in `db/index.ts` updated to filter by it — a real, non-trivial migration, not an additive change.

**Authentication/authorization.** The MCP server today trusts whoever can spawn it (stdio, no auth layer — appropriate for "you're running your own process on your own machine/VPS," not for "many users share one server"). A multi-tenant MCP surface would need the caller's identity established (some form of per-user token or session) and every tool handler checking that the caller may only see/operate their own strategies — none of this exists.

**Per-user risk limits.** `src/risk/checks.ts`'s alerts are per-strategy, not per-user-aggregate. A real multi-tenant deployment would likely want account-level circuit breakers (e.g., a user's total live exposure across all their strategies), which needs a new aggregation layer.

**Audit logs.** `executions`/`receipts` already form a durable, append-only record per strategy — a reasonable foundation — but there's no user-attributed audit trail of *administrative* actions (who paused/resumed/created what, from where) and no tamper-evidence beyond "it's a SQLite file on disk."

**Worker isolation.** Today, one worker process ticks over every active strategy in one database. Multi-tenant hosting would need to decide between (a) one shared worker process iterating all tenants' strategies (simpler, but one tenant's bug/load can affect others) or (b) per-tenant worker processes/containers (real isolation, real operational complexity — process supervision, resource limits, per-tenant deployment). Neither is built; (a) is what exists today, implicitly, for the single tenant that currently exists.

## Why this wasn't built for the hackathon submission

Time-boxed against a hard deadline, and because it would be a genuine architecture change (schema migration, new auth layer, new secrets model) rather than the "smallest remaining work that makes HedgeOS installable and usable by another person" this session was scoped to. The single-tenant self-hosted path (`docs/SELF_HOSTED_INSTALL.md`) already lets a *second* person run their *own* fully independent instance today — which is a different, smaller, and already-real claim: "another person can install and run HedgeOS," not "HedgeOS hosts multiple users on one shared instance."
