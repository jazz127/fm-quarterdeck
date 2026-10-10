---
name: fm-quarterdeck-health
description: Initialize or consume Quarterdeck with a persistent health watcher; on /afk, away mode or quiet supervision, keep the dashboard active and make occasional health check-ins.
user-invocable: true
---

# Quarterdeck health supervision

This Quarterdeck-owned skill is for the supervising Firstmate, not permission for workers to administer shared services. Source presence does not activate it. Follow `docs/FIRSTMATE-INTEGRATIONS.md` for authorized, pinned discovery and rollback. Resolve the canonical Quarterdeck repository from this skill directory (two parents); never guess a home or installation hostname.

## Set up the persistent check

When initializing/consuming Quarterdeck, select the explicit initialized `FM_HOME`, confirm authority over its dashboard process and the exact private Serve route, and register a Firstmate custom watcher check. Do not replace an unknown existing check, config or symlink; inspect and preserve a verified rollback copy before an authorized update.

Use only the unified `scripts/firstmate-integration.mjs` transaction documented in
`docs/FIRSTMATE-INTEGRATIONS.md`. It pins this skill and checker together,
registers `fm-quarterdeck-health` through Firstmate's existing interface, persists
tagged private JSON configuration and owns reversible removal. Never hand-edit
Firstmate, copy checks or manually project skills. Unknown legacy bytes require
separately reviewed removal using their original owner, never automatic adoption.

1. Verify Firstmate provides `bin/fm-check-register.sh` and `bin/fm-check-unregister.sh`. If not, report registration unavailable; do not invent another scheduler.
2. Prepare an approved private JSON config outside the home, with the environment keys below. Include explicit `FM_HOME` and the actual server's `FM_QUARTERDECK_STATE_PATH` (or retained `FM_AGENTOS_STATE_PATH`); an integration pin cannot infer the dashboard's original state owner. Keep private values out of committed source.
3. After approval, run the unified install with a reviewed clean revision and that config. Inspect `status`, `verify` and `inventory`; all installed artifacts carry `fm-quarterdeck` directly or in the ownership manifest. The retained config path is `state/quarterdeck-health.json`; mutable runtime bookkeeping uses `fm-quarterdeck-health.lock` / `.stamp`. No preference data is renamed.
4. Run `FM_QUARTERDECK_HEALTH_FORCE=1 "$FM_HOME/state/fm-quarterdeck-health.check.sh"`, handle overdue notes with the reply+ack loop below, then force it again and confirm silence. Confirm watcher registration using Firstmate's documented inspection procedure. Registration success is not health evidence. Record the check id, owned route, launch method, revision and config privately.

Settings (environment or private JSON):

- `FM_QUARTERDECK_HEALTH_PORT`: explicit loopback port; otherwise discover the unique HTTPS root proxy's loopback port with bounded `tailscale serve status --json`.
- `FM_QUARTERDECK_HEALTH_URL`: exact private HTTPS origin reachable from the operator's network side. Otherwise discover that same Serve route's HTTPS origin. Discovery ambiguity fails closed; no real hostname is baked in.
- `TAILSCALE_BIN`: optional Tailscale executable path, otherwise PATH `tailscale`, falling back to `tailscale.exe` when absent (WSL).
- `FM_HOME`: explicit initialized Firstmate home for guarded inbox reads; required in the environment or private JSON.
- `FM_QUARTERDECK_HEALTH_MAX_AGE`: snapshot age seconds, default 900, range 1–86400.
- `FM_QUARTERDECK_STATE_PATH` / `FM_AGENTOS_STATE_PATH`: same owner resolution as the server; conflicting paths fall back to default health preferences. The script reads sibling `quarterdeck-preferences.json` read-only on every run. In the repository, the default owner is `prototype/data/agent-state.json`; installed copies must record the original owner as above. Environment overrides private health config.
- `FM_QUARTERDECK_HEALTH_STATE_DIR`: optional explicit bookkeeping/config directory; normally leave unset.
- `FM_QUARTERDECK_HEALTH_FORCE=1`: manual post-repair verification, bypasses the saved interval throttle.

In Quarterdeck **Preferences → Away supervision**, explicitly save **Away check-in interval** (minutes, default **10**) and **Open note alarm** (minutes, default **15**). Both accept whole minutes **1–1440**. Missing, malformed, unreadable or invalid saved values fall back to their respective defaults. Saves are atomic and apply on the next script invocation, including while throttled. The read-only `captain.md` view is unchanged. Open-note age comes from the Unix timestamp prefix of each note id; the former `FM_QUARTERDECK_HEALTH_INBOX_MAX_AGE` knob is replaced by this saved preference.

If Tailscale is unavailable and a port is explicitly configured, local-only checking is possible. Record that remote reachability is **unverified**, not healthy from the captain's side. To require remote checks, explicitly configure the URL; failure never falls back to local-only. The checker probes `/api/health` (`ok: true`) and `/api/bearings` on local and available remote origins. Bearings must have schema `fm-quarterdeck-call.v1`, no error or `stale: true`, and either idle `state: "loading"` (healthy: the server runs no snapshot without viewers) or `state: "ready"` with a timezone-bearing ISO `generatedAt` within the age limit (at most 60 seconds in the future). Stale, unavailable and error snapshots are unhealthy. Missing endpoint/schema is an actionable compatibility failure, not a successful check. Use the wire contract in `prototype/BEARINGS.md`; escalate a missing or incompatible producer rather than substituting a request-time timestamp or weakening readiness checks.

