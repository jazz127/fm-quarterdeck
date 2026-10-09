# Quarterdeck-specific Firstmate integrations

A skill in source is not activated in a Firstmate home. These integrations are optional and Quarterdeck-owned; they do not vendor generic external skills or modify upstream Firstmate. [First-run pairing](FIRST-RUN.md) explicitly selects `FM_HOME` and previews/confirms a versioned owned preference block, never global projections or service startup.

| Integration | Contract | Canonical source |
| --- | --- | --- |
| fm-lanes | Captain-facing project/theme/General display envelopes; not authority, destination or work ownership | `skills/fm-lanes/SKILL.md` |
| fm-toolcheck | Read-only scoped audit of public Kunchenguid-owned tools declared by installed bootstrap; no installs/upgrades | `skills/fm-toolcheck/`, [TOOLCHECK.md](TOOLCHECK.md) |
| fm-quartermaster | Explicit advisory outsider review of loops, regressions, architecture and waste; bounded investigations need existing authority, workers gain no delegation authority | `skills/fm-quartermaster/SKILL.md` |
| fm-quarterdeck-health | Explicit custom-watcher registration; bounded dashboard/Serve/Bearings and overdue-inbox checks during setup and `/afk`, safe captain-note handling with reply+ack, ownership-safe recovery | `skills/fm-quarterdeck-health/SKILL.md`, `scripts/quarterdeck-health-check.sh` |
| Captain ask Stop hook | Code-enforced structured task markers against selected-home open captain holds; bounded diagnostic fail-open, no model or stock Firstmate edits | `scripts/captain-ask-stop-hook.mjs`, `scripts/captain-ask-hook-install.mjs` |
| Mechanical helpers | Opt-in lane syntax check, receipt-proven note reply+ack, owned standalone restart after landing; no automatic installation or shared takeover | `scripts/check-lane-envelopes.mjs`, `scripts/quarterdeck-note-close.mjs`, `scripts/quarterdeck-watch.mjs` |
| Tier-aware delivery | Future Firstmate integration must independently implement/validate the [branch contract](branching-and-preview-model.md) | Not implied by UI labels |
| Durable session/source authority | Future integration needs durable primary/worker/relayed/read-only evidence | Never inferred from display names or lane tags |

## Operating rules and private preferences

The reusable [Quarterdeck operating rules](../FIRSTMATE.md) are the policy entry
point for a paired supervising Firstmate. After reviewing an approved stable
checkout, the operator may replace duplicated Quarterdeck prose in private
preferences with `Quarterdeck operating rules: read <approved Quarterdeck checkout>/FIRSTMATE.md`.
Keep private installation details, active posture and exact standing approvals in
a private local override. The reference is an instruction to read, not an
installer, recursive Preferences UI include or permission to change Firstmate.
Existing onboarding-owned blocks still require their guarded versioned workflow;
this documentation does not migrate them or activate any integration.

## Manual activation and rollback

Pin a clean stable approved source revision, never a disposable task worktree. Independently review each skill, discovery policy and target. Before replacing any existing installation, retain a verified private rollback copy, inspect type/bytes/target and compare at the moment of the authorized change. Unexpected entries, changed bytes or symlinks refuse blind replacement.

`skills/fm-lanes/verify-legacy.mjs` is a read-only preflight against a caller-supplied baseline hash. It refuses changed bytes, unexpected entries and symlinks, performs no writes, and does not approve activation. Public example neutralization may intentionally differ from an installed copy: review that exact diff and obtain approval rather than bypassing the preflight or asserting byte equivalence.

Only after separate authorization may the operator project one verified symlink from the chosen discovery location to the pinned canonical skill directory. Record the exact revision and target privately. Repinning requires renewed review; rollback restores the verified retained copy/target. Removal deletes only the verified projection, not canonical content. Repository documentation never authorizes removing a standalone installation.

Use the independent [toolcheck procedure](TOOLCHECK.md) for its scope proof and optional network lookup. Quartermaster discovery does not enable a scheduler, runtime hook or automatic invocation. Onboarding affects only its recognized preference block; ordinary skill execution and the Preferences HTTP view do not seed preferences or change projections. Health skill activation likewise needs explicit approval: its setup registers a Firstmate custom check, not a new daemon, and persists private configuration in the selected home's state directory. The check validates the `/api/bearings` contract in `prototype/BEARINGS.md` (idle loading is healthy; ready snapshots must be fresh) and reports overdue captain inbox notes requiring reply+ack. A missing or incompatible producer is a failure, not evidence of full dashboard health. The supervising Firstmate reads and safely acts on open notes at every health check-in; the checker itself never executes or acknowledges orders.

