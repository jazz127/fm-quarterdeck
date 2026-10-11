# fm-quarterdeck

Firstmate Quarterdeck is a web dashboard for [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate). It presents your Firstmate fleet, conversations, preferences and operational evidence in a browser. `prototype/` contains the application and its Node server.

**A configured Firstmate installation is required for real operation.** Quarterdeck reads Firstmate's private home and uses its file and inbox contracts; this repository does not include Firstmate's agent orchestration or bootstrap it. The two repositories are installed separately. Without a Firstmate home, Quarterdeck can serve a limited synthetic preview and run offline tests, but that is not a functioning Firstmate fleet.

## Feature maturity

| Surface | Status | Note |
|---|---|---|
| Overview | 🔵 Active progress · 🟡 In test | Live Captain's Call on a two-column Overview. Cards update in place and an engaged card holds its own update. Each card has one text box: a board-sourced option answers, and text alone is a thread note. Lifecycle dots mark Active, Queued, Sent, and Procrastinated, and Procrastinate parks a card. On Active, Send queued (N) sends the queued answers through the same sender as Send batch. A sent answer shows Your answer at the top and locks its radios and note under the same hatch. Thread history stays on the card. Chat asks link onto filed calls ([chat asks](docs/CHAT-ASKS.md)). Just landed cards fill the second column, and on a phone the two sections are tabs: each shows what landed, the repository, a full pull-request link or local main, and when, with Acknowledge and one follow-up box. |
| Work Split | 🔵 Active progress | Early-stage experience; still taking shape. |
| Preferences | 🔵 Active progress | Early-stage experience; still taking shape. |
| Fleet Chats | 🟢 Stable | Core experience is established; polish is ongoing. |
| Expenses | 🟡 In test | Core functionality is available and continuing to evolve. |
| Quota page | 🟡 In test | Useful and operational, with further refinement ahead. |
| Sidebar quota cards | 🟢 Stable | Established, polished quota summaries at a glance. |

**Status:** 🟢 Stable is established · 🟡 In test is usable and still being checked · 🔵 Active progress is in active development · ⚪ Planned is not built yet.

## Prerequisites and setup

