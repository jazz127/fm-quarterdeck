# Project agent memory

This repository is the live Firstmate Quarterdeck product home; start with `README.md` for scope and checks.

- Keep live Quarterdeck product work here.
- Any Firstmate-side preference, hook, check, skill or setting added for Quarterdeck must be installed by `scripts/firstmate-integration.mjs`, carry the literal `fm-quarterdeck` tag (directly or in its ownership manifest), and be covered by uninstall, inventory and `fm-toolcheck`. Do not hand-edit Firstmate for Quarterdeck.
- `prototype/` is the runnable custom frontend; its checks are documented in `README.md`.
- `expenses/README.md` documents the expense ledger and helper commands.
- `docs/README.md` indexes the Quarterdeck architecture and v2 phased feature plans.
- `docs/QUARTERDECK-RENAME.md` owns naming and legacy wire/storage compatibility; do not rename persisted namespaces as cosmetic cleanup.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
