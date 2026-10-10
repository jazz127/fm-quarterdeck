# Quarterdeck-specific Firstmate integrations

A skill in source is not activated in a Firstmate home. These integrations are optional and Quarterdeck-owned; they do not vendor generic external skills or modify tracked upstream Firstmate files. [First-run pairing](FIRST-RUN.md) explicitly selects `FM_HOME` and previews/confirms a versioned owned preference block, never global projections or service startup.

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

## Unified mechanical installation

After operator approval, use **one** transaction from a clean reviewed revision:

```bash
PIN=/absolute/approved/fm-quarterdeck
FM_HOME=/absolute/initialized/firstmate
REV=<approved-40-hex-commit>
node "$PIN/scripts/firstmate-integration.mjs" install "$FM_HOME" "$REV" /absolute/private/health-config.json
node "$PIN/scripts/firstmate-integration.mjs" status "$FM_HOME"
node "$PIN/scripts/firstmate-integration.mjs" verify "$FM_HOME"
node "$PIN/scripts/firstmate-integration.mjs" inventory "$FM_HOME"
node "$PIN/scripts/firstmate-integration.mjs" uninstall "$FM_HOME"
```

Use maintained Node 24 LTS and the same Node executable for install retries. The
revision defaults to clean HEAD for install; the optional fourth argument is a
private JSON object (at most 64 KiB), **not** markdown or an executable shell file.
The selected home must already have real `data/`, `state/` and Firstmate's
`bin/fm-check-register.sh` / `fm-check-unregister.sh`. No bootstrap, package
installation, Git mutation, daemon, dashboard restart or proxy mutation occurs.

Installation captures integration source/dependencies/docs from that exact Git
tree into a private, hash-verified, versioned **integration-only** snapshot at
`FM_HOME/data/quarterdeck-integration/pins/<revision>`. Shared record readers are
included; UI assets, prototype fixtures/tests and browser tooling are omitted.
This is not a runnable dashboard deployment. No installed command points
at a mutable checkout. Changing the original checkout does not repin this snapshot.
Do not edit the snapshot. The single owned journal is
`state/quarterdeck-integration.json`, with a transaction lock alongside it.
Both records carry the literal `fm-quarterdeck` tag. Each pin has a
`fm-quarterdeck.json` ownership record identifying all its hash-verified files.

Installed artifacts:

- One `.claude/settings.local.json` Stop entry tagged by a `# fm-quarterdeck`
  command comment, combining open-captain-hold ask
  markers with **complete lane syntax enforcement**. It uses explicit home/Node
  paths, the pinned script and optional `CLAUDE_CONFIG_DIR`. The original ask-only
  installer remains compatible; it is not the unified installation owner.
- Four home-local `.agents/skills/` links, each explicitly tagged in the ownership
  manifest (skill discovery names stay compatible). Claude's stock `../.agents/skills`
  alias is preserved; an absent discovery path gets that alias, while an existing
  real `.claude/skills/` directory gets four links. Other aliases are refused.
  No user-global skill directory or other home is inspected or changed. Pi's
  normal `.agents/skills` discovery remains applicable, but Pi has **no Stop
  enforcement**; skill discovery is not universal harness enforcement.
- `state/fm-quarterdeck-health.check.sh`, registered as `fm-quarterdeck-health`,
  a mode-0700 tagged wrapper executing the pinned
  checker with explicit home/state, registered through **Firstmate's public
  check interface**. Its mode-0600 trust record must match the installed
  `fm-custom-check-v1` SHA-256 contract; incompatible registration refuses.
- Mode-0600 `state/quarterdeck-health.json`, persisting private health settings
  with `integrationTag: "fm-quarterdeck"`. Its existing config namespace stays
  compatible. Mutable health lock/stamp bookkeeping uses explicitly tagged
  `state/fm-quarterdeck-health.lock` / `.stamp`; uninstall removes these safely.
- One soft-reference block with `<!-- fm-quarterdeck:integration:v1 -->` and
  `<!-- /fm-quarterdeck:integration:v1 -->` markers appended to `data/captain.md`,
  pointing at the snapshot's `FIRSTMATE.md`. Existing user text and any recognized
  onboarding-owned block are left untouched. No `data/learnings.md`, Firstmate
  `AGENTS.md`, tracked settings, `bin/` or extension source is edited.

