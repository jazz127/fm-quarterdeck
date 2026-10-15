# Five inactive snapshot skills

These **fm-quarterdeck source-only** skills share the deterministic
`scripts/quarterdeck-skill-report.mjs` reader:

| Skill | Report |
| --- | --- |
| [fmqd-fleet-health](../skills/fmqd-fleet-health/SKILL.md) | Selected-home current crew state versus event history, structured captain holds, recorded capacity/RAM and unknown waits |
| [fmqd-cleanup-sweep](../skills/fmqd-cleanup-sweep/SKILL.md) | Recorded inventory and explicit cleanup refusals; never eligibility approval |
| [fmqd-pr-readiness](../skills/fmqd-pr-readiness/SKILL.md) | Draft/state, head-bound reported checks/open work and independent exact served-head comparison |
| [fmqd-pr-identity-guard](../skills/fmqd-pr-identity-guard/SKILL.md) | Observed versus expected identity facts, never current credential proof or authority |
| [fmqd-restart-ready](../skills/fmqd-restart-ready/SKILL.md) | Concrete recorded blockers, informational receipt path and after-restart checklist; stow-safety always UNKNOWN |

## Source-only boundary

No skill in this table is projected by `firstmate-integration.mjs`. The existing
five installable skill links remain unchanged. The unchanged installer can retain
these tracked files as inert source in its manifest-tagged pin; normal pin
inventory/drift coverage does not activate or project them. These new files
are not global copies, registered hooks, installed preferences, pins or live
integration. Future projection needs a separate installer-owned change covering
tagging, uninstall, inventory and fmqd-toolcheck. Do not manually copy them into
Firstmate. No stock Firstmate source or persisted namespaces change.

This first delivery is **snapshot-only, report-first**: no network, filesystem
home reads, owner execution, lifecycle commands, action adapters, callbacks,
apply/force mode, controller, credentials, credential config or checkpoint store.
All acting paths require later separate authorization. The script imports only
Node built-ins and reads bounded standard input. It does not select a default
home from environment variables or enumerate endpoints. Unsupported flags refuse
before reading input. Reports are private operational evidence, not public issue
content. Caller-supplied provenance is not authenticated by the reader and cannot
confer action authority.

## Invocation and currentness

```bash
node scripts/quarterdeck-skill-report.mjs fleet-health \
  --home /synthetic/selected --as-of 2030-06-01T12:00:00Z \
  < /absolute/private/snapshot.json
```

Replace the synthetic selection and clock deliberately. `--home` must be a
normalized absolute POSIX path, not root, without control characters, trailing
slash or parent traversal. It is an equality/confinement label, **never opened**.
Only already-authorized selected-home captures may be supplied; snapshot
acquisition and authorization belong to existing owners, not this script. Do
not run a broad collector or probe another home to fill gaps. Existing stock
fleet collection can refresh observational caches and include other homes; this
reader never invokes it and does not follow its cross-home records.

`--as-of` is a required UTC ISO clock, fixed for deterministic replay. Each
observation must have a valid UTC timestamp no more than five minutes before
that clock. Missing, future, stale, wrong-home or unsupported evidence is
UNKNOWN with a reason. No fallback from historical logs, source head, idle or
reachability. Reports never assert fleet-wide all-clear. Exit 0 means a report
was produced, **not** healthy/ready/safe/approved. Invalid JSON, more than 1 MiB
of input or invalid CLI usage exits 2 with sanitized diagnostics. Arrays are
bounded to 512 records; invalid/over-bound inventories remain unknown rather
than silently truncating. Arbitrary raw owner output, details, tokens, action
strings and receipt prose are not echoed. Do not put secrets in any input field;
identity facts and the optional receipt path are intentionally private output.

## Input contract

Top-level JSON object: `schema: "fmqd-skill-input.v1"`. All evidence is optional;
`{ "schema": "fmqd-skill-input.v1" }` is a complete minimal input producing
unknown reports. Unknown fields are ignored, not interpreted as instructions.

### Existing fleet schema

`fleet` is an existing `fm-fleet-snapshot.v1` capture, **not** a new fleet source:

- `schema`, `generated`, `fm_home` must match the existing schema, clock and
  selected home. `tasks` uses the existing unique task `id` and
  `current_state.{state,source,observed_at,freshness}` from `fm-crew-state.sh`.
  Remote rows stay unknown and are not probed. A current state with a missing
  clock/source/freshness stays unknown. Raw/detail strings are withheld.
- `paths.status_log.last_event.state` is explicitly historical and rendered
  separately; it never overrides current state. A current paused observation
  reports only that fact. Wait target/completion conditions remain unknown
  because that owner has no structured wait-target contract; no prose matching.
