---
name: fmqd-restart-ready
description: Snapshot-only concrete blockers and after-restart checklist; stow safety is always UNKNOWN because no structured checkpoint exists.
user-invocable: true
---

# /fmqd-restart-ready

Inactive **fm-quarterdeck source skill**, not installed or activated. The name is not a safe-to-restart verdict. Resolve the script relative to this reviewed skill directory:

```bash
node <Quarterdeck-skill-directory>/../../scripts/quarterdeck-skill-report.mjs restart-ready --home /absolute/selected/firstmate --as-of <UTC-ISO-time> < /absolute/private/snapshot.json
```

Read the [input and reporting contract](../../docs/SNAPSHOT-SKILLS.md). **Always report stow-safety UNKNOWN / not-verified.** Stock Firstmate has no structured machine-readable stow checkpoint; its stow receipts are prose. An idle agent, clean source, empty blocker list or receipt cannot establish safety, durability or resumability. Do not parse receipt prose into a positive verdict or invent a checkpoint.

The newest receipt PATH may be supplied as informational only; it is never opened, followed or parsed. Report supplied concrete blockers and the after-restart verification checklist independently, without implying restart approval. Missing evidence remains UNKNOWN.

No stow, restart, resume, inbox, lock or retention action/callback is present. All acting capability is later separately authorized scope through existing owners. Keep private paths/reports private. Source presence grants no live or installed acceptance; future projection must use the unified installer, uninstall, inventory and toolcheck. Existing role/reporting authority wins.
