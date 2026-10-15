---
name: fmqd-autoclean
description: Explicit opt-in report-only inventory of recorded stale Firstmate agents, copies, panes and terminals, with optional established tracking findings; no cleanup or reset.
user-invocable: true
---

# /fmqd-autoclean

This is an **OFF-by-default, report-only** fm-quarterdeck add-on. Source or skill discovery does not enable it; `/fmqd-auto` does not enable it. No turn-end hook or size trigger is installed. Claude, Pi and secondmates may explicitly request the same read-only report; discovery is not live harness acceptance.

Use the reviewed Quarterdeck skill directory containing this file (including its installer-owned immutable projection), with an explicitly selected authorized home. Resolve the script relative to this skill, not a stock Firstmate or mutable checkout command:

```bash
node <Quarterdeck-skill-directory>/../../scripts/quarterdeck-autoclean.mjs
# Explicit one-shot opt-in; selected home only:
node <Quarterdeck-skill-directory>/../../scripts/quarterdeck-autoclean.mjs --enabled-report /absolute/selected/firstmate
# Optional local established issue/Project link findings:
node <Quarterdeck-skill-directory>/../../scripts/quarterdeck-autoclean.mjs --enabled-report /absolute/selected/firstmate --tracking-findings
```

With no arguments the script reports disabled and reads no home. Enabled mode reads only bounded regular `state/*.meta`, `state/*.status` and `data/backlog.md` records inside the selected home. It never follows a copy path, probes a recorded backend, enumerates global terminals/worktrees, or reads another home's endpoints. A secondmate must select its own authorized home, not its parent's. Never run this report against a home outside your current authority.

Present coverage, candidates, protected/unverified records and limitations. A stale candidate means a locally closed task with an old done declaration (at least 24 hours), no recorded open hold/blocker, and not in flight. It does **not** prove an agent is dead, a copy is landed/clean, a pane is idle, exclusive ownership, or permission to remove anything. All resources remain protected and landing/liveness unverified. Missing/unsafe owners, foreign/secondmate endpoints, unlanded work, conflicting metadata and unknown timestamps are not cleanup candidates. Resources absent from task metadata are outside coverage, not absent from the fleet.

Optional tracking findings reuse explicit existing issue/Project links in the backlog, grouped with its recorded repository. They do not infer current remote values, desired statuses, publication or completion. Route review to the established reporter; no network lookup, status repair, schema/member creation or reconciliation write occurs. Absent tracking is not-applicable; unavailable backlog evidence is unverified. Do not publish this private report or its resource paths.

**Never follow this invocation with `/stow`, `/clear`, `/new`, cleanup, detach, lifecycle sends, lock recovery or reconciliation actions as part of this skill.** There is no acting mode or hidden reset flag. Own-pane reset and ALL acting modes are deferred to later work requiring a supported detach/completion interface and separate concrete authority. Native reset and Firstmate startup/lock/supervision continuity remain unexercised; source tests are not live acceptance.

Installation/removal/inventory/pin-drift checks belong only to `scripts/firstmate-integration.mjs` and `/fmqd-toolcheck`. Do not hand-project skills, alter stock Firstmate, activate hooks, change services or install globally. Existing parent/worker identity and reporting authority always win.
