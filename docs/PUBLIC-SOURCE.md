# Public-source sanitization and transfer gate

This document preserves disclosure audit finding IDs without copying private values, fingerprints, source pins or operational evidence. Sanitized source is not publication approval, a private-data backup, a Git-free executable release, or authorization to retire any existing checkout/service.

## Required tracked findings

| ID | Disposition at the smallest safe boundary |
| --- | --- |
| F01 | Canonical ledger is empty/valid; selected-home bundle takes precedence and fails closed if unsafe. Empty UI directs users to a private ledger. Real records stay untouched. |
| F02 | Exact-origin tests use a reserved synthetic device domain, including deceptive suffix/userinfo/sibling cases. Docs use discovery/configuration, not an installed origin. Host/Origin guards unchanged. |
| F03 | Mixed-layout browser script requires explicit authorized `FM_HOME`; no user-home fallback. |
| F04 | Neutral absolute/encoded-home examples and configuration errors; exact-home confinement unchanged. |
| F05 | Transcript pointers, private excerpts, workload captures and report links replaced with synthetic regression/performance contracts. |
| F06 | Parked-work and branch-inventory documents are generic optional migration procedures, not private inventories; incoming links updated. |
| F07 | Self-contained product documentation with the Firstmate runtime dependency explicit; no external document-store relationship, personal account URL or old bootstrap pin. |
| F08 | Public attribution map is empty; private validated key/value/label configuration remains authoritative for success, partial, unknown and unavailable states. Browser fallback is unclassified only; tests supply explicit synthetic mappings. |
| F09 | Example Store/Example-Store-UI names and IDs replace portfolio-derived fixtures/skill examples consistently; mixed-block and public product-alias coverage retained. |
| F10 | Installation-specific branch pins, acceptance/landing/restart narratives and obsolete status prose replaced by present-tense behavior and portable acceptance. |
| F11 | Clean exact-root Git identity remains mandatory; a shared startup/request helper rejects parent-repository discovery and strips inherited Git redirection. Git-free archive execution is unsupported. [History-free acceptance](HISTORY-FREE-EXPORT.md) verifies exports, then proves real initial-commit startup and preview behavior in temporary repositories. The lifecycle lab builds its own synthetic ancestry from verified tree exports, never the source parent or shared old objects. Real release provisioning/rebinding remains separately authorized. |
| F12 | Browser scripts use explicit `CHROMIUM` or PATH `chromium`, not a cached build number. Node 22+/CDP prerequisites are explicit. |
| F13 | [Portability](PORTABILITY.md) defines Linux/WSL/POSIX, optional tools, authenticated operator account selection, onboarding/intake and fail-closed limitations. No scope/ownership guards relaxed. |

## Retained findings and explanations

- **K01:** Public dependency/upstream identifiers, npm registry integrity/license/funding metadata, product author attribution, Quarterdeck/Lavish aliases and `kunchenguid` tool ownership are intentional public contracts, not a private operator account. `private: true` prevents accidental npm publication.
- **K02:** Artificial redaction/refusal sentinels, fixture UUIDs/revisions, `.invalid` identities and synthetic subscription-shaped IDs remain. They prove rejection/privacy behavior, not installed credentials. Regex/CSS/SVG syntax and public API query templates are not personal paths or signed account URLs. No blanket test/JSON/lockfile scanner exemption is introduced.
- **K03:** Loopback ports, reserved hosts, generic branch names, environment-variable contracts and neutral path placeholders remain. Keep exact origin checks and local binding; do not globally redact words such as account, subscription or author.
- **K04:** Explicit synthetic demo ledger/fleet/quota inputs and generic owned preference template remain. Provider drawings were removed in favor of existing neutral text/monograms; no artwork rights or endorsement are inferred. These fixtures are not personal preferences or account quota captures.
- **K05:** The unused legacy JPEG was removed rather than claiming source-owned rights to its vendor-provenance artwork or stripping metadata. The published Quarterdeck PWA PNG icons have an exact filename/content-digest allowlist for the unknown-binary finding; changed bytes and other binaries still require review. Retired artwork paths remain refused pending a new rights review. This source-tree removal does not sanitize old repository history: publication still uses only the verified history-free export.
- **K06:** The existing bearings fixture paths under `/srv/synthetic/` have an explicit file-and-complete-path allowlist for the absolute-home finding. A new file, different path or private path alongside an allowed fixture still fails. All credential, private-marker, original-blob and transfer-path checks continue to scan the original bytes, including reviewed icons and fixtures.

## Excluded, not migrated or deleted

- **T01:** Browser profiles/cookies/storage/cache/DevTools state.
- **T02:** Entire ignored labs, logs, ad hoc scripts, synthetic-home records, captures and nested checkouts.
- **T03:** Python bytecode/cache and expense lock.
- **T04:** All `.git` pointers/directories at every depth, old objects/refs/remotes/reflogs, dependency/build output, runtime receipts/registries/controller state, `.env` material and selected private homes.

A clean status or ignore rule does not make a raw directory copy safe. Do not inspect/decrypt browser databases to enrich public evidence. Exclusion requires no deletion of existing private/runtime material.

## Automated gates

