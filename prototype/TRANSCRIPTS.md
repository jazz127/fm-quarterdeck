# Durable transcript coverage

`transcript.js` (Pi sessions) and `supervision.js` (fleet outcomes) are read-only adapters. No pane scraping, thinking generation, prompt changes or extra mirror traffic is required.

## Sources and confinement

- Metadata inventories cover `FM_HOME/state/branch-session/*.jsonl` and optional `state/main-session/*.jsonl`.
- `state/.branch-session` and optional `.main-session` point to JSONL inside the same real home. Duplicate paths load once.
- `state/.branch-mirror-cursor` contains `{file,index}`. The writer cursor index is not a read-history limit. An external main Pi directory is allowed only when its basename encodes the exact selected home (synthetic example: `--synthetic-home--` for `/synthetic/home`), with no directory symlink. Each regular JSONL file must have a first session record whose `cwd` equals the real selected home. Other homes are never scanned. Browser labels use `main-pi-session/<filename>`, not the absolute path.
- `state/branch-outcomes.jsonl` non-silent `{seq,task,summary,verdict,epoch}` records become fleet notes with recorded epoch time. Optional `terminal-outcomes.jsonl` also supports `task_id` and `created_epoch`. Notes go to General and the metadata-owned project lane. The ledger wins over duplicate displayed merge notices.
- Captain notes, task status, task inbox and outbox remain separate sources. Task inboxes are internal steers, not captain chat. Presentation receipts are not original dialogue.

Missing, invalid or unavailable main sources produce explicit gap notes, never reconstructed conversation. A different storage convention needs a deliberately reviewed adapter or an authorized mirror preserving original role, native thinking, timestamps and identity. Do not broaden discovery to arbitrary session directories.

## Bounded display contract

The [source window](SESSION-WINDOW.md) loads active/recent sources initially, with older metadata and explicit bounded loads. Within selected sources, full records are read line-by-line without per-kind/status-line caps. Invalid JSON and undated conversation records are counted as coverage limits rather than assigned invented clocks. The client renders at most 200 records per page and distinguishes loaded records from the current page.

Complete standalone `[fm-lane <registered project>]` / `[end <same project>]` blocks route exclusively to that project before legacy name matching. Multiple valid blocks separated by blank lines project independently with distinct derived record IDs; original Pi text is unchanged. Public product aliases `Quarterdeck` / `Quarterdeck` and `Lavish` resolve to `fm-quarterdeck` and `lavish-axi`. Explicit General stays only in General. General receives no project-block copy. Unknown/malformed/unmarked envelopes use legacy ownership/name matching, which is not perfect contextual attribution. Lane, task and disk-session filters intersect.

Captain, Firstmate replies and supervision notes default on. Native thinking enables thinking when present; crew, tools, harness, steers and branch replies default off. Main mirrors are Firstmate replies, not crew replies. Thinking is only native stored assistant content. Tool calls/results and shell output use the tool class. Pure harness operation envelopes, wake prompts and skill dumps are omitted; ordinary user text and mixed ordinary/skill blocks survive.

Native main turns supersede same-role/kind/text mirrors within 60 seconds; duplicate branch mirrors in that window also collapse. Genuine repeated turns elsewhere remain. Stable record IDs deduplicate cross-lane appearances. Markdown/raw views escape HTML; lane markers remain visible text. Images get unsupported-attachment labels. Unpersisted text cannot be recovered.

`npm test` in `prototype/` covers synthetic multi-session/cursor confinement, extraction, outcome/alias routing, defaults, identity, windows and pagination. UI tests use a DOM stub, not a browser layout engine. No live session identifiers or workload captures belong in public documentation.
