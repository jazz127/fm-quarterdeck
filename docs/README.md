# Quarterdeck documentation

Quarterdeck is the Firstmate operational cockpit: conversations are the shell; lanes are the workspace. The custom frontend in `prototype/` is the product runtime.

| Document | Authority |
| --- | --- |
| [License](../LICENSE), [governance](../GOVERNANCE.md), [security](../SECURITY.md), [contributions](../CONTRIBUTING.md), [notices](../THIRD-PARTY-NOTICES.md) | MIT source-preview posture, repository-owner maintenance and truthful upstream attribution |
| [Architecture](ARCHITECTURE.md) | Data flow, message classes, surfaces and security boundaries |
| [Live Captain's Call](../prototype/BEARINGS.md) | Overview calls, snapshot cadence, SSE, engagement hold, readable card text and confirmed answers |
| [Chat asks](CHAT-ASKS.md) | Decision record: model-free extraction of chat asks into Captain's Call, resolution paths, limits and rejected alternatives |
| [Quarterdeck rename](QUARTERDECK-RENAME.md) | Current product identity, retained compatibility namespaces and deliberate rollout |
| [Branch/preview contract](branching-and-preview-model.md) | Admission, exact identities, local/remote evidence and isolated previews |
| [First run](FIRST-RUN.md) | Explicit home selection and owned preference preview/confirmation |
| [Private runtime](PRIVATE-RUNTIME.md) | Expense overlay, preservation and existing owner boundaries |
| [Portability](PORTABILITY.md) | Supported platform and optional feature prerequisites |
| [Public source](PUBLIC-SOURCE.md) | F01–F13 dispositions, K01–K05 explanations, T01–T04 exclusions and validation gates |
| [Source-preview validation](SOURCE-PREVIEW-VALIDATION.md) | Offline behavioral gate, runtime/read limits and real-environment boundaries |
| [Open-source contributions](OPEN-SOURCE-CONTRIBUTIONS.md) | Public repository setup, required review/check enforcement and contribution triage |
| [History-free export](HISTORY-FREE-EXPORT.md) | Reviewed allowlist, tree-only archive verification and temporary first-commit runtime/full-suite acceptance |
| [Feature plan](FEATURE-PLAN.md) | Present capabilities, future decisions and acceptance contracts |
| [Firstmate integrations](FIRSTMATE-INTEGRATIONS.md) | Optional skills/mechanical helpers, deliberate activation and rollback |
| [Instruction-to-code inventory](INSTRUCTION-TO-CODE.md) | Feature/integration instruction dependencies, safe conversions and remaining judgment/authority gates |
| [Toolcheck](TOOLCHECK.md) | Scoped installed-tool audit |
| [Private Tailscale launch](tailscale-launch.md) | Optional exact-origin private Serve launch |
| [Legacy branch inventory](dev-branch-inventory.md) / [parked work](parked-work.md) | Generic migration procedures, not installation inventories |

## Source map

- `prototype/`: Node built-in server/adapters, `public/` browser UI, synthetic `test/` and optional `scripts/` checks.
- `expenses/`: empty valid public ledger, Python helper and synthetic tests; real records belong in the selected-home overlay.
- `skills/`: optional Quarterdeck-owned integration instructions/tools.
- `prototype/TRANSCRIPTS.md`, `SESSION-WINDOW.md`, `WORK-TAXONOMY.md`, `LAYOUT-CORRECTION.md`, `VISUAL-DESIGN.md`: detailed ingestion, work and presentation contracts.

Normal record readers are read-only. Narrow guarded review/intake, taxonomy and preview-selection operations are explicit exceptions, not arbitrary operational control. A local candidate, receipt, running process, remote checkpoint and deployed release are different evidence states.