The config permits string values for `CLAUDE_CONFIG_DIR`,
`FM_QUARTERDECK_STATE_PATH` (or the retained `FM_AGENTOS_STATE_PATH`),
`FM_QUARTERDECK_HEALTH_PORT`, `FM_QUARTERDECK_HEALTH_URL`, `TAILSCALE_BIN`,
`FM_QUARTERDECK_HEALTH_MAX_AGE`, and optional matching `FM_HOME`. Paths must be
absolute; port/age are bounded and the remote origin must be HTTPS without
credentials/path/query. Always record the **actual server state owner** so the
checker reads the same saved preferences. The installed explicit home wins;
other checker environment overrides retain their documented behavior. Without a
private config, unique Tailscale route discovery and default health preferences
apply; that is not proof of the intended state owner or device access. The check
config is not a dashboard launch environment: preserve all launch/receipt owners
separately under the authorized launcher's existing contract.

`status` and `verify` never write or run health probes. They verify the pin's
files/hashes/modes, exact skill links, hook, reference, config and check trust.
`status` on an absent installation succeeds with `installed:false`; `verify`
requires an installation. Drift/incomplete transactions exit nonzero. They do
not prove harness reload/discovery, a live watcher, dashboard freshness, private
network access or upstream receiver semantics. After activation, reload the
intended primary harness, force the health check and verify those live boundaries
separately. Synthetic Stop tests establish syntax, not real harness activation.

`inventory` is read-only and lists each known `fm-quarterdeck` artifact with
kind, presence and tag: shared-file blocks, manifest-tagged skill/discovery links,
check/trust, config, transaction/runtime state and every retained tagged pin file.
It inspects only the integration's home-local ownership surfaces, not arbitrary
private transcripts or another home's/global discovery namespace. It does not
delete anything; retained cache entries are explicitly marked `retained:true`.
`fm-toolcheck` calls status/verify, compares the installed pin to the selected
checkout's local main, and prints an exact review-only reinstall command; it never
runs installation. See [TOOLCHECK.md](TOOLCHECK.md).

### Retry, removal and legacy migration

Identical completed install/uninstall calls are no-ops; unrelated subsequent
settings/preferences edits are allowed and preserved on removal. Untouched files
are restored byte-for-byte (or removed if originally absent). Changed owned
links/config/checks/reference/hook refuse blind removal before any projection is
removed. Uninstall calls only `fm-check-unregister.sh fm-quarterdeck-health` (or
`quarterdeck-health` for an older untagged journal), never other checks. It retains an **inert private pin cache**; removal does not undo
orders, receipts, replies, state or user preferences, and does not stop services.

Exclude other manual/settings/check writers during installation or removal;
the private lock serializes this installer, not unrelated tools. A write-ahead
journal records every original/installed artifact. Interrupted
installation can be retried from the same revision/Node, or uninstalled; an
interrupted removal can be retried. Registration failure leaves an explicitly
incomplete transaction, not a false success. Do not remove a lock blindly after
interruption: prove its owner is gone first. Unrecognized/conflicting destinations
refuse adoption even if they look similar. A new pin requires uninstall, then
install; the operator owns that deliberate two-step update window.

A previous **unified but untagged** v1 journal is backward-compatible with
uninstall, including its original exact hook/block, skill links and check id.
Status/verify flag it `legacy-untagged-install:reinstall-required`; install refuses
to silently upgrade it. After approval, preserve private config, uninstall and
install from current reviewed main. Unjournaled home-local legacy artifacts are
reported but not adopted or removed without their original owner. Existing
preference/config namespaces and skill discovery names are not cosmetically
renamed; tags live in contents or the explicit ownership manifest. Only the
registered check id and ephemeral runtime lock/stamp names deliberately change
for this tagging rollout (an old throttle stamp is not migrated).

The audited legacy installation has a separately owned ask hook, copied health
check/trust, global skill links from two historical pins, an unmarked operating
reference and private launch prose. **It cannot be silently adopted.** Firstmate
must separately preserve/verify those exact bytes/targets and remove only the
approved old hook/check/projections/reference using their original owners (and
any separately authorized reference edit). Leave unrelated preferences and
onboarding blocks intact; user-global projections require their own authority.
Then run this installer. This task did not modify that home or perform migration.

### Read-only integration audit (2026-10-09)

All private installation identifiers are deliberately omitted. The audit read
local settings, registered `state/*.check.sh`, skill links, private preferences /
learnings, selected dashboard process environment and
`git diff origin/main...main` in the paired home. Only the health check among the
registered custom scripts was Quarterdeck-specific.

