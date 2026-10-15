---
name: fmqd-fleet-health
description: Snapshot-only selected-home fleet, crew-state, resource and structured captain-hold facts; unknown evidence never clears a fleet.
user-invocable: true
---

# /fmqd-fleet-health

Inactive **fm-quarterdeck source skill**, not installed or activated. Resolve the script relative to this reviewed skill directory:

```bash
node <Quarterdeck-skill-directory>/../../scripts/quarterdeck-skill-report.mjs fleet-health --home /absolute/selected/firstmate --as-of <UTC-ISO-time> < /absolute/private/snapshot.json
```

Use only already-authorized saved owner observations for the explicitly selected home. Read the [input and reporting contract](../../docs/SNAPSHOT-SKILLS.md) first. No owner is invoked, no home discovered, and no endpoint or other-home sweep occurs. Snapshot acquisition is outside this skill; never run a broad collector to satisfy missing fields.

Present current crew state separately from historical status events, recorded capacity/RAM, actual observed pause evidence and missing wait targets. Technical blocked lines are not captain calls: the oldest call uses only existing structured captain-actionable holds with durable timestamps. Missing, stale, conflicting or incomplete evidence is UNKNOWN with a reason, not idle, absent or all-clear. Resource numbers do not authorize spawning. Keep reports private; do not publish home observations.

Source presence grants no installation, activation, cleanup, lifecycle or supervision authority. Existing role and reporting contracts win; no delegation or controller is added. Any future Firstmate projection must use the unified installer with uninstall/inventory/toolcheck coverage, not manual global copies.