- `backlog.{present,records}` retains existing `structured`, `state`
  (`in_flight`, `queued`, `done`), `hold_kind`, `hold_bucket`,
  `captain_actionable`, `id` and `hold_set`. Only non-done, structured captain
  holds with consistent live classification can supply the oldest actionable
  call. No generic technical blocked line counts. Missing clocks, unstructured
  coverage, conflicting/duplicate records or date-only hold clocks leave oldest
  unknown; no `since`/file-mtime/prose fallback or reimplementation of hold policy.
- Other-home summaries, endpoint/action objects, body excerpts and raw logs are
  not projected. The supplied snapshot alone is coverage, not the whole fleet.

### Independently supplied read-only facts

Other keys use an explicit envelope:

```json
{
  "schema": "fmqd-skill-input.v1",
  "capacity": {
    "home": "/synthetic/selected",
    "owner": "supplied-snapshot",
    "observedAt": "2030-06-01T12:00:00Z",
    "data": { "limit": 2, "occupied": 1 }
  },
  "ram": {
    "home": "/synthetic/selected",
    "owner": "supplied-snapshot",
    "observedAt": "2030-06-01T12:00:00Z",
    "data": { "totalBytes": 8192, "availableBytes": 4096 }
  }
}
```

`owner` names the existing read-only owner or supplied snapshot, not a command to
execute and not proof of authority. All counts are nonnegative safe integers.
This envelope describes captured facts; it does not replace any stock policy or
create a new producer/controller. Adapters and live collection are absent.

| Key | `data` fields | Existing owner / limitation |
| --- | --- | --- |
| `capacity` | positive `limit`, `occupied` | Captured `fm-project-capacity-lib.sh` facts or neutral supplied snapshot; no root-home config lookup, home walk, admission policy or spawn |
| `ram` | positive `totalBytes`, `availableBytes <= totalBytes` | Already supplied machine observation; no process inspection or RAM policy |
| `pr` | `repository`, `target`, exact 40-lowercase-hex `headRefOid`, `state` (`OPEN`, `CLOSED`, `MERGED`), boolean `isDraft`, `checks: [{head,state}]` (`PASS`, `FAIL`, `PENDING`, `SKIPPED`), `openWork: {head,count}` | Saved read-only forge observations or neutral supplied snapshot. `fm-pr-state.sh` itself emits blocker lines, not this JSON; an empty blocker listing cannot prove readiness. No raw text parser. Checks/open work must each bind to the source head. No implied completeness of required contexts or unresolved threads |
| `served` | matching `repository`, `target`, exact `head`, `independent: true`, boolean `healthy` | Independently supplied serving observation, with its own clock; never synthesized from source or a green build. The boolean declares provenance, not authentication. Missing/foreign/stale evidence unknown; mismatched head explicitly false |
| `identity` | `expected: {actor,email}`, `observed: {actor,email}`, `basis`: `app-owner-read`, `pr-author`, `commit-author` or `supplied-snapshot` | Existing App read owner or supplied observation only. No private operator path, real expected actor/email, token owner or token is a public default. Author facts do not prove current credentials; comparison never authorizes publication/comment/merge |
| `restart` | `blockers: []` containing only `uncommitted-work`, `unpublished-work`, `open-decision`, `unacknowledged-note`, `unknown-owner` | Already supplied structured observations; empty does not prove safe/durable/resumable |
| `receipt` | `newestReceiptPath` | Caller-selected newest receipt PATH only, informational; not opened, sorted, followed or parsed. No prose-to-safety conversion |

Cleanup inventories tasks without following resource paths. The inspected stock
`fm-teardown.sh` has **no supported read-only dry-run**; this delivery reports
that owner UNAVAILABLE and never tries an unsupported flag. Idle, reachable,
branch-present, caller approvals or remote reachability are never eligibility.
Landing, exclusive ownership and cleanup authority remain unverified.

**Stow-safety is ALWAYS UNKNOWN / not-verified.** Stock Firstmate has no structured
machine-readable stow checkpoint; stow receipts are prose only. A receipt, clean
source, empty blockers or idle agent cannot establish a positive verdict. The
checklist identifies later verification duties without running stow, restart,
resume, inbox, lock or retention actions or introducing a checkpoint.

## Validation and compatibility

`node --test test/quarterdeck-skill-report.test.mjs` uses only neutral snapshots,
pure-function assertions and a CLI with an unavailable tool PATH. It covers
replay, unknown/stale/future/conflicting/wrong-home input, historical versus
current state, structured captain holds, cleanup refusals, exact served-head
mismatch, identity mismatch, unconditional stow unknown, bounded input, rejected
action flags and inactive installer inventory. No live integration, installed
harness discovery, service acceptance or second-target delivery follows from it.
The shared reader has no application-server imports or dependencies and changes
no package/lockfile, installer projection, persisted schema or stock owner.