| Touchpoint observed | Mechanical or prose; canonical source | Previous installation / new owner |
| --- | --- | --- |
| Captain ask Stop hook | Code; Quarterdeck `scripts/captain-ask-stop-hook.mjs` | Settings command targeted a mutable checkout despite a recorded pin; unified snapshot entry replaces it after explicit removal. |
| Health check + trust | Code, but live copied script differs from canonical checker; Quarterdeck `scripts/quarterdeck-health-check.sh` | Individually copied/registered, with installation-specific defaults and looser Bearings checks; unified wrapper + exact trust registration + private JSON. No weakening to match legacy code. |
| Four pinned skills | Prose workflows with executable toolcheck helpers; Quarterdeck `skills/` | User-global links pointed to two historical private snapshots; new links stay inside the selected home, all at one verified revision. |
| `data/captain.md` Quarterdeck section | Mixed: lane/ask/health mechanics exist in repo; authority, note intent, topic selection and review judgment remain prose in `FIRSTMATE.md` | Unmarked soft reference and duplicated operating rules; new installer owns only its delimited reference, never private standing approvals. Legacy prose retirement needs separate review. |
| `data/learnings.md` integration notes | Prose describing restart/env, local-base requirement, publication lifecycle and historical hook/card behavior | No installed code owner; procedures now point to repo helpers/docs. Historical incident evidence and private launch bindings stay private, not copied into public source or auto-deleted. |
| `FIRSTMATE.md` soft reference | Deliberately prose policy; repo-owned | Manual mutable source path becomes a versioned mechanically installed reference. Reading is not execution or authority. |
| Dashboard/Tailscale restart after landing | Partial code; `quarterdeck-watch.mjs`, existing Tailscale launcher and revision guards | Legacy fresh-port/repoint procedure remains operator-owned. New standalone watcher automates only its own child; installer never adopts a live process or shared route. |
| Launch environment / saved health preferences | Mechanical values; validation/readers live in Quarterdeck | Live launch supplied explicit home, port, state owner, exact review origin and a development flag. Preserve private state/receipt ownership; do not copy obsolete flags or secrets. Installer persists only health config; runtime env contract is in `README.md`. |
| Stock inbox continuity changes | Generic code in Firstmate, originally prompted by dashboard intake | Local diffs touch session-start, supervision-need/watch/successor handling and wake-drain (plus generic tests/docs). Quarterdeck consumes public inbox/check contracts; installer does not patch or undo them. Upstream convergence is separate Firstmate work. |
| Other local Firstmate differences | Generic code/policy, not Quarterdeck runtime customization | Pi primary-ownership fix, contribution-snapshot transport fix, bounded worker escalation and recorded authority/privacy/app-identity policy remain Firstmate-owned. None are installed or vendored here. |

**Residual upstream footprint:** there were no literal Quarterdeck-specific
runtime adapters in stock `bin/` or Pi extensions in the inspected diff, but
inbox continuity and re-presentation fixes are still local stock changes that
this home relies on for prompt idle delivery. A Quarterdeck installer cannot
remove them safely or emulate primary-session wake ownership with a parallel
scheduler. Converge those generic fixes upstream through Firstmate's own tests;
until then, report the local dependency rather than claiming zero merge risk.

**Genuinely prose:** interpreting a free-form answer/order; selecting a meaningful
lane or review checkpoint; deciding execution, deferral and actual completion;
private standing authority, away return policy, release/device access acceptance;
legacy process/route takeover and migration approvals. These are semantic or
authority-bearing decisions, not preferences a safe installer can turn into a
privileged interpreter. Their reusable source is `FIRSTMATE.md` / repo skills;
private approvals/bindings stay private. Lane syntax is now code-enforced in the
scoped Claude hook, note reply-before-ack is executable, health intervals and
alarms are JSON-backed, and owned standalone restarts have a code path. Other
harness pre-send/structured-intake seams still require upstream contracts; no
markdown claim substitutes for mechanical coverage.

## Operating rules and private preferences

The reusable [Quarterdeck operating rules](../FIRSTMATE.md) are the policy entry
point for a paired supervising Firstmate. After reviewing an approved stable
revision, use the integration installer to add its tagged, reversible policy
reference; do not hand-edit Firstmate preferences or project skills.
Keep private installation details, active posture and exact standing approvals in
a private local override. The reference is an instruction to read, not an
installer, recursive Preferences UI include or permission to change Firstmate.
Existing onboarding-owned blocks still require their guarded versioned workflow;
this documentation does not migrate them or activate any integration.

## Legacy individual activation and rollback

