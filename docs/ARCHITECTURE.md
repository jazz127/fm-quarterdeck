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

| Kind | Meaning | Default |
| --- | --- | --- |
| captain | Stored human turns/notes | on |
| conversation | Firstmate replies / main mirrors | on |
| supervision | Durable fleet outcome notes | on |
| thinking | Native stored assistant thinking only | on when available |
| branch | Crew branch replies | off |
| crew | Worker status/outbox records | off |
| tools | Tool calls/results and shell output | off |
| steer | Internal worker inbox instructions | off |
| harness | Displayed framework notices | off |

Lane/kind/source/task/search filters intersect. Search is debounced and escaped. Source windows bound transfer while 200-record pages bound DOM work; diagnostics distinguish those limits. Tool density is a synthetic workload consideration, not a public record of an installation's activity.

## Surfaces

- **Overview:** fleet KPI cards plus Captain's Calls and Just landed from the guarded snapshot hub, composed with deterministic primary-transcript chat asks. Host-only SSE carries the cached model; previews and stream recovery poll with `since`. Confirmed answers and thread notes use the guarded inbox relay, while filed-hold resolution remains Firstmate-owned. [Captain's Call](../prototype/BEARINGS.md) owns the presentation, lifecycle, feed-health and wire contracts; the [chat-ask decision record](CHAT-ASKS.md) owns extraction and resolution rationale. Second mates remain below the columns and outside phone tab panels; [work taxonomy](../prototype/WORK-TAXONOMY.md#explicit-three-level-navigation) owns their evidence, and [visual design](../prototype/VISUAL-DESIGN.md) owns their placement.
- **Work Split:** repository → lane/workstream → theme, explicit classification and exact task links. Active requires in-flight executing work with process-incarnation proof. A recorded terminal pane is a weaker, visibly labelled evidence tier; it can inform the row but cannot establish Active or a live worker process. [Work taxonomy](../prototype/WORK-TAXONOMY.md) owns platform probes, evidence labels, pressure and completion attention semantics.
- **Lane Chats:** oldest-to-newest feed, independent refresh, preserved reading intent, safe Markdown/raw text, bounded history and context drawers. Lane envelopes are display hints, not agent authority.
- **Expenses:** selected private overlay before empty canonical public ledger; labeled synthetic demo only when the canonical file is absent. Decimal strings use BigInt cents with separate currency/project/category totals. Billing snapshots are separate, never added to ledger totals. Attribution comes from private `costs.json`; unknown allocation stays unclassified.
- **Quota:** allowlisted account adapter with six-second/one-MiB read bounds. Unsupported timing stays unknown. [Quota usage](../README.md#product-surfaces) owns the invocation, caching and freshness behavior.
- **Preferences:** guarded read-only selected-home `data/captain.md`, with credential-like sections withheld; terminal onboarding and the opt-in integration installer own separate blocks in that home record. The browser saves Away supervision settings in a separate Quarterdeck file. [Preferences usage](../README.md#product-surfaces) owns the settings contract, and [Firstmate integrations](FIRSTMATE-INTEGRATIONS.md) owns installer activation and rollback.
- **Review / chat:** distinct validated schemas, exact version/origin, durable receipt and same-ID retry. Optional inbox readiness is not completion; advisory view context never selects a destination.

## Security and portability

No arbitrary browser shell, filesystem path, ref, command or destination control is provided. Narrow writes cover review/chat, presentation state and registered preview selection. The [bearings contract](../prototype/BEARINGS.md) owns the additional host-only answer, thread, chat-dismissal, procrastination and landed-acknowledgement APIs. The [Preferences surface](../README.md#product-surfaces) owns the same-origin health-preference save; isolated previews may read those preferences but cannot save them through the preview proxy. Reads do not fabricate missing clocks, thinking, dialogue, currency conversion or account evidence.

Keep loopback binding or one exact private HTTPS Host/Origin pair. Forwarding headers and tailnet wildcard names are not authority. Every request proves the clean serving Git revision; no-Git archives fail closed. A later authorized fresh repository must regenerate all operator-owned revision bindings instead of carrying old objects/refs/history. HTML and search input are escaped; full feeds are not screen-reader live regions.

[Portability](PORTABILITY.md) defines Linux/WSL, Node, Python, browser and optional installed-tool/account prerequisites. Missing liveness, intake or account evidence stays unavailable; never relax confinement for superficial platform compatibility. A private-data runtime is not a public demo service.

## Validation

From a clean committed checkout: `cd prototype && npm test`; from the root: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s expenses`. Some full suites create disposable Git fixtures; authorization-limited checks use the [sanitization gate](PUBLIC-SOURCE.md). Synthetic unit/CSS tests and exact-revision browser acceptance prove different things. Preserve private data and shared services throughout validation.
