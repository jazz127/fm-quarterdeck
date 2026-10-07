# Optional legacy branch inventory

`node docs/dev-branch-inventory.mjs` is a read-only local migration aid for an existing repository with `fm/*` branches. It maps recognized legacy source names to proposed `dev/*` names and refuses collisions or unmapped sources. It does not publish, create refs, verify clean worktrees, or establish running/deployment evidence.

Run it only when authorized to inspect that repository's legacy refs. Keep its output private: names and commit IDs may contain operational history. A fresh history-free repository has no old branches to inventory, and must not import them or their objects to satisfy this tool.

Record exact reviewed source/target identities and disposition privately before promotion; follow the [branch/preview contract](branching-and-preview-model.md). No installation-specific mapping or old commit pin is part of this document.
