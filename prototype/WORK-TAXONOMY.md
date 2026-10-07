# Quarterdeck taxonomy, attention and delivery

This is Quarterdeck-owned classification and presentation. It does not change stock Firstmate identities, task status, endpoint lifecycle, delivery, cleanup, decisions or the flat `[fm-lane Project]` / `[end Project]` grammar. Every existing composer still targets primary Firstmate only.

## Source characterization and boundary

- `data/projects.md` registers the existing flat transcript routes and message filters. Those routes remain stable; they are not new workstream identities.
- `data/backlog.md` supplies task IDs, recorded intents, queued/in-flight/completed membership and explicit repo/theme/epic metadata. A task brief may supply intent and the existing explicit **large project** classification, never repository/lane/theme ownership.
- A nonempty `project` field in `state/<task>.meta` takes precedence over the backlog repo field. The metadata file's mere presence does not prove current execution. Repository resolution is specified below.
- `state/<task>.status` supplies ordered current-state records and exact completion records. Bookkeeping `update`/`resolved` lines do not reopen a completed task. A keyed wait/decision remains pressure until an exact keyed resolution; `done` and Quarterdeck acknowledgements do not resolve it. Existing transcript history, inbox/outbox sources, message annotations and primary chat transport stay separate.
- Status-file mtime remains a transcript fallback clock, **not** a completion clock. Compatibility `completedToday` uses an explicit numeric completion epoch or a recorded backlog completion date. Neither age nor “today” determines completion freshness.
- Existing `tight`/`large` snapshot fields remain compatibility projections. `workSplit.items`, hierarchy and counts are the new UI authority; implementation slices and large projects appear once within their theme, including previous history rather than dropping undated completions.

## Explicit three-level navigation

Overview and Work Split use repository → lane/workstream → theme/iteration, with native disclosures, rollups, status/repository filters and stable task-session links. Lane Chat keeps its existing flat transcript routes and checked message filters; current focus and task history carry the same task classification. A theme is scoped to a lane in exactly one repository.

Repository resolution normalizes absolute paths and preserves operator-declared exact aliases before looking up bare names. Discovery maps direct directory children of `FM_HOME/projects` by name, including a registry spelling when it has one case-insensitive clone match. Bare-name lookup prefers exact spelling; otherwise case-insensitive matches must resolve to one path. `firstmate` maps to `FM_HOME` unless a direct clone named `firstmate` supplies that mapping; an exact saved alias still takes precedence. Registry membership alone does not prove a clone exists. Unmatched or ambiguous names, missing references and unaliased relative path fragments remain unknown; name splitting, substrings and prose never supply identity. Projection and classification writes use the same resolution.

The bounded default is deliberately **Repository unknown**, **Lane unclassified**, and **Theme / iteration unclassified**. A resolved repository path gets an opaque stable repository key and a basename **display label only**, not a fabricated workstream. Two different paths with the same basename remain distinct. Existing structured theme/epic metadata is usable as an explicitly labeled legacy group under the unclassified lane; arbitrary hyphenated task names do not create hierarchy.

Each task's Evidence & classification disclosure can create explicit lane/theme records in its known repository, select an existing pair, or remove that presentation assignment. References that remain unknown cannot be assigned until their repository identity is resolved. Creation is captain input, not extraction from worker prose. Names are bounded, reject operational path/control characters, and records never cross repositories implicitly.

## One durable Quarterdeck state owner

Default: ignored `prototype/data/agent-state.json`. `FM_QUARTERDECK_STATE_PATH` may select one **absolute**, private Quarterdeck-owned file outside `FM_HOME`. Registered children inherit the host's same owner path. No private owner path, repository checkout path, process PID/boot identity, remote URL or credentials are served in the new projection.

Schema `fm-agentos-state.v1`:

```json
{
  "schema": "fm-agentos-state.v1",
  "repositories": [{
    "id": "product", "name": "Product", "path": "/operator/approved/repository",
    "aliases": ["LegacyRepoName"], "remote": "origin", "github": "owner/repository",
    "destinations": [{"environment": "Review UAT", "tier": "uat"}],
    "lanes": [{"id": "ui", "name": "Interface", "themes": [
      {"id": "review", "name": "Review iteration", "kind": "iteration"}
    ]}]
  }],
  "assignments": {}, "acknowledgements": {}, "completionRecords": {}
}
```

`aliases`, `remote`, `github`, `destinations` and `completionRecords` are optional. Aliases must be exact and globally unambiguous. Assignment keys are SHA-256 task fingerprints; values are `{repositoryId,laneId,themeId}`. Labels are not identity. Fingerprints use the resolved repository path and exact task ID; dispatch from a resolved bare name or declared alias to that same absolute path keeps the task identity stable.

Writes share an exclusive filesystem lock, validate the entire document, write a mode-0600 temporary file, fsync, atomically rename and sync the directory. Concurrent browser/process retries read the latest locked document rather than replacing a stale snapshot. Existing acknowledgements survive normal server/browser restart. Invalid, oversized or symlinked files fail closed: read surfaces remain explicitly unclassified with a warning and changes are refused, never silently overwriting corrupt state. The state document is capped at 4 MiB.

A writer crash before rename leaves the previous complete document. An abandoned lock **is not stolen automatically**: reads remain available, writes fail safely until the operator verifies no writer owns it and repairs that specific owner lock. Do not remove locks based only on elapsed time. This is presentation-state repair, not Firstmate task cleanup.

