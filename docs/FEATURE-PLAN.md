# Quarterdeck feature plan and delivery

This roadmap describes product contracts, not an installation's branch history or acceptance record. [Branch/version authority](branching-and-preview-model.md) governs admission and promotion; a roadmap never authorizes a push, service change or merge.

## Implemented surfaces

- **Conversation workspace:** lane and message-kind filtering, explicit product aliases, safe Markdown/raw rendering, debounced search, source/session identity, independent source windows and 200-record pages. Refresh preserves selection, disclosures and reading intent.
- **Navigation:** Overview, Work Split, Lane Chats, Expenses, Quota, Preferences and closed history have stable routes. Task links use `#lanes/<lane>/session/<task>`; filters and route identity remain separate from agent destinations.
- **Work model:** explicit repository/lane/theme classification, idempotent acknowledgement and exact evidence-bound delivery. [Work taxonomy](../prototype/WORK-TAXONOMY.md) owns execution evidence, pressure and completion attention semantics.
- **Expenses:** selected-home private overlay before empty public fallback; exact currency-separated ledger arithmetic; independently cached billing adapters with explicit attribution and unavailable states.
- **Quota:** allowlisted local adapter output, separate provider/effective-scope windows, bounded caching, visible stale/unavailable states and conservative timing semantics.
- **Review:** durable receipts, same-batch retries, exact version/origin checks, annotation/message distinction and guarded optional primary intake. Chat view context is advisory, never destination authority.
- **Presentation:** responsive shell, independent lane/kind/context panels, native disclosures, compact phone controls, visible keyboard focus and bounded growing dialogs.

## Acceptance contract for each change

1. Use synthetic, reproducible input; obtain separate authority for any private read. Do not publish live transcript filenames, account data, production workload measurements or private audit references.
2. Implement on an isolated task branch from its specified exact source. Preserve existing ownership, data, path and revision guards. Do not infer approval to rebase onto a moving integration branch.
3. Run relevant unit/integration checks and syntax/whitespace checks. Report exclusions exactly. DOM/CSS stubs do not prove browser layout.
4. For user-visible changes, bind a bounded authorized browser check to the clean exact serving revision and synthetic fixture. Exercise desktop, tablet and narrow phone behavior, keyboard/focus, overflow, disclosure and persistence. Intake/account access needs its own authorization; unavailable is honest evidence.
5. Record reviewed identities, results and residuals privately. Only the configured integration owner lands changes according to the branch contract. A committed candidate is not publication or deployment evidence.

## Future work requiring product decisions

- Structured task/author/outcome facets beyond current lane/kind/search/source selection.
- Voyage/anchor summarization with explicit retention, source fidelity and recoverability policy; the legacy design is not implemented behavior.
- Additional operational steering surfaces: define narrow schemas and role/ownership gates rather than terminal injection or arbitrary browser execution.
- Additional private runtime-owner migration: preserve receipt IDs, acknowledgements and exact delivery bindings before retiring any old checkout. Source sanitization alone is not that migration.

For current implementation boundaries use [architecture](ARCHITECTURE.md), [transcript contracts](../prototype/TRANSCRIPTS.md), [work taxonomy](../prototype/WORK-TAXONOMY.md), [layout acceptance](../prototype/LAYOUT-CORRECTION.md) and [private runtime ownership](PRIVATE-RUNTIME.md).