`python3 scripts/check-product-boundary.py` scans tracked paths and first-party content case-insensitively for retired integration names and paths. Only the gate's own rule definitions/regression fixtures and dependency lockfile metadata are excluded from content checks; filenames are always checked. Whole-name matching permits innocent substrings in third-party metadata. Root Python tests exercise the policy and current tracked tree. The gate does not inspect private runtime data or ignored dependencies.

`python3 scripts/check-public-source.py --audit /explicit/private/report.md` reads the complete private audit's fingerprint tables at runtime and scans exact HEAD tracked blobs, including names, dotfiles and binary ASCII runs. It requires all ten blocked marker categories and all eight original private/evidence blobs, refuses renamed originals, detects copied private fingerprints, and applies public semantic gates for empty defaults, home/browser assumptions, historical document pins, credential shapes, unknown binaries and transfer paths. `--worktree` scans current bytes of indexed paths before a commit. Output contains only file ordinals/categories, never private values/hashes. Do not put the audit or fingerprints into source. Changed digests are necessary, not sufficient: the F01–F13 semantic review remains mandatory.

Synthetic scanner tests cover every marker category, mixed-case embedded/encoded/deceptive variants, binary/path matches, renamed originals, missing-table refusal and no blanket test exemption:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_public_source.py'
```

For authorized no-repository-creation validation, use a worktree-local ignored temporary directory; clear inherited `FM_HOME`/cost tag/preview/account bindings. Run prototype suites excluding `previews.test.js` and `preview-lifecycle.test.js` (their real Git fixtures), plus Python expense tests. Do not run root `test/fmqd-toolcheck.test.mjs` or the lifecycle lab under that restriction. Production HTTP tests require the clean committed candidate. `public-defaults.test.js` and `private-overlay.test.js` exercise empty/synthetic temporary homes, nested source/private namespace separation, no saved home pointer, private writes only in fixtures, permissions/confinement/refusal and injected offline attribution. `revision.test.js` mocks initial-commit/no-Git behavior without creating a repository.

Real selected-home preservation is separately explicit: first run the preservation-source committed `--verify` before replacing defaults. After sanitization, `--verify-preserved` reads only the expense bundle and compares it to its private initial manifest, not the now-empty source. It refuses intentional later edits without overwriting them. The Python helper's locking commands are not read-only verification.

`prototype/scripts/expense-acceptance-fixture.mjs` requires a clean exact revision and explicit authorized `FM_HOME`. It serves two task-isolated loopback surfaces for at most five minutes: empty public defaults and the real expense overlay. Only expense reads use that home; fleet/lanes, account reads, durability and review intake are synthetic/offline. It verifies ledger rollup parity and unchanged bytes/inode/permissions/mtime/ctime on exit. Use `chrome-devtools-axi` in one isolated **headless** session, with a profile/tool HOME under ignored task scratch, and evaluate `expense-browser-assertions.js` at desktop/phone sizes. Its results are booleans for revision, source, entries, totals, categories, projects and unavailable attribution. Do not capture DOM snapshots/screenshots/private text, use account APIs or touch shared UAT. Exact revision/evidence logs belong in the task-private handoff, not installation history in public docs.

## Authorized local transfer and acceptance tooling

[History-free export](HISTORY-FREE-EXPORT.md) specifies exact commands, supported prerequisites, independent allowlist review, deterministic tree-only USTAR, strict pre-extraction/directory verification, optional private audit input and a fully temporary first-commit runtime/full-suite fixture. It rejects unexpected paths/types/bytes and all extended archive provenance instead of relying on a clean status or raw copy. No public manifest contains private blocked-marker fingerprints.

Local export/test repository creation is not authority for a public repository, remote, push, deployment or account access. Final source approval, publication and operator binding regeneration remain separate gates.

## Preview policies

The source preview uses standard [MIT terms](../LICENSE) with Quarterdeck contributor attribution, not a claim that an upstream author owns Quarterdeck. [Governance](../GOVERNANCE.md) assigns initial maintenance/release ownership to the repository owner; [security](../SECURITY.md) requires private vulnerability reporting once the repository exists. The [contribution workflow](../CONTRIBUTING.md) opens in the designated public repository after its [maintainer setup](OPEN-SOURCE-CONTRIBUTIONS.md), while this development repository remains private. [Third-party notices](../THIRD-PARTY-NOTICES.md) preserve truthful Firstmate/Kunchenguid attribution without importing upstream workflow or CI claims.

## Explicit residual boundaries

- Actual cloud/account billing/quota freshness and exact private **live billing UI** parity cannot be proved offline. Offline checks prove ledger and configured attribution/unavailable presentation only; do not contact accounts to fill that gap.
- The temporary history-free fixture proves one-commit runtime behavior with real Git/health/process proof and synthetic data. It does not approve a real new release repository, actual operator bindings or browser paint; the interactive lifecycle lab remains a separate optional UI exercise.
- Taxonomy state still requires its explicit outside-home owner; receipts, browser drafts, skills and deployment/review bindings retain existing owners. Their later migration/rebinding is separate; no circular home pointer or silent state reset is introduced.
- Tool availability grants no authority for publication, push, deployment, signing, shared UAT changes or a general public service. Unknown secret encodings and legal/branding/dependency audits are outside the known-disclosure gate.
