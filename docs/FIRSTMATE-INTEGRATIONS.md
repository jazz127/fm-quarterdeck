# Quarterdeck-specific Firstmate integrations

A skill in source is not activated in a Firstmate home. These integrations are optional and Quarterdeck-owned; they do not vendor generic external skills or modify upstream Firstmate. [First-run pairing](FIRST-RUN.md) explicitly selects `FM_HOME` and previews/confirms a versioned owned preference block, never global projections or service startup.

| Integration | Contract | Canonical source |
| --- | --- | --- |
| fm-lanes | Captain-facing project/theme/General display envelopes; not authority, destination or work ownership | `skills/fm-lanes/SKILL.md` |
| fm-toolcheck | Read-only scoped audit of public Kunchenguid-owned tools declared by installed bootstrap; no installs/upgrades | `skills/fm-toolcheck/`, [TOOLCHECK.md](TOOLCHECK.md) |
| fm-quartermaster | Explicit advisory outsider review of loops, regressions, architecture and waste; bounded investigations need existing authority, workers gain no delegation authority | `skills/fm-quartermaster/SKILL.md` |
| Tier-aware delivery | Future Firstmate integration must independently implement/validate the [branch contract](branching-and-preview-model.md) | Not implied by UI labels |
| Durable session/source authority | Future integration needs durable primary/worker/relayed/read-only evidence | Never inferred from display names or lane tags |

## Manual activation and rollback

Pin a clean stable approved source revision, never a disposable task worktree. Independently review each skill, discovery policy and target. Before replacing any existing installation, retain a verified private rollback copy, inspect type/bytes/target and compare at the moment of the authorized change. Unexpected entries, changed bytes or symlinks refuse blind replacement.

`skills/fm-lanes/verify-legacy.mjs` is a read-only preflight against a caller-supplied baseline hash. It refuses changed bytes, unexpected entries and symlinks, performs no writes, and does not approve activation. Public example neutralization may intentionally differ from an installed copy: review that exact diff and obtain approval rather than bypassing the preflight or asserting byte equivalence.

Only after separate authorization may the operator project one verified symlink from the chosen discovery location to the pinned canonical skill directory. Record the exact revision and target privately. Repinning requires renewed review; rollback restores the verified retained copy/target. Removal deletes only the verified projection, not canonical content. Repository documentation never authorizes removing a standalone installation.

Use the independent [toolcheck procedure](TOOLCHECK.md) for its scope proof and optional network lookup. Quartermaster discovery does not enable a scheduler, runtime hook or automatic invocation. Onboarding affects only its recognized preference block; ordinary skill execution and the Preferences HTTP view do not seed preferences or change projections.

## Checks

`node --test test/*.test.mjs` covers executable interfaces (some cases create synthetic Git repositories). `git diff --check`, skill frontmatter, relative links and authority-boundary review apply to instruction changes. Static checks do not establish installed discovery or checkpoint outcomes. Legacy migration procedures are [branch inventory](dev-branch-inventory.md) and [parked work](parked-work.md), not records of any current installation.
