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

- **Overview:** fleet KPI cards plus live Captain's Calls from `$FM_HOME/bin/fm-bearings-snapshot.sh --json`. The cached, normalized call model travels via host-only SSE (previews/error recovery poll with `since`); keyed patches hold while engaged and preserve typed text. Answers are relayed only on an explicit captain confirmation, as an `fm-bearings-answer.v1` inbox note through `$FM_HOME/bin/fm-inbox.sh`; Quarterdeck never closes a filed call. Answers can be queued and sent together from the review panel, or from Send queued (N) on the Active view; both use one sender, and each is still its own note. Each open card has one lifecycle state, Procrastinated, then Sent, then Queued, then Active, and Overview shows Active until a status toggle selects another. A Sent card is hatched and labelled from the inbox receipt (pending: waiting for Firstmate to read; acknowledged with no reply: Firstmate is on it). A sent answer shows Your answer at the top of the card and locks its choices under the same hatch, and a thread follow-up stays editable. A reply while the call stays open returns the card to Active with that reply at the top and the controls unlocked. Only disappearance from bearings confirms a filed call. Each card has one text box. A picked option is an answer. Text with no option selected relays a captain thread note as an inbox note keyed by the card key (Firstmate answers with `fm-inbox.sh reply` or in chat) and the card shows a read-only, mechanical join of that card's notes, replies (joined by note id from inbox receipts) and Firstmate's Claude/Pi transcript messages naming its whole task id. Thread history is collapsed until the captain expands a card with two or more entries, and a later reply is marked until that history is opened. Procrastinate hides a live card until a Quarterdeck-only time, separate from answers. Below the page header and the KPI summary, the Overview body is two equal columns with a 22px gap. Captain's Call stays in the first column. Just landed cards from the snapshot's landed rows fill the second column, and on phone widths those two sections are tabs. History shows the full entry text, Copy, and absolute/relative clocks; read markers are local UI state, not Firstmate intake. Asks Firstmate makes only in chat (`ACTION`/`APPROVAL`/`DECISION NEEDED` marker lines) are extracted mechanically from the primary transcript behind a byte cursor and served as chat cards in the same model; see the [chat-ask decision record](CHAT-ASKS.md). No project tree. [Captain's Call](../prototype/BEARINGS.md) owns the contract.
- **Work Split:** repository → lane/workstream → theme, explicit classification and exact task links. Active requires in-flight executing work with process-incarnation proof. A recorded terminal pane is a weaker, visibly labelled evidence tier; it can inform the row but cannot establish Active or a live worker process. [Work taxonomy](../prototype/WORK-TAXONOMY.md) owns platform probes, evidence labels, pressure and completion attention semantics.
- **Lane Chats:** oldest-to-newest feed, independent refresh, preserved reading intent, safe Markdown/raw text, bounded history and context drawers. Lane envelopes are display hints, not agent authority.
- **Expenses:** selected private overlay before empty canonical public ledger; labeled synthetic demo only when the canonical file is absent. Decimal strings use BigInt cents with separate currency/project/category totals. Billing snapshots are separate, never added to ledger totals. Attribution comes from private `costs.json`; unknown allocation stays unclassified.
- **Quota:** allowlisted account adapter with six-second/one-MiB read bounds. Unsupported timing stays unknown. [Quota usage](../README.md#product-surfaces) owns the invocation, caching and freshness behavior.
- **Preferences:** guarded read-only selected-home `data/captain.md`; credential-like sections withheld. Only explicit terminal onboarding can preview/confirm owned preference changes.
- **Review / chat:** distinct validated schemas, exact version/origin, durable receipt and same-ID retry. Optional inbox readiness is not completion; advisory view context never selects a destination.

## Security and portability

No arbitrary browser shell, filesystem path, ref, command or destination control is provided. There are narrow POST contracts for review/chat, confirmed Captain's Call answers (`POST /api/bearings/answer`, receipts via `GET /api/bearings/answer/status`) card-thread questions (`POST /api/bearings/thread`, history via `GET /api/bearings/thread`), chat-ask dismissals (`POST /api/bearings/dismiss`, recorded only in Quarterdeck state) and procrastination (`POST /api/bearings/procrastinate`, Quarterdeck state only), all host-only, presentation state and registered preview selection; this is not a GET-only application. Reads do not fabricate missing clocks, thinking, dialogue, currency conversion or account evidence.

Keep loopback binding or one exact private HTTPS Host/Origin pair. Forwarding headers and tailnet wildcard names are not authority. Every request proves the clean serving Git revision; no-Git archives fail closed. A later authorized fresh repository must regenerate all operator-owned revision bindings instead of carrying old objects/refs/history. HTML and search input are escaped; full feeds are not screen-reader live regions.

[Portability](PORTABILITY.md) defines Linux/WSL, Node, Python, browser and optional installed-tool/account prerequisites. Missing liveness, intake or account evidence stays unavailable; never relax confinement for superficial platform compatibility. A private-data runtime is not a public demo service.

## Validation

From a clean committed checkout: `cd prototype && npm test`; from the root: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s expenses`. Some full suites create disposable Git fixtures; authorization-limited checks use the [sanitization gate](PUBLIC-SOURCE.md). Synthetic unit/CSS tests and exact-revision browser acceptance prove different things. Preserve private data and shared services throughout validation.