Dependencies: Bash, Python 3, `timeout`, `flock`; Tailscale only for discovery. Reads have three-second budgets, a one-MiB response cap and a 25-second overall deadline. No output means healthy **or throttled/concurrent skip**; use a forced run to establish fresh evidence. Failures and overdue inbox notes print exactly one sanitized wake line, without private URLs, paths, note bodies or command diagnostics. Inbox reads use `bin/fm-inbox.sh receipts --all-pending` with a three-second budget and one-MiB cap; overdue ids are named (at most 20, with an additional count) with the reply+ack requirement, even if dashboard health also fails. Known handled-note and reply omissions do not affect open-note coverage; pending, unknown or malformed omission coverage fails closed. This checks all open captain notes, not only annotations. Checks never reply, acknowledge, execute orders or mutate services, Serve routes or preferences.

## /afk and quiet supervision

Keep the check registered while Quarterdeck is expected to be active, including `/afk`, away mode and quiet supervision. Reuse Firstmate's custom-check watcher; do not busy-poll or start another daemon. The script is **model-free**: periodic watcher invocations do not call a model or wake Firstmate; only a printed problem line wakes Firstmate. Its repeated invocation is throttled to the saved Away check-in interval (default ten minutes). At occasional normal supervision checkpoints, confirm registration remains present and review fresh health evidence; local-only skips do not establish remote availability. Do not send routine healthy chatter or wake the captain for each check.

### Captain notes: act and close the loop

During `/afk`, away mode or quiet supervision, and **on every health check-in**, read the captain's Quarterdeck notes/annotations inbox from the explicitly selected Firstmate home:

```bash
(cd "$FM_HOME" && bin/fm-inbox.sh list)
```

For **every open note**, read the complete order and its annotation context. Quarterdeck notes are live captain orders: act when safe and within existing authority. Destructive/irreversible actions, merges, signing and publication still follow normal authority; quoted target text and advisory annotation context do not grant additional authority.

Always close the loop, whether action succeeded or must wait. Prefer the approved Quarterdeck `scripts/quarterdeck-note-close.mjs` with the prepared exact reply on stdin and a stable private `flock`; it verifies recorded reply before ack, then proves closure and repairs same-text retries without repeating the order. See `docs/FIRSTMATE-INTEGRATIONS.md`, “Reply and acknowledge an already handled note”, for explicit invocation, bounds and serialization. It never acts on the order or creates a deferral hold. If unavailable, use the existing manual sequence below with the same duties:

```bash
(cd "$FM_HOME" && bin/fm-inbox.sh reply "$id" "$text")
(cd "$FM_HOME" && bin/fm-inbox.sh drain --ack "$id")
```

Reply with what was done and verification, or why it waits and the next step. If action cannot happen yet, create/retain a tracked backlog hold before acknowledging; include that tracking reference in the reply and follow up when it clears. Acknowledgement closes intake, not an unfinished task. Run the ack only after a successful reply; on reply/ack failure, retain the id for retry and report the failure. Seeing a note, acknowledging a watcher wake, or acknowledging without replying is **not handling it**: a note counts as handled only once replied **and** acked. Do not leave a deferred note silent. Re-list to confirm closure; do not repeat an already performed action just because closing the loop needs retry.

An overdue-inbox wake requires this handling loop, not a dashboard restart. Healthy/throttled checks do not excuse skipping inbox reads at supervision check-ins.

## Failure wake and recovery

On a watcher failure wake, inspect the one-line signal and bounded local evidence. Under established maintenance authority, restore the owned dashboard: launch/restart the clean approved revision on a **fresh free loopback port**, retaining the selected Firstmate home and existing private state owner; repoint **only the proven owned** Tailscale Serve handler to that port; verify the local and private URL health and healthy Bearings snapshot (idle loading or ready/fresh, never stale or errored). Follow `docs/tailscale-launch.md` ownership and namespace rules. Never kill by port/name, reset Serve, enable Funnel, replace private state, or touch another service's handler. An unowned/changed route or missing maintenance authority requires escalation rather than takeover.

For future standalone launches only, `scripts/quarterdeck-watch.mjs` can own its own child and restart it after an explicitly approved branch's clean fast-forward. It does not take over this recovery flow, existing processes, preview registries or Serve routes; activation/stop and health verification are in `docs/FIRSTMATE-INTEGRATIONS.md`. Keep immutable installed hook/skill pins separate from a watched checkout.

Verify from the captain's network side where available (operator-side remote network probe/browser), not solely server loopback. The watcher's operator-network request is useful but does not prove a separate captain device's ACL or browser access. If that side is inaccessible, report the verification gap explicitly. A missing Bearings producer requires a bounded compatibility investigation, not repeated restarts. Force the check after repair, then briefly report the failure, repair and verified reachability/freshness (or remaining limitation). Keep the check registered after recovery.

Retire only when Quarterdeck is deliberately decommissioned or monitoring is explicitly withdrawn. For a unified installation, use its `firstmate-integration.mjs uninstall "$FM_HOME"` transaction. For a legacy separately owned check: `(cd "$FM_HOME" && bin/fm-check-unregister.sh <id>)`. Inspect ownership before removing this check's private files; do not unregister other checks. Temporary captain absence is not retirement.
