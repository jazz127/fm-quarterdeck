---
name: fmqd-pr-readiness
description: Snapshot-only draft, reported checks, open-work and independently supplied exact served-head comparison; not merge or deployment approval.
user-invocable: true
---

# /fmqd-pr-readiness

Inactive **fm-quarterdeck source skill**, not installed or activated. Resolve the script relative to this reviewed skill directory:

```bash
node <Quarterdeck-skill-directory>/../../scripts/quarterdeck-skill-report.mjs pr-readiness --home /absolute/selected/firstmate --as-of <UTC-ISO-time> < /absolute/private/snapshot.json
```

Read the [input and reporting contract](../../docs/SNAPSHOT-SKILLS.md). Supply already-authorized saved read-only PR observations and separately captured served evidence with exact repository, target, head and time. No forge, preview or service is contacted. Missing independent served evidence is UNKNOWN, never replaced by the source head. Report mismatches explicitly, alongside draft/state/check counts and head-bound open-work counts.

Reported checks omit required contexts that have never reported; a green source is not deployment, acceptance or merge readiness. This report does not authenticate caller provenance or authorize action. No correction, build, draft conversion, merge, preview or publication action exists. Do not acquire broad account permissions or mutate a PR to make this report green.

Keep input/output private and preserve existing role/reporting authority. No install/activation is implied; any future Firstmate projection must be owned by the unified installer, uninstall, inventory and toolcheck rather than a global/manual copy.
