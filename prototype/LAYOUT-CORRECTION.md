# Exact-revision layout acceptance

Bind `/api/review.version` and the UI revision label to the full clean serving commit before measuring. Use synthetic task-isolated fixtures, not a shared service. A prepared script or CSS-model test is not proof of browser paint or guarded intake.

## Layout contracts

1. **Message kinds:** compare expanded, stable collapsed, hover/focus and phone states. Move pointer and focus away before measuring stable collapse. All nine named checkbox/SVG controls must retain visible bounds, selection and focus semantics; collapse never changes selection.
2. **All rail:** collapsed Included lanes places native All first and sticky at the top. Remaining controls are named icons in DOM focus order. All restores live lanes without changing kind/status filters or selecting closed history. Compact layouts retain their existing drawer behavior.
3. **Context/history:** long context scrolls independently while history remains reachable at the rail bottom. Open history has its own bounded scroll region and sticky summary. Reach older-session controls by keyboard; repeat in tablet/phone drawers with Escape/focus restoration and safe-area clearance.
4. **Growing dialogs:** open annotation near each viewport edge. Grow/shrink content after opening; title, close and actions stay within visual viewport/safe-area bounds. Essential content scrolls internally. Exercise keyboard viewport shrink, page/element scroll, resize and desktop/phone reparenting without losing drafts/queues. Do not send probes to real intake.
5. **Phone KPIs:** measure visible Overview at 390 and 320 pixels: three positive, same-row, nonoverlapping cards, contained horizontally with no content overflow. Work Split hides Overview; its zero-area boxes are inapplicable, not clipping evidence. `scripts/kpi-geometry.mjs` captures route, actual/layout/visual viewport, tracks/gap and boxes before assertions.
6. **Shell/quota:** retain click-versus-drag distinction, keyboard resizing, width persistence, compact reset semantics and page-level overflow checks.

## Exact task navigation

Select `#projects .work-slice[data-task-fingerprint="<synthetic fingerprint>"] a.crew-task[href]` (or `#tight-work` for Work Split). Require the canonical href `#lanes/${encodeURIComponent(chatLaneId)}/session/${encodeURIComponent(taskId)}`; click the emitted anchor, not an invented route. Assert:

- location hash and active conversation view match;
- an active history row has exact lane/session dataset IDs;
- `#task-filter-id` contains the exact task ID even when the desktop chip is hidden; the breadcrumb may shorten it to 24 characters.

A task-scoped feed may be empty when filters exclude its records. Do not reinterpret a hidden chip as failed navigation.

## Guarded intake is a separate acceptance gate

`GET /api/review` reports exact revision, delivery, session and intake readiness. False intake readiness can mean nonlocal delivery, absent selected home, refused guarded inbox executable, invalid readiness response or primary inability to receive. Never fabricate readiness or weaken path/origin/revision checks to fix a layout test.

Only an explicitly authorized operator may verify a real durable synthetic receipt. Use the same-origin native `/api/review` schema and exact version/session; retain the same batch/payload for uncertain retry. Local receipt proves durable acceptance, not downstream completion. Guarded `note`/`announce` and receipt status provide separate intake evidence. A synthetic home without `bin/fm-inbox.sh` cannot prove real intake.

Registered `/preview/<id>/api/chat` is a separate schema requiring an explicit primary-Firstmate `chatDeliver` adapter. A fixture's injected adapter proves synthetic routing only; absence correctly returns unavailable.

## Checks

`cd prototype && npm test` covers the server, renderer and CSS-model regressions. Focused suites include `layout-correction`, `pane-bounds`, `filter-view`, `ui`, `edge-handle`, `review-cutoff`, `review`, `server`, `transcript` and `work-model`. Full HTTP checks require a clean committed checkout because mixed revisions deliberately fail closed. Browser prerequisites and authorization limits are in `../docs/PORTABILITY.md`.
