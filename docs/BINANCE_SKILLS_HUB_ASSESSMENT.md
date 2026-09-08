# Binance Skills Hub — corrected assessment (2026-09-08 ~19:50 UTC)

**This corrects an earlier, wrong conclusion in this project's history** (in an earlier version of `docs/INTEGRATION_SURFACES.md`) that no official Binance "Skills Hub" exists. That was based on two `WebFetch` calls against generic Agent Native doc pages that didn't happen to mention it — a real gap in that research, not a fact about Binance. The user supplied the two authoritative URLs directly; this assessment is built from actually reading them.

## The Skills Hub is real

**https://www.binance.com/en/skills** lists 17 official, installable skills (a distinct surface from the Agent OS MCP server), each installable via `npx skills add <github-url>`, backed by **https://github.com/binance/binance-skills-hub**. Every skill card states it is "security-reviewed before listing."

**https://developers.binance.com/en/docs/agent-native/mcp-server/agentic** is the separate MCP-server surface (already covered as surface 1 in `docs/INTEGRATION_SURFACES.md`) — confirmed genuinely distinct from the Skills Hub, exactly as the user stated.

## The two candidates relevant to HedgeOS, actually inspected

### `binance` (a `binance-cli` wrapper) — installed, inspected, NOT integrated into HedgeOS

**Installed for real this session**, via the documented method:
```
npx skills add https://github.com/binance/binance-skills-hub/tree/main/skills/binance/binance
```
Real output: cloned the repo, installed to `.agents/skills/binance` (project-local), symlinked for Claude Code, listed as "universal" for 19 other clients including **Codex**. Security assessment shown by the installer itself: **Gen: Safe, Socket: 0 alerts, Snyk: Med Risk** — reported here, not hidden.

**What it actually is**: a large instruction/reference package (`SKILL.md` + 40 reference files under `references/`) covering Spot, Futures (USDⓈ-M and COIN-M), Margin, Convert, and 25+ other Binance product domains, all as thin instruction layers over the same official REST API — driving them requires installing a separate binary, `binance-cli` (its own `curl | sh` installer, reviewed via the raw GitHub source but **not executed** this session), configured with `BINANCE_API_KEY`/`BINANCE_SECRET_KEY` or a CLI credential profile.

**Read directly from `references/futures-usds.md`** (real content, not assumed): the `new-order`, `change-initial-leverage`, and `change-margin-type` commands take a free-text `symbol` parameter (not a restricted crypto-only enum), and the reference material explicitly lists `TRADIFI_PERPETUAL` as a real contract type. **This means the skill is not structurally prevented from targeting `NVDAUSDT`** — it's a generic wrapper around the same `/fapi/v1/order` family of endpoints HedgeOS's own `src/binance/liveRequests.ts` already implements natively.

**Why it was NOT integrated into HedgeOS**, despite being real and technically capable:
1. **It would duplicate working execution code.** HedgeOS's `liveExecution.ts`/`liveRequests.ts` already implement the identical REST calls (order placement, leverage/margin config, reconciliation) natively in TypeScript, already tested (35 tests), already wired into the deterministic sizing/idempotency/reconciliation pipeline. Routing through an external CLI would add a second, redundant path to the same account actions.
2. **It's a new, external, unreviewed-by-execution binary dependency.** The persistent VPS worker must run unattended for weeks (see `docs/INTEGRATION_SURFACES.md`'s "why this separation is the honest design" section) — adding a `curl | sh`-installed binary as a runtime dependency is exactly the kind of operational risk that section already argues against for Agent OS's own interactive-auth limitation, and the same reasoning applies here even though `binance-cli`'s auth model (API key/secret) is technically headless-capable.
3. **This confirms, rather than replaces, the existing architecture decision.** `EXECUTION_ROUTE_DECISION.md` already concluded that direct signed REST is the correct route for the Futures/TradFi-perp leg because Agent OS MCP has no Futures order tools. Binance's own official CLI skill, examined here, is *itself* just a REST wrapper with no special TradFi/bStock abstraction — independent confirmation that there is no higher-level official path being missed, not a reason to add a dependency.

**What was deliberately NOT done**: `binance-cli`'s installer was not executed, no new credentials were created or configured for it, and no command was actually run against a live account through it. Doing so would require exactly the live-trading capability this project's boundaries reserve for explicit, separate authorization — and would have added no capability HedgeOS doesn't already have natively. Verification here stopped at "installed via the official mechanism, real command surface read from source" — not "used to place or query a real order."

**Codex**: the installer's own output lists Codex among the 19 "universal" targets the skill was installed for (same `.agents/skills/binance` tree, standard skill format) — this is real evidence of format compatibility, but no actual Codex session invoked it this pass (see the reasoning above for why invoking it meaningfully needs the same credential step that was deliberately not taken).

### `binance-tokenized-securities-info` — inspected, confirmed NOT relevant, NOT installed

Despite the name suggesting overlap with HedgeOS's bStock product, its actual `SKILL.md` (read directly from GitHub) states plainly: it covers **Ondo tokenized US stocks on Binance Web3** — on-chain tokens on Ethereum/BSC, explicitly "NOT for general crypto tokens," and by clear implication not for Binance.com's centralized Spot bStock market (`NVDABUSDT`-style symbols) that HedgeOS actually discovers and trades via `src/binance/client.ts`. It is read-only (six query APIs: token metadata, on-chain price/holders/supply, fundamentals, K-lines) with **no order-placement capability of any kind**, for a different product than HedgeOS uses. Not installed — installing it would have added a superficially-relevant-sounding dependency with zero actual applicability, which is precisely what "do not install every skill merely for appearance" warns against.

### The other 15 skills — not relevant, not inspected in depth

Wallet tracking, DeFi/staking, meme-coin launch feeds, P2P/fiat payments, sports predictions, Binance Academy content, and Binance Square posting. None bear on a Spot-bStock + TradFi-perpetual hedge product; skimmed from the catalog listing only, not deep-dived, consistent with "do not install every skill merely for appearance."

## Net effect on HedgeOS

**No code change to HedgeOS's own execution path.** The genuine outcome of this research is validation, not new capability: the project's existing direct-REST architecture (`EXECUTION_ROUTE_DECISION.md`) is confirmed to be the same approach Binance's own official tooling takes, and the one skill that might have looked like an alternative (`binance-tokenized-securities-info`) turns out to be a different product entirely. `docs/INTEGRATION_SURFACES.md` §0 is corrected to reflect that the Skills Hub is real (previously stated otherwise, wrongly) while still reaching the same practical conclusion — nothing from it belongs in HedgeOS's runtime or operator workflow.