Use only the unified installer above for new installations. The individual
procedures below document separately owned legacy installations for original-owner
rollback, not approval to create new hand-edited preferences or projections.
Never mix their ownership with the unified journal or use them to remove unified
artifacts. Any new Quarterdeck Firstmate-side artifact must carry `fm-quarterdeck`
and be owned by the installer, uninstall, inventory and fm-toolcheck.

Pin a clean stable approved source revision, never a disposable task worktree. Independently review each skill, discovery policy and target. Before replacing any existing installation, retain a verified private rollback copy, inspect type/bytes/target and compare at the moment of the authorized change. Unexpected entries, changed bytes or symlinks refuse blind replacement.

`skills/fm-lanes/verify-legacy.mjs` is a read-only preflight against a caller-supplied baseline hash. It refuses changed bytes, unexpected entries and symlinks, performs no writes, and does not approve activation. Public example neutralization may intentionally differ from an installed copy: review that exact diff and obtain approval rather than bypassing the preflight or asserting byte equivalence.

For an existing separately owned projection, record the exact revision and target privately. After separate authorization, rollback restores the verified retained copy/target, and removal deletes only the verified projection, not canonical content. New installation and repinning use the unified installer and its migration contract above. Repository documentation never authorizes removing a standalone installation.

Use the independent [toolcheck procedure](TOOLCHECK.md) for its scope proof and optional network lookup. Quartermaster discovery does not enable a scheduler, runtime hook or automatic invocation. Onboarding affects only its recognized preference block; ordinary skill execution and the Preferences HTTP view do not seed preferences or change projections. Health skill activation likewise needs explicit approval: its setup registers a Firstmate custom check, not a new daemon, and persists private configuration in the selected home's state directory. The check validates the `/api/bearings` contract in `prototype/BEARINGS.md` (idle loading is healthy; ready snapshots must be fresh) and reports overdue captain inbox notes requiring reply+ack. A missing or incompatible producer is a failure, not evidence of full dashboard health. The supervising Firstmate reads and safely acts on open notes at every health check-in; the checker itself never executes or acknowledges orders.

## Captain ask Stop hook

This is executable enforcement, not a skill/instruction projection. New activation uses the [unified installer](#unified-mechanical-installation). For a separately installed legacy hook, retain a verified private backup of the selected home's `.claude/settings.local.json` and record its bytes, source target/revision and Node executable. Use maintained Node 24 LTS. Do not repin the checkout in place while its hook is installed. Uninstall using the original pin and Node executable before migrating; the original installer validates the exact clean 40-hex HEAD and preserves unrelated settings/hooks. A changed ask-hook command refuses removal. Source presence never activates this hook.

After separate removal authorization, use the legacy installation's explicit paths:

```bash
FM_HOME=/absolute/selected/firstmate
PIN=/absolute/approved/pinned/fm-quarterdeck
REV=<approved-40-hex-commit>
NODE=/absolute/path/to/node
# Rollback/removal: exact same pin, revision, Node and optional config-dir argument.
# Optional fourth argument: the original absolute CLAUDE_CONFIG_DIR when nondefault.
"$NODE" "$PIN/scripts/captain-ask-hook-install.mjs" uninstall "$FM_HOME" "$REV"
```

A legacy installation owns only its `$FM_HOME/.claude/settings.local.json` `hooks.Stop` entry, with explicit `FM_HOME`, pinned script and Node paths, and an 8 s outer timeout. The hook's own deadline is 5 s. No Firstmate source/bin/AGENTS/learnings file is modified, no service is started, and no hook is installed by Quarterdeck startup. After migrating through the unified installer, restart/resume the intended primary Claude Code session as needed for its settings reload and verify the live boundaries described above. Pi sessions have mechanical linking/closure but no Claude Stop enforcement.

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

`node --test test/*.test.mjs` covers executable interfaces (some cases create synthetic Git repositories). `test/firstmate-integration.test.mjs` exercises install/uninstall/status byte-and-time idempotency, exact rollback, preservation of unrelated edits, pin/projection/hook drift, partial-registration recovery, legacy/config refusal, tracked-source protection and symlink confinement in synthetic homes. `test/captain-ask-stop-hook.test.mjs` covers the opt-in primary-only lane guard. `git diff --check`, skill frontmatter, relative links and authority-boundary review apply to instruction changes. Static checks do not establish installed discovery or checkpoint outcomes. Legacy migration procedures are [branch inventory](dev-branch-inventory.md) and [parked work](parked-work.md), not records of any current installation.