## Captain ask Stop hook

This is executable enforcement, not a skill/instruction projection. Follow the approval/pinning/rollback discipline above: use an independently reviewed **clean approved stable checkout** (not a task worktree), retain a verified private backup of the selected home's `.claude/settings.local.json` if present, and record its bytes, source target/revision and Node executable. Use maintained Node 24 LTS. The installer validates the exact clean 40-hex HEAD and preserves unrelated settings/hooks; a different existing ask-hook command refuses replacement. Do not repin the checkout in place while its hook is installed. Uninstall using the original pin and Node executable before installing a new pin. Source presence never activates this hook.

After separate authorization, run with explicit paths:

```bash
FM_HOME=/absolute/selected/firstmate
PIN=/absolute/approved/pinned/fm-quarterdeck
REV=<approved-40-hex-commit>
NODE=/absolute/path/to/node
# Optional fourth installer argument: absolute CLAUDE_CONFIG_DIR when nondefault.
"$NODE" "$PIN/scripts/captain-ask-hook-install.mjs" install "$FM_HOME" "$REV"
# Rollback/removal: exact same pin, revision, Node and optional config-dir argument.
"$NODE" "$PIN/scripts/captain-ask-hook-install.mjs" uninstall "$FM_HOME" "$REV"
```

Installation changes only `$FM_HOME/.claude/settings.local.json`, adding one `hooks.Stop` command with explicit `FM_HOME`, the pinned script and Node paths, and an 8 s outer timeout. Its own deadline is 5 s. No Firstmate source/bin/AGENTS/learnings file is modified, no service is started, and no hook is installed by Quarterdeck startup. Restart/resume the intended primary Claude Code session as needed for its settings reload, then verify a synthetic unmarked ask is blocked and a marked open hold passes. Pi sessions have mechanical linking/closure but no Claude Stop enforcement.

The hook checks only `state/.lock-session`'s primary session with exact home `cwd` and the confined hook-supplied transcript path. It reads the final assistant message (not the hook's advisory `last_assistant_message`), ignores tool/user/sidechain/meta text and fenced examples, and requires an existing unchecked `(hold-kind: captain)` task for each ask line's `[task:<id>]`. Blocking feedback tells Firstmate to file via `bin/fm-captain-hold.sh` and add the marker. There is no allowlist. Corrective `stop_hook_active` retries are skipped with a diagnostic (one block per turn, never an endless loop). Unreadable/malformed/missing/oversized records fail open with a `quarterdeck-ask-stop: fail-open: …` stderr diagnostic; unrelated session ids skip. Limits: 64 KiB hook input, newest 4 MiB transcript tail and 2 MiB backlog. A marker outside its ask line does not satisfy enforcement. This hook does not infer whether a free-form captain reply answered a decision: Firstmate still records that answer, and Quarterdeck closes linked chat asks from those records with explicit source provenance.

Removal verifies the exact installed entry and removes only it, preserving other settings/hooks. Changed entries/settings, symlinks, or unexpected target types refuse blind replacement; inspect and use the retained verified rollback copy deliberately, never overwrite unrelated changes. Hook code is read-only against the home; only the explicitly invoked installer writes settings.

## Mechanical helpers

The [instruction-to-code inventory](INSTRUCTION-TO-CODE.md) separates executable rules from producer conventions and authority. These helpers need maintained Node 24 LTS and explicit operator activation. They do not modify Firstmate source/bin/AGENTS, project skills, register watchers, install hooks or publish anything. Use an approved clean checkout; do not execute an unreviewed candidate. No live activation is implied by their tests.

### Lane syntax preflight

From the approved pinned source, before sending a **complete** captain-facing reply:

```bash
"$NODE" "$PIN/scripts/check-lane-envelopes.mjs" < /absolute/private/message.txt
```

Exit 0 means all nonblank text is inside flat matching nonempty envelopes; exit 1 gives only line numbers/error codes; exit 2 is input/usage failure. Input is capped at 1 MiB. Names use a conservative ASCII single-token grammar (up to 160 characters), not a registry lookup; fenced examples inside a real block are data. It does not rewrite output, choose topics, enforce a semantic hyphen depth or change historical fallback routing. A harness pre-send adapter can use the exit status once separately integrated; merely telling an agent to run it is not universal enforcement. Removal is to stop invoking the check; there is no installed file to restore.

### Reply and acknowledge an already handled note

