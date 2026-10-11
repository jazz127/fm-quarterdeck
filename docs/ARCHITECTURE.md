# Firstmate Quarterdeck architecture

**Conversations are the application shell; lanes are the workspace.** Quarterdeck presents durable Firstmate records, work attention, expenses and subscription quota through a Node.js server and vanilla browser client.

## Ownership and data flow

```text
Explicit startup FM_HOME
  projects/fm-quarterdeck/          reviewed product source
  data/agentos/expenses/        private ledger, attribution and copy provenance
  data/projects.md, backlog.md Firstmate-owned registry and intent
  state/                       Firstmate-owned task/transcript sources
           |
           v
Node.js guarded readers -> bounded JSON APIs -> browser views
```

No home discovery or saved circular pointer inside the home is required. The selected home remains an explicit startup input. [Private runtime ownership](PRIVATE-RUNTIME.md) details the expense overlay and existing owners that are not migrated by source cleanup. In particular, taxonomy state currently requires an explicit owner outside `FM_HOME` when the source checkout is inside it; receipts and browser state keep their existing owners until separately migrated.

- `prototype/server.js`: HTTP mediation, home/fleet ingestion, bounded source windows and exact decimal expense rollups.
- `prototype/transcript.js` / `supervision.js`: JSONL normalization, exact-home session confinement, mirror deduplication and outcome notes.
- `prototype/private-runtime.js` / `cost-config.js`: guarded private expense selection and validated attribution.
- `prototype/costs.js` / `quota.js`: bounded allowlisted account adapters, cache coalescing and truthful unavailable/stale states.
- `prototype/bearings.js` / `chat-asks.js`: the snapshot call hub and the deterministic transcript chat-ask extractor composed over it.
- `prototype/agent-state.js` / `work-model.js`: atomic presentation state, explicit classification, read-only endpoint probes and completion/delivery separation.
- `prototype/review.js`, `inbox.js`, `revision.js`, `previews.js`, `preview-lifecycle.js`: exact identity, origin, receipt/intake and pre-provisioned runtime contracts.
- `prototype/public/`: hash routing, safe rendering, independently refreshing views, filters, source selection, pagination and accessibility.

## Durable record ingestion

`data/projects.md` registers flat lanes from `- ProjectName [meta] - Mission`; General is pinned for unowned/fleet-wide records. Backlog and `data/<task>/brief.md` supply recorded intent, not inferred hierarchy. `state/<task>.meta` gives explicit project/repository identity. Status line order is preserved; file mtime may be a transcript fallback but never proves a distinct completion clock.

Task inbox records are internal steers. Outcomes use recorded epochs. Optional external Pi sessions are read only from a cursor-selected directory encoding the exact selected home, without symlink components, with every session header confirming its real `cwd`. Same-role/kind/text native main turns replace mirrors within a bounded 60-second window; original sources are not edited. See [transcripts](../prototype/TRANSCRIPTS.md).

## Message classes

The [transcript contract](../prototype/TRANSCRIPTS.md#authorship) owns message classes, display defaults, saved selections and authorship. Display provenance never grants captain or execution authority.

Lane/kind/source/task/search filters intersect. Search is debounced and escaped. Source windows bound transfer while 200-record pages bound DOM work; diagnostics distinguish those limits. Tool density is a synthetic workload consideration, not a public record of an installation's activity.

## Surfaces

- **Overview:** fleet KPI cards and live bearings sections use a cached normalized model over host-only SSE, with polling for previews/error recovery. The [Captain's Call contract](../prototype/BEARINGS.md) owns sections, source evidence, engagement holds, answer choices, card threads and delivery. Answers and thread notes require an explicit captain send through the guarded Firstmate inbox; only Firstmate resolves filed calls. The [chat-ask decision record](CHAT-ASKS.md) owns deterministic primary-transcript extraction and linking.
- **Work Split:** repository → lane/workstream → theme, explicit classification and exact task links. Active requires in-flight executing work with process-incarnation proof. A recorded terminal pane is a weaker, visibly labelled evidence tier; it can inform the row but cannot establish Active or a live worker process. [Work taxonomy](../prototype/WORK-TAXONOMY.md) owns platform probes, evidence labels, pressure and completion attention semantics.
- **Lane Chats:** oldest-to-newest feed, independent refresh, preserved reading intent, safe Markdown/raw text, bounded history and context drawers. Lane envelopes are display hints, not agent authority.
- **Expenses:** selected private overlay before empty canonical public ledger; labeled synthetic demo only when the canonical file is absent. Decimal strings use BigInt cents with separate currency/project/category totals. Billing snapshots are separate, never added to ledger totals. Attribution comes from private `costs.json`; unknown allocation stays unclassified.
- **Quota:** allowlisted account adapter with six-second/one-MiB read bounds. Unsupported timing stays unknown. [Quota usage](../README.md#product-surfaces) owns the invocation, caching and freshness behavior.
- **Preferences:** guarded read-only selected-home `data/captain.md`; credential-like sections withheld. Only explicit terminal onboarding can preview/confirm owned preference changes.
- **Review / chat:** distinct validated schemas, exact version/origin, durable receipt and same-ID retry. Optional inbox readiness is not completion; advisory view context never selects a destination.

## Security and portability

No arbitrary browser shell, filesystem path, ref, command or destination control is provided. There are narrow POST contracts for review/chat, confirmed Captain's Call answers (`POST /api/bearings/answer`, receipts via `GET /api/bearings/answer/status`) card-thread questions (`POST /api/bearings/thread`, history via `GET /api/bearings/thread`), chat-ask dismissals (`POST /api/bearings/dismiss`, recorded only in Quarterdeck state) and procrastination (`POST /api/bearings/procrastinate`, Quarterdeck state only), all host-only, presentation state and registered preview selection; this is not a GET-only application. Optional [notification operations](MOBILE-NOTIFICATIONS.md) have their own exact-origin and private-state contract. Reads do not fabricate missing clocks, thinking, dialogue, currency conversion or account evidence.

Keep loopback binding or one exact private HTTPS Host/Origin pair. Forwarding headers and tailnet wildcard names are not authority. Every request proves the clean serving Git revision; no-Git archives fail closed. A later authorized fresh repository must regenerate all operator-owned revision bindings instead of carrying old objects/refs/history. HTML and search input are escaped; full feeds are not screen-reader live regions.

[Portability](PORTABILITY.md) defines Linux/WSL, Node, Python, browser and optional installed-tool/account prerequisites. Missing liveness, intake or account evidence stays unavailable; never relax confinement for superficial platform compatibility. A private-data runtime is not a public demo service.

## Validation

From a clean committed checkout: `cd prototype && npm test`; from the root: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s expenses`. Some full suites create disposable Git fixtures; authorization-limited checks use the [sanitization gate](PUBLIC-SOURCE.md). Synthetic unit/CSS tests and exact-revision browser acceptance prove different things. Preserve private data and shared services throughout validation.
