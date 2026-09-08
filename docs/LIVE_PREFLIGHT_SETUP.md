# Installing live-preflight credentials — exact steps, run by you, in your own terminal

This does **not** touch the running paper service. The paper worker/dashboard read `/opt/hedgeos/app/.env` (unchanged, still `HEDGEOS_MODE=paper`, still no Binance keys in it). This sets up a **separate** file, in a **separate** directory, read only by a one-off read-only preflight script you run manually — nothing here is loaded by any systemd unit.

## 1. Create the secrets directory (once)

SSH into the VPS yourself, then:

```bash
sudo install -d -m 700 -o hedgeos -g hedgeos /opt/hedgeos/secrets
```

## 2. Write the credential file — values typed interactively, never on the command line

Run this exactly as shown. `read -s` reads input silently (not echoed to the terminal) and the values only ever live in shell variables in your own session's memory — they never appear in a command's argument list, so they never land in shell history or a process listing.

```bash
umask 077
{ read -r -s -p "Binance API Key: " BKEY; echo; read -r -s -p "Binance API Secret: " BSECRET; echo; } && \
  printf 'BINANCE_API_KEY=%s\nBINANCE_API_SECRET=%s\n' "$BKEY" "$BSECRET" | sudo tee /opt/hedgeos/secrets/live-preflight.env > /dev/null && \
  sudo chown hedgeos:hedgeos /opt/hedgeos/secrets/live-preflight.env && \
  sudo chmod 600 /opt/hedgeos/secrets/live-preflight.env && \
  unset BKEY BSECRET
```

Notes:
- `unset BKEY BSECRET` at the end clears the values from your current shell's variables immediately after they're written to the file.
- The file ends up owned by `hedgeos:hedgeos`, mode `600` — only the dedicated unprivileged `hedgeos` system user (and root) can read it, same ownership model as the existing paper `.env` (see `docs/VPS_DEPLOYMENT.md`).
- This never touches `/opt/hedgeos/app/.env`. Two separate files, two separate purposes.

## 3. Verify permissions (no secret values shown)

```bash
sudo ls -la /opt/hedgeos/secrets/
```

Expect: `-rw------- 1 hedgeos hedgeos ... live-preflight.env`.

## 4. Confirm to me that it's installed

Just tell me it's done — don't paste the key, don't paste command output that includes it (the `ls -la` above is safe; a `cat` of the file is not).

## 5. What happens next (only after you confirm)

I'll ask you to run the read-only preflight script yourself, as the `hedgeos` user, sourcing only this file:

```bash
sudo -u hedgeos bash -c 'set -a; source /opt/hedgeos/secrets/live-preflight.env; set +a; \
  cd /opt/hedgeos/app && /opt/hedgeos/node/bin/npx tsx scripts/live-preflight.ts NVDA'
```

This calls `scripts/live-preflight.ts` — GET-only endpoints (API key permissions, account status, Spot/Futures account access, balances, position mode, positions, open orders, exchange filters). It does not import or trigger `assertLiveTradingGate`/`LiveExecutionAdapter` at all, so `HEDGEOS_MODE`, `HEDGEOS_LIVE_TRADING_CONFIRMED`, and `HEDGEOS_LIVE_CHECKLIST_COMPLETE` are irrelevant to it and none need to be set. It prints a redacted JSON report — never the key/secret (not even a masked fragment), never a full account identifier.

Paste that JSON output back to me (it's already redacted, safe to share) and I'll turn it into the preflight report you asked for.

## Cleanup, whenever you're done with live-readiness work

```bash
sudo rm -f /opt/hedgeos/secrets/live-preflight.env
```

The directory can stay (empty, mode 700) for next time, or be removed too (`sudo rmdir /opt/hedgeos/secrets`).
