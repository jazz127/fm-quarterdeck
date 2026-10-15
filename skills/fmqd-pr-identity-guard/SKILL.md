---
name: fmqd-pr-identity-guard
description: Observed-versus-expected identity facts from supplied read-only snapshots; never credential proof or publication permission.
user-invocable: true
---

# /fmqd-pr-identity-guard

Inactive **fm-quarterdeck source skill**, not installed or activated. The name denotes an advisory fact report, not an approval wrapper. Resolve the script relative to this reviewed skill directory:

```bash
node <Quarterdeck-skill-directory>/../../scripts/quarterdeck-skill-report.mjs pr-identity-guard --home /absolute/selected/firstmate --as-of <UTC-ISO-time> < /absolute/private/snapshot.json
```

Read the [input and reporting contract](../../docs/SNAPSHOT-SKILLS.md). Expected actor/email are private operator-supplied facts, never public defaults. Observations may come from an existing read-only App owner or a supplied PR/commit author snapshot. Present observed versus expected and the observation basis. An author match does **not** prove current credentials, current App selection, approval or authority to publish, comment or merge.

The existing installation's App token owner remains the only credential owner. This script never calls it, reads environment credentials, logs a token, runs login, creates a store/config or probes permissions. Actual publication preflight remains external and separately authorized; UNKNOWN is not a bypass. Do not put credentials or raw owner diagnostics into snapshots.

Keep identity reports private. No acting mode, installation, activation or Firstmate tracked edits. Existing role and reporting contracts win; any future skill projection must use the unified installer with uninstall/inventory/toolcheck coverage, not a hand-edited global skill.