1. Set up [Firstmate using its upstream instructions](https://github.com/kunchenguid/firstmate#quick-start), including a supported agent harness and the tools for your chosen backend. Initialize the home there before pairing Quarterdeck; cloning either repository alone does not create an operational fleet.
2. Use Linux or WSL, Git and maintained Node **24 LTS** for Quarterdeck. Clone this repository as a separate clean Git checkout at `FM_HOME/projects/fm-quarterdeck`. `FM_HOME` must point to the initialized Firstmate home, not the Quarterdeck checkout. The home must already contain `data/`, `state/` and `data/projects.md`; real review intake also needs its `bin/fm-inbox.sh`.
3. Follow [first-run pairing](docs/FIRST-RUN.md), preserve the existing private state owner, and launch with the explicit paths shown below. Keep access inside your trusted private environment: Quarterdeck has no user authentication or tenant isolation.

Python 3.10+ and Chromium/Chrome are additional validation prerequisites. Billing/quota CLIs, Tailscale, Lavish and Orca are optional integrations; they do not replace Firstmate. [Portability](docs/PORTABILITY.md) details the supported platform and feature-specific requirements. No particular terminal or launcher is required by Quarterdeck.

The [Quarterdeck rename contract](docs/QUARTERDECK-RENAME.md) explains retained wire/storage namespaces, legacy state-variable compatibility and deliberate rollout requirements. Product naming changes do not migrate private data or restart services.

## License and source-preview policy

Quarterdeck is free to use, modify and redistribute under the [MIT License](LICENSE), including commercial use with the required notices. The repository owner is the initial maintainer/release owner. The [contribution workflow](CONTRIBUTING.md) prepares contributions to the future designated public source-preview repository after its [maintainer setup](docs/OPEN-SOURCE-CONTRIBUTIONS.md); this development repository remains private. See [governance](GOVERNANCE.md), [code of conduct](CODE_OF_CONDUCT.md), [security reporting](SECURITY.md) and [upstream/third-party attribution](THIRD-PARTY-NOTICES.md). Source availability does not authorize public hosting of private runtime data.

## Source, private data and startup

- Product source: **`FM_HOME/projects/fm-quarterdeck`**.
- Private Quarterdeck data: **`FM_HOME/data/agentos`** (currently the guarded expense bundle).
- Connection: **`FM_HOME` supplied explicitly when starting Quarterdeck**. No guessed user home, saved home file, or circular pointer inside the selected home.

Use a clean committed Git checkout, Linux/WSL and maintained **Node 24 LTS**, the enforced full-validation baseline. The package's Node 18 API floor is not a claim of maintained Node 18 support or full-suite compatibility; optional browser scripts need Node 22+ APIs. A Git-free archive is a transfer artifact, **not a runnable release**: serving without a provable clean revision in the exact source repository returns 503. Parent-repository discovery and inherited Git redirection cannot supply that identity. A later, separately authorized initial repository commit works without a parent; operator-owned preview/completion/deployment bindings must be regenerated. Do not copy old Git metadata to make an archive run. See [portability](docs/PORTABILITY.md), [public-source gates](docs/PUBLIC-SOURCE.md) and [verified history-free export/acceptance](docs/HISTORY-FREE-EXPORT.md).

Before pairing a fresh Firstmate home, follow [first run](docs/FIRST-RUN.md). The onboarding command previews/confirms only its versioned owned preference block, preserves user preferences and does not start services or project global skills.

```bash
export FM_HOME=/absolute/path/to/firstmate
cd "$FM_HOME/projects/fm-quarterdeck/prototype"
# Existing taxonomy owner guard requires a private owner outside FM_HOME.
# Preserve an existing owner; do not replace it with an empty file.
FM_QUARTERDECK_STATE_PATH=/absolute/private/outside-home/agent-state.json npm start
```

The expense overlay is selected before the empty public `expenses/ledger.json`. Existing taxonomy state, receipts, browser drafts and launch bindings are **not migrated by source cleanup**. Keep their existing owners accessible; do not retire an old checkout on the strength of this cleanup. [Private runtime](docs/PRIVATE-RUNTIME.md) explains those limits, safe copy provenance and read-only verification. Do not add personal expenses to the public fallback.

The server defaults to `127.0.0.1:4173`. From the same host:

```bash
curl http://127.0.0.1:4173/api/health
# Open http://127.0.0.1:4173 in your chosen browser.
```

For a remote host, use a private SSH tunnel on the desktop (`ssh -N -L 4173:127.0.0.1:4173 <remote-user>@<remote-host>`) and the same local URL. Orca is optional, not a runtime requirement. Keep any tunnel and foreground server running only for the intended window. No public listener or cloud deployment is implied.

| Variable | Default | Contract |
| --- | --- | --- |
| `FM_HOME` | unset | Explicit normalized absolute Firstmate home; required for real lanes/preferences and private overlay |
| `HOST` / `PORT` | `127.0.0.1` / `4173` | Keep loopback/private access; do not expose a private-data service publicly |
| `CLAUDE_CONFIG_DIR` | server user's `~/.claude` | Absolute Claude Code config directory; only this home's encoded `projects/` directory is read for the primary session |
| `FM_REFRESH_MS` | `0` | Manual KPI/dashboard refresh; automatic interval must be at least 5000 ms |
| `FM_BEARINGS_MIN_GAP_MS` | `30000` | Minimum snapshot start gap while watched; floor 15000 ms |
| `FM_BEARINGS_MAX_AGE_MS` | `300000` | Snapshot age ceiling while watched; floor 60000 ms |
| `FM_QUOTA_MAX_AGE` | `5m` | quota-axi reading reuse age: a positive integer with `s`, `m` or `h`, at most 1 hour; unset, invalid, zero or over-limit values fall back to the default |
| `FM_STATUS_PATH` | synthetic `prototype/data/fleet.json` | Fallback only without selected home |
| `FM_QUARTERDECK_STATE_PATH` | ignored checkout `prototype/data/agent-state.json` | Existing atomic taxonomy/acknowledgement owner, currently required outside selected home |
| `FM_REVIEW_ALLOWED_ORIGIN` | unset | One exact HTTPS DNS origin for optional private proxy writes; no port/path/wildcard/userinfo/trailing slash |
| `FM_REVIEW_STATUS_PATH` | unset | Optional private supervisor-watched review notification file |
| `FM_DEPLOYMENT_TIER` | unset | `uat` enables exact local-UAT identity; registry rules remain separate |
| `FM_COST_ATTRIBUTION_TAG` | unset | Fallback tag key only; private `costs.json` owns key and mapping when present |

`npm run dev` uses Node's watcher (18.11+) and asset reload; only a clean committed revision can serve requests. A dirty checkout fails closed. Every process is pinned to its startup commit: any HEAD change, including a clean fast-forward, returns 503 until the process restarts. Restart after committing or switching revisions, and regenerate any registry binding deliberately. Use an authorized isolated development checkout, not a shared acceptance service. Environment changes take effect at startup.

## Product surfaces

UI terminology uses **fleet** for a lane/workstream, **voyage** for a theme/iteration, and **expedition** for an implementation sequence. These are display labels: existing routes, data fields, stored state and the `fmqd-lanes` skill retain their established contracts.

- **Overview:** unchanged fleet KPI cards above live Captain's Calls (decisions, credentials and merge asks) from Firstmate's guarded bearings snapshot. Just landed cards sit in the second column, and on a phone the two sections are tabs: each shows what landed, the repository, a full pull-request link or local main, and when, with Acknowledge and one follow-up box. No Overview project/fleet tree. Cards update without reload; focus, typing, selection or a clicked card holds only that card, with its own update notice until disengagement; other calls update immediately. Unsent text stays in this tab, including resolved-call copy stubs. Long titles, asks, options and links stay fully readable, and a card with thread entries shows that history without opening the composer. Missing/stale evidence and incomplete coverage remain visible. A card can be answered in place (freeform, or Firstmate's own options; Merge now on merge asks): Review answer, then Send to Firstmate relays it like a `/bearings` board answer, and the card leaves only when Firstmate resolves the call. Overview lists Active cards by default, with a status toggle for Queued, Sent, Procrastinated, and All. On Active, Send queued (N) sends those queued card answers through the same Send batch sender when N is at least one. A Sent card is hatched and labelled from the inbox receipt: Sent - waiting for Firstmate to read while the note is pending, and Firstmate is on it once acknowledged with no reply. A sent answer shows Your answer at the top and locks its radios and note under the same hatch, and a thread follow-up stays editable. A reply while the call stays open returns the card to Active, shows Firstmate replied at the top, and unlocks the controls. Review batch headers keep the marker and title on one line, with the local sent time and a short copyable batch id. [Live Captain's Call](prototype/BEARINGS.md) owns source, cadence and engagement semantics.
- **Work Split:** explicit repository → fleet → voyage hierarchy, stable task/session links, verified active workers, separate waiting/decision/cleanup pressure, and exact completion attention. Mark understood is an idempotent acknowledgement, not merge, publication or deployment. [Work taxonomy](prototype/WORK-TAXONOMY.md) owns state/evidence semantics.
- **Overview activity:** “Last activity seen” displays the newest file clock from the primary Firstmate transcript, wake queue, watcher beat or fleet heartbeat (relative and absolute local time). The adjacent live/stale/unknown check uses the watcher beat, warning after five minutes. Missing files remain unknown. Dashboard, Fleet Chats and bearings polls, plus each bearings stream tick, reread these clocks server-side without exposing paths or event contents; the page ticks their ages every second and shows “as of” after a minute without a successful activity fetch. File activity is evidence of supervision activity, not proof of task completion.
- **Fleet Chats:** oldest-to-newest durable records, fleet/kind/search/source filters, bounded source loads and 200-record pages. Active task sessions plus two recent sessions per fleet and active disk pointers (including the Claude Code primary session) plus two recent files load initially; disk sources initially load their newest 1 MiB of whole records with visible coverage warnings and a “Load more records” control to widen to the existing 8 MiB bound. On phones, the load-more button and source-window/search hint live in Fleet Chat options instead of consuming a feed row; desktop placement is unchanged. Search and filters cover loaded records only. Older history remains available on demand; first load shows an explicit loading status. Refresh preserves selection and reading intent; no stale server snapshot is invented. [Transcripts](prototype/TRANSCRIPTS.md) and [source windows](prototype/SESSION-WINDOW.md) specify coverage, task-event/outcome omissions and remaining hard limits.
- **Expenses:** every selected ledger entry, currency/category/project rollups and confidence basis. Public fallback is empty; missing canonical file enables a clearly labeled synthetic demo. Decimal arithmetic is exact and currencies are not converted. Billing cards are separate and never added to ledger totals. [Expense helper](expenses/README.md) edits the selected private ledger.
- **Quota:** allowlisted `quota-axi --full --json --no-credential-refresh --max-age 5m` output by default, including `muse`, bounded reads and a one-minute successful-reading server cache. The first read has a 15-second execution budget (subsequent reads: 6 seconds); failed reads retry after five seconds, still coalescing concurrent requests and retaining previous good evidence as stale. Unknown or malformed provider entries are skipped while valid entries remain; the quota API's additive `unsupportedProviders` count includes all rejected entries. `FM_QUOTA_MAX_AGE` sets the explicit reuse limit even with `--full`. Source-reported reuse shows `reused 42s` / `reused 3m`: whole seconds below two minutes, whole minutes thereafter. Freshness labels use each provider's `refreshedAt`, or `age unknown` when timing is missing. A provider is stale when quota-axi reports it, a Quarterdeck refresh fails while retaining a previous reading, or its age reaches the configured limit. Stale cards use a subdued surface and half-filled warning marker; effective availability, pace and runway become unknown. Captured window percentages and valid reset-window markers remain source evidence; scope/window ownership and reset semantics stay source-bound. Window labels display `7d` instead of week/weekly while retaining full accessible wording. AGY's explicitly classified weekly and 5-hour session buckets supply label-derived marker intervals when numeric duration is absent, disclosed as “Window length from provider label” in the hover text; unknown/model windows and captures outside the interval have no marker. This fallback does not infer pace or effective availability. Claude account and model-specific windows share a single visual card with distinct rows (for example, `fable 7d`), without merging their source scope bounds. Provider headers show one name beside the decorative monogram; `AGY` is uppercase. Freshness stays on one line with full title/aria wording when compact text is shortened or clipped. Staleness alone does not expose previously hidden compact rows. The browser rechecks age every 15 seconds without fetching, preserving focus, text selection and disclosure state. Missing readings remain unavailable. The full page adds source-bound summary tiles, visual provider cards and collapsed exact evidence, with a sort preference shared with the unchanged sidebar. [Quota page](prototype/QUOTA-PAGE.md) documents evidence mapping and the synthetic screenshot matrix. The sidebar defaults open and fits its quota rows to the space left by navigation and footer controls; few subscriptions take only their content height. Collapse, manual height and remaining-capacity sort choices persist independently. Divider Home/double-click restores automatic sizing. The header's segmented sort control offers `Left ↓` / `Left ↑` (select `Left` again to reverse), ordering captured remaining percentages highest/lowest first, and `Runway ↓` / `Runway ↑` (select `Runway` again to reverse), which orders source pace reserve, falling back to source runway coverage relative to a known future bounded reset. `AZ ↑` / `AZ ↓` sorts provider names alphabetically in either direction, including unavailable readings. The one-line `Quota` header toggles collapse from any non-sort area and supports keyboard activation; narrow panes hide the reading time. It never estimates consumption from percentages alone; unknown/stale sort last with visible labels. The phone sheet retains its existing four-row source order.
- **Preferences:** guarded read-only `FM_HOME/data/captain.md`, accepting exactly `# Working preferences` or `# Captain preferences` with `##` sections, section sources and explicitly recorded dates/rationales. HTML comments do not establish titles or sections; a supported title followed only by comments yields no entries. Credential-like sections are withheld. HTTP does not edit that home record. The separate **Away supervision** form saves Quarterdeck-owned health preferences: **Away check-in interval** (default 10 minutes) and **Open note alarm** (default 15 minutes), whole minutes from 1 to 1440. Explicit saves use a same-origin validated API and atomic `quarterdeck-preferences.json` alongside the configured taxonomy state owner; health checks read it without writing preferences and use defaults for missing/invalid values.

Lane envelopes are display/filter hints, not task ownership or destinations. Complete multi-block replies route independently; unmarked/malformed text uses conservative legacy matching. Captain, replies and fleet notes default on, native thinking when present; progress narration, crew, tools, harness and steers are separate opt-ins. The app never fabricates thinking, unpersisted dialogue or missing clocks.

## Optional account integrations

Expenses account cards use the server operator's authenticated `az` subscription and `gh-axi` user, not credentials in source or browser storage. Azure needs Cost Management Reader/Billing Reader at the intended subscription; GitHub needs user billing access with Plan: read and enhanced billing availability. Select and authorize accounts before launch. Missing permission is unavailable, never zero. Snapshot reads are bounded, cached five minutes and coalesced per provider; failed refreshes retain stale evidence visibly. Subscription IDs, credentials and raw CLI diagnostics are not served.

Private `costs.json` supplies a validated tag key **and tag-value-to-label map**. Public defaults have no project allocations. Unmatched or unreconciled spend remains unclassified. The browser uses server-supplied labels, including unavailable states, rather than a hardwired portfolio. No live billing call is required for offline validation; inject synthetic readers. [Portability](docs/PORTABILITY.md) lists all optional prerequisites and account boundaries.

## Private Tailscale review (optional)

Use the ownership-safe foreground [Tailscale launcher](docs/tailscale-launch.md) with explicit `FM_HOME` and any required state owner. It discovers the authenticated device DNS name and refuses existing listeners/routes; no installation hostname is shipped. Restrict tailnet membership/ACLs because read APIs expose private data too. Use Serve, never Funnel or a general firewall opening.

The exact configured HTTPS Host **and** Origin must match on writes. Arbitrary tailnet names, changed scheme, userinfo, suffix deception, absent Origin and spoofed forwarding headers fail. Verify `/api/health` and full `/api/review.version` on the intended clean revision before separately authorized synthetic receipt acceptance. Use the launcher's scoped stop procedure; do not remove unrelated shared routes.

## Install Quarterdeck

Quarterdeck is installable and **online-only**: no service worker or offline data cache. Use the trusted private HTTPS origin (for example, private Tailscale Serve); stay connected to the required private network. Installing an icon grants no new access. `FM_REVIEW_ALLOWED_ORIGIN` must exactly match the HTTPS origin used to install for review/chat writes.

- **Android Chrome:** browser menu → Install app (wording/availability varies by browser).
- **iOS Safari:** Share → Add to Home Screen; enable Open as Web App where offered. Standalone storage is separate from Safari's, so existing Safari drafts do not carry over.

HTML and static assets use `no-store`. On startup or return to the foreground, the existing review configuration check can show **“Quarterdeck updated — reload to continue”** with a Reload button when the server revision differs from the open document. Reload is always explicit, never automatic; the current route is retained. Review drafts/retries keep their existing tab-local storage semantics. A failed check means unavailable, not an update. Real Android/iOS standalone installation and status-bar layout checks remain pending.

## Review and primary chat

On desktop, the info-circle beside the bottom-left annotation toggle opens click help and shows the current toggle state. With the toggle off, Alt + left click on content opens an annotation and a plain left click works normally; with it on, those gestures swap. Buttons and other controls still work with a plain click. Focus the info-circle and press Enter to open help; click outside or press Escape to dismiss it. While help is open, Escape closes it first, preserving an open annotation or armed location selection. With focus on the help button or composer, a second Escape closes the annotation or cancels selection while keeping the draft. Escape in Fleet Chats search follows that field's existing behavior once help is closed.

Review messages and annotations use `fm-agentos-review.v2` with `{batchId,sessionId,version,route,end,entries}`. Entries follow lavish prompts: `{prompt,selector,tag,text,target?,record?,label?}` (optional `uid`, no DOM snapshot); `prompt` is the request and `text` is a bounded target excerpt. Selection ranges, clicked sub-elements and table cells retain precise anchors; no-ID messages use a fingerprint rather than the whole body ([annotation contract](prototype/LANE-MESSAGE-ANNOTATIONS.md)). Inbox notes carry numbered prompts plus one fenced `json fm-review` envelope. Fleet Chats shows the prompts with native **i** (batch information) / **a** (annotation target) disclosures; raw view retains the complete note. V1 remains accepted for unchanged receipt retries; unsent v1 drafts convert to v2. Exact origin, schema, size and serving revision are mandatory. Annotation context is not execution authority.

Without Lavish delivery, accepted batches are durably recorded in ignored `prototype/data/review-receipts/<batchId>.json`. A receipt confirms storage, not Firstmate intake/completion. Same-ID retries never overwrite a receipt or duplicate its initial notification. With selected home, guarded `bin/fm-inbox.sh note`/`announce` and receipt reads provide separate intake readiness and acknowledgement. Never replay old receipts just to migrate storage. Optional status sidecars can explicitly record received/handling/completed/failed; no stage is inferred from time.

For Firstmate inbox replies, review history prefers a string `body` (including an empty string), falls back to legacy string `text`, and retains replied status with no message when neither field is a string.

Local inbox submissions use a short durable [debounce](prototype/BEARINGS.md#inbox-debounce) shared with card answers and thread notes. Pending submissions remain visible; Send now bypasses the window. Saved server outbox items survive page close and resume after restart. Combined notes retain every original item and share one Firstmate acknowledgement/reply.

Review queue, drafts and receipt-backed history stay in this tab's session storage across reloads; send before closing. Thirty is the per-request entry limit, not a limit on retained batches. Storage failure is visible. Uncertain deliveries keep their exact payload and ID across revision changes: local retries first reconcile the original durable receipt, retaining its provenance. Only a rejected unaccepted local batch offers an explicit target-rechecked conversion to a new version-bound ID. Keep the same receipt-store owner accessible across restarts. Lavish has no receipt-reconciliation adapter; unresolved old-version deliveries retain their identity and require operator reconciliation. Send & end ends the conversation, not review availability. The phone Message/Review pane and desktop composer share delivery semantics; background interaction is locked only in Review mode. [Layout acceptance](prototype/LAYOUT-CORRECTION.md) separates geometry from guarded intake proof.

Optional `FM_LAVISH_REVIEW_URL` must be loopback HTTP with explicit `FM_LAVISH_REVIEW_SESSION`. Its adapter must return a real JSON receipt ID; no discovery/history/intake adapter is implied. Do not point it at an arbitrary prompt endpoint.

Primary chat is a separate `fm-agentos-chat.v1` injected `chatDeliver` contract addressed only to primary Firstmate. `text` is the unchanged intent; `viewContext` is a separately validated advisory snapshot of route, exact branch/commit, selections and visible record IDs/times, without record bodies. It never chooses an agent or becomes a steer. Receiver must durably deduplicate `messageId`; unavailable transport preserves the draft.

## Branches, integrations and checks

[Branch/preview authority](docs/branching-and-preview-model.md) distinguishes local candidate, remote checkpoint, captured work, healthy exact preview, accepted release and deployment. No browser Git mutation exists. Clean revision, exact Host/Origin, confined preview paths and process ownership proofs must not be relaxed for portability.

[Quarterdeck operating rules](FIRSTMATE.md) is the reusable policy entry point for a paired supervising Firstmate; private preferences can soft-reference an approved stable copy while retaining private specifics and approvals locally. Reading it changes no installation or service.

[Firstmate integrations](docs/FIRSTMATE-INTEGRATIONS.md) describes the single opt-in `scripts/firstmate-integration.mjs install|uninstall|status|verify|inventory <FM_HOME>` transaction: one hash-verified revision supplies home-local `fmqd-lanes`, `fmqd-toolcheck`, `fmqd-quartermaster` and [`fmqd-health`](skills/fmqd-health/SKILL.md), the Claude ask/lane Stop guard, registered health check, private JSON config and owned policy reference. Every installed artifact carries `fm-quarterdeck` directly or in its ownership manifest; inventory lists them, and fmqd-toolcheck reports pin/projection drift with a review-only reinstall command. It preserves unrelated preferences/settings and refuses unknown legacy artifacts; migration and rollback are explicit. Health reuses Firstmate's watcher during `/afk`; setup is not automatic and never changes tracked Firstmate source or services. Source presence does not activate skills or modify Firstmate. The [instruction-to-code inventory](docs/INSTRUCTION-TO-CODE.md) maps remaining producer/operator dependencies and documents opt-in lane checks, receipt-proven note closure and owned restart-after-landing helpers. [Documentation index](docs/README.md) links architecture and feature plans.

```bash
cd prototype && npm test
# Offline Chromium behavioral gate from a clean committed checkout:
CHROMIUM=/absolute/path/to/chromium npm run test:browser
# Optional durable desktop/phone review screenshots (synthetic spare-port candidate):
SCREENSHOT_DIR=/absolute/private/proof node scripts/review-annotation-format-browser-pass.mjs
# From repository root:
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s expenses
node --test test/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
python3 scripts/check-source-syntax.py
python3 scripts/check-product-boundary.py
```

Full suites require Node 24 LTS (enforced by npm pretest, direct suite regression and the history-free driver) and include synthetic Git repository/lifecycle fixtures; run only with appropriate authorization. [Public-source validation](docs/PUBLIC-SOURCE.md) provides a narrower no-repository-creation gate. Optional headless scripts require Node 22+ and `CHROMIUM` or PATH `chromium`. The live Captain's Call pass (included in `test:browser`) also requires installed `chrome-devtools-axi` with its MCP backend; it attaches only to its own synthetic browser. See [portability](docs/PORTABILITY.md). Static renderer/CSS checks are not browser-paint evidence. To reproduce slow-CI browser startup/render races, prefix `npm test` or `npm run test:browser` with `FM_BROWSER_CPU_RATE=6`: the isolated Chromium harness applies 6× CPU throttling (optional rate 1–20, default 1), without changing server reads or readiness deadlines. Fleet Chats geometry checks measure the routed feed both while its API read is pending and after messages arrive; a static loading placeholder alone is not route readiness.

[Source-preview validation](docs/SOURCE-PREVIEW-VALIDATION.md) describes the offline automated gate, resource limits, authentication boundary and remaining real-environment checks. The GitHub workflow runs tests once per PR update and on pushes to main; required `validate` covers deterministic tests and source/privacy checks, while advisory `browser` covers real-process and browser suites. It does not publish or deploy. CI installs npm `chrome-devtools-axi@0.1.39` (the local validation version) only on the runner and runs the full `npm run test:browser`, including Captain's Call against its own headless Chrome. No browser checks are skipped, and local prerequisites/checks are unchanged; the CLI starts its MCP backend via npm on first use.
