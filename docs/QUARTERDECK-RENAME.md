# Firstmate Quarterdeck naming and compatibility

The product is **Firstmate Quarterdeck**, repository/package name **`fm-quarterdeck`**, and UI short name **Quarterdeck**. New source installations use `FM_HOME/projects/fm-quarterdeck`; the runnable application stays in `prototype/`. Launch scripts resolve their own checkout rather than depend on its folder name.

This is a source change, not an installed-home migration or repository publication. The private repository, Git remote, local checkout folder and running services are not renamed by it. A future repository/folder move needs deliberate owner action. Follow [private ownership](PRIVATE-RUNTIME.md) and [branch identities](branching-and-preview-model.md) before changing an installed checkout or regenerating launch bindings. Restart after changing the serving commit; existing processes fail closed rather than claim the new build.

## Interfaces retained deliberately

Historical identifiers below are compatibility contracts, not stale product branding. Renaming them would hide stored data, break consumers or change delivery identity.

| Contract | Quarterdeck behavior |
| --- | --- |
| `FM_QUARTERDECK_STATE_PATH` | Canonical explicit taxonomy/acknowledgement owner. Legacy `FM_AGENTOS_STATE_PATH` is accepted; two different nonempty values fail startup. Keep the existing absolute outside-home path. Managed previews receive that same owner rather than start an empty private state file. |
| `FM_HOME/data/agentos` | Existing guarded expense bundle remains here. No `data/quarterdeck` fallback or automatic move is introduced. |
| `prototype/data/agent-state.json`, `prototype/data/review-receipts` | Existing default state/receipt locations are retained. Keep the same receipt-store owner accessible across revisions and folder moves; do not replay receipts or infer delivery failure from a new empty checkout. |
| `fm-agentos-*.v1` payload schemas | Review/chat/view, taxonomy state, cost configuration, private-copy manifests, receipt status/acknowledgements and source allowlists keep their existing versioned schemas. Rebranding does not change payloads or receipt reconciliation. |
| `agentos-review:<batchId>` and `agentos-review` notification type | Firstmate inbox deduplication IDs and optional supervisor notifications remain compatible. Existing deliveries must not acquire new IDs. |
| Browser `fm-agentos-*` keys | Drafts, pending batches, receipts, message filters/format/font size, hierarchy and panel dimensions remain in their existing storage keys. Same-origin, same-tab reload preserves them; moving to another origin/tab is not a storage migration. |
| `fm-agentos-preferences` markers and `.agentos-preferences.lock` | Onboarding keeps its ownership/locking namespace. Quarterdeck's current template is v2; the exact shipped v1 bytes remain in `prototype/onboarding-legacy.js`. Only the explicit confirmed onboarding command upgrades an intact v1 block, preserving all surrounding user bytes. Edited, duplicate or unknown blocks still refuse changes. |
| `.agentos-controller`, `.agentos-runtime` | Existing preview process-ownership records and helper state remain in their guarded namespaces. No new controller may ignore an old lock or quarantine merely because the product name changed. |
| Historical lane labels | New `fm-quarterdeck`, `Quarterdeck` and `Firstmate Quarterdeck` envelopes and prior product-name envelopes can map to one registered product lane. Durable transcripts and project records are not rewritten. Multiple matching registered lanes remain ambiguous; no destination is guessed. |
| Legacy `fm/*` branch inventory | The read-only migration helper intentionally recognizes historical prefixes. It does not rename or import private branches. |

`/api/health` now identifies service **`fm-quarterdeck`**. Repository-owned preview probes and the optional Tailscale launcher require this identity together with the exact serving revision. Old-build children therefore need deliberate restart/update before being considered healthy; this source change does not perform that operation. External health consumers should update their expected service name at the same separately authorized rollout.

## Verification and rollout

Use the [offline source-preview gate](SOURCE-PREVIEW-VALIDATION.md), rename regressions, and [history-free acceptance](HISTORY-FREE-EXPORT.md). These cover the new UI/service identity, exact v1 preference upgrade/removal, old/new state-variable selection, selected-owner inheritance and old/new lane routing. Existing reload/retry tests continue to use the historical storage and receipt schemas.

Before a real rollout, preserve state and receipt owners, verify any external probes and operator-owned bindings, and confirm the new source path deliberately. Optional Firstmate services, skill projections, private proxies and account integrations need their own environment verification. Source-preview acceptance does not establish production readiness or authorize public multi-user hosting.