`POST /api/work-state` reuses the existing exact Host/Origin guard (loopback or the one configured HTTPS review origin), bounded JSON and the serving-revision guard. It accepts only acknowledgement, classification or explicit taxonomy creation for a freshly projected exact task. It exposes no filesystem/Git mutation or agent destination control.

## Current execution versus pressure

- **Active** requires in-flight authoritative work, an executing state, and verified live process-incarnation evidence. Optional recorded `worker_pid`, `worker_start_ticks`, and `worker_boot_id` must match fresh Linux `/proc` evidence. Missing/unsupported liveness is **Unknown evidence**, not Active. No source files or metadata fields are created by this adapter.
- **Waiting / external delay**, **Captain action**, **Retained / cleanup**, **Backlog**, and **Unknown evidence** are separate. A preserved/cleanup-pending copy, failed worker, old metadata, dead process or unresolved decision cannot inflate Active.
- Multiple slices pointing to the same proven process incarnation count as **one active worker**. Hierarchical Active counts describe active slices; the Overview KPI and greater-than-eight review trigger use distinct genuinely active workers.
- Completion attention may coexist with retention or an unresolved keyed decision. Rows remain single; pressure and completion badges/counts describe separate dimensions and should not be summed as mutually exclusive totals.

Legacy homes without process-incarnation evidence will show unknown liveness for otherwise working records. This is intentional conservative behavior, not a claim that their workers stopped.

## Completion freshness is not delivery

An exact source completion gets a SHA-256 source fingerprint (visible for inspection), then a completion fingerprint including its explicitly bound commit, if any. File mtime, title changes, taxonomy changes, chat messages and unrelated bookkeeping do not acknowledge it. A distinct completion occurrence or bound commit creates a fresh completion identity. If the source provides no distinct new completion record/date, Quarterdeck cannot invent a new iteration from age.

**Newly done** means that exact identity is neither acknowledged nor proved durable at an accepted destination. **Mark understood** stores `{taskFingerprint,acknowledgedAt}` keyed by the completion fingerprint. It is durable and idempotent, but does not approve/reject review, publish, merge, deploy, answer a decision, delete/preserve a copy or close a Firstmate task. A renewed completion surfaces again. Flat transcript history remains based on source completion, not acknowledgement.

**Previously done** requires either that acknowledgement or exact authoritative evidence. Concise badges preserve exact safe evidence in the disclosure:

- **remote UAT / remote Main**: a fresh read-only `git ls-remote` advertisement for the accepted remote's exact `refs/heads/uat` / `refs/heads/main`, plus graph containment of the exact bound commit in that advertised head. No fetch or ref change occurs. Missing objects, unavailable remotes, stale local-only heads and replace-ref graph tricks cannot prove durability.
- **merged PR**: fresh `gh-axi api` evidence of a merged record in the explicitly configured GitHub repository, accepted base branch, and exact merge commit. The full forge URL and merge timestamp are retained. A merge alone is **not** deployment.
- **Live UAT / Live production**: only for an operator-reviewed configured deployment environment whose provider's latest deployment/status contract attests currently delivered code. The newest destination deployment must name the exact commit and environment and have a current successful status. Older SHA-filtered successful history, inactive statuses, local branches and remote containment do not establish live code. Leave `destinations` unset where provider success does not attest this delivery truth. This is read-only evidence, not deployment automation or independent runtime health verification.

Completion/commit association is explicit Quarterdeck state: `completionRecords[sourceFingerprint] = {taskFingerprint,commit,pullRequest?}`. Populate it from reviewed exact delivery records, using the source/task fingerprints from inspection. A task-level recorded head alone is withheld as unbound; it must not prove a later completion durable. Binding one outcome does not migrate that head to the task's next outcome. The browser cannot manufacture delivery bindings or deployment proofs.

A ready candidate is **Ready for review · deployment unknown**, even after acknowledgement or a merge. Live UAT can remain ready for review. Live production is separate verified delivery truth. Acknowledgement changes only freshness, never the delivery label. External reads are capped per snapshot; unavailable/unverified evidence stays unknown/reviewable rather than being inferred from prose.

## Layout and acceptance contract

Measure shell, filter, context and message widths independently with synthetic long-content fixtures. Crowded feed geometry is not evidence of a network failure; completed or preserved metadata is not an active-worker count.

The desktop fine-pointer shell now uses one low-weight edge stripe: click/Enter/Space toggles, a ≥6px drag resizes only while expanded, arrows resize, Home resets and Escape cancels a drag. Drag release never toggles; the last useful width survives collapse. The separator announces its current width/state and has visible focus. Coarse tablet and phone disclosure semantics are unchanged. Desktop articles use the pane width; prose stays bounded to 90ch while structured content can use the wider article. Mobile widths are unchanged.

Phone Overview overrides the inherited stacked KPI layout and large heading/card spacing with a compact three-column row, without negative margins or reordered reading. Compact quota reset text is inline with its bucket (`Week · 8h 20m`), or a deterministic rounded largest d/h/m unit for long labels/narrow containers. Exact reset semantics remain accessible; calculations/notches are unchanged and the removed visible tick explanation is not relocated elsewhere.

Package-free regressions cover model, owner, intake, grouping/navigation, current folding, fingerprint renewal, proof refusal, delivery/freshness separation, primary-only transport, edge interactions and compact reset formatting. Responsive acceptance requires a separately authorized browser matrix bound to the exact clean serving revision; prepared scripts and static CSS tests do not establish it. [LAYOUT-CORRECTION.md](LAYOUT-CORRECTION.md) specifies geometry, navigation and guarded-intake checks without installation-specific acceptance claims.