Read the complete note and context first. Act/verify within existing authority, or record a durable tracked hold and explain it in the reply before closing intake. Prepare the exact reply as UTF-8 (nonempty, no NUL, at most 32 KiB). Serialize with a stable, inspected, operator-owned private lock file outside `FM_HOME`, and exclude other manual writers for the same note:

```bash
# Explicit selected home; PIN/NODE from the approved immutable checkout.
export FM_HOME=/absolute/selected/firstmate
NOTE_LOCK=/absolute/private/quarterdeck-note-close.lock
flock -n "$NOTE_LOCK" "$NODE" "$PIN/scripts/quarterdeck-note-close.mjs" <note-id> < /absolute/private/reply.txt
```

The helper invokes only `bin/fm-inbox.sh receipts --all-pending --all-handled --all-replies`, `reply <id> <text>` and `drain --ack <id>`. Each invocation has a ten-second deadline and bounded output. It proves an exact recorded reply before acknowledging, then requires the note to be handled and replied in fresh complete receipts. Unknown/duplicate notes, omitted receipt coverage, incompatible schemas, conflicting reply bytes and already-acknowledged notes with no reply refuse. A reported command success without receipt evidence is not success. Same-note/same-text retries skip an existing reply and only repair ack; do **not** repeat the original order because closure was unconfirmed. The command never executes the order, edits a backlog, infers a valid deferral or treats acknowledgement as completed work. Errors on the CLI are sanitized; inspect the guarded receipt interface privately for details. Keep the reply unchanged for retry, including its trailing newline.

No hook/settings installation is required. Stop invoking it to roll back tooling; a delivered reply/ack is not undone by removing a helper. The existing manual reply-then-ack procedure remains available if the helper is unavailable, with the same ordering and verification duties. The health checker remains read-only and does not call this helper itself.

### Standalone foreground restart after landing

After separately approving a launch **and** standing maintenance authority for reviewed clean fast-forwards on one named branch:

```bash
# Use a stable approved standalone service checkout, NOT an immutable installed
# hook/skill pin, registered preview, disposable task worktree or shared service.
WATCH_ROOT=/absolute/approved/standalone/fm-quarterdeck
REV=<approved-starting-40-hex-commit>
FM_HOME=/absolute/selected/firstmate \
FM_QUARTERDECK_STATE_PATH=/absolute/private/existing/agent-state.json \
PORT=<free-loopback-port> \
"$NODE" "$WATCH_ROOT/scripts/quarterdeck-watch.mjs" main "$REV"
```

Preserve all intended private launch settings (exact review origin, receipt/status owners, account context, etc.) in this operator-owned launch environment. The branch name is explicit; the example selects `main` but conveys no merge/publication approval. Do not advance it to unreviewed code. No launcher Git mutations occur. Initial branch/clean SHA must match; subsequent clean fast-forwards restart only the IPC child on the **same port**, after the previous child exits and the checkout is re-proved. Dirty/unprovable content is not restarted; normal server request identity guards continue to return unavailable. Branch switches, divergence, probe/start failure or child crash stop the launcher instead of spinning a recovery loop. New modules run in a new child rather than pretending an old process adopted a new revision.

The launcher refuses public binding, development-watch mode and preview registry/root configuration. An occupied port fails without killing or adopting its owner. Ctrl-C/SIGTERM closes only the owned child, with a bounded five-second graceful deadline then exact-child SIGKILL; IPC disconnect also closes the child if the parent dies. There is no persistent daemon, PID-file adoption or shared service/unit mutation. Rollback is explicit stop, operator-reviewed checkout restoration and a new approved launch; no source reset is automated.

It **never** configures/repoints/removes Tailscale Serve. It cannot replace the existing Tailscale launcher, registered preview controller or an independently launched dashboard. Arrange an authorized window and use the current owner's exact stop procedure first. A separately owned stable private proxy may keep pointing at this loopback port; maintenance authority for that proxy remains external. After every landing verify `/api/health`, `/api/review.version` and healthy Bearings plus the exact private URL where configured (force the health check); listener startup text is not health/remote proof. Registry rebinding and fresh-port shared-service recovery remain explicit operations. Do not repin installed immutable hooks/skills in place by watching their checkout.

## Checks

`node --test test/*.test.mjs` covers executable interfaces (some cases create synthetic Git repositories). `git diff --check`, skill frontmatter, relative links and authority-boundary review apply to instruction changes. Static checks do not establish installed discovery or checkpoint outcomes. Legacy migration procedures are [branch inventory](dev-branch-inventory.md) and [parked work](parked-work.md), not records of any current installation.
