# Supported platform and optional integrations

## Baseline (F11–F13)

Real operation depends on a separately installed and initialized [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate) home and its documented file/inbox contracts. Follow upstream setup for the agent harness and chosen backend before [pairing Quarterdeck](FIRST-RUN.md). Quarterdeck supplies the web application and Node server, not the Firstmate orchestrator. A home-free synthetic preview and offline contributor tests do not establish a live pairing.

The maintained, validated baseline is Linux or WSL with a local POSIX filesystem, Git and **Node 24 LTS**. The full suite and history-free acceptance enforce major version 24; Node 18/20/22 are not full-validation baselines. The package retains a historical Node 18 API minimum (18.11+ for watch mode); that compatibility floor is not a maintained-runtime recommendation or a claim that the full suite runs there. Prefer current Node 24 LTS for actual operation. Python expense tooling needs Python 3.10+ and `fcntl`. No broader OS support is asserted: onboarding pins directories through Linux `/proc/self/fd`, and preview ownership still requires Linux `/proc` process incarnations. [Work taxonomy](../prototype/WORK-TAXONOMY.md#current-execution-versus-pressure) owns worker evidence and its platform-specific probes. Missing/denied identity evidence fails closed rather than guessing.

Source is `FM_HOME/projects/fm-quarterdeck`; private Quarterdeck inputs are `FM_HOME/data/agentos`. Supply a normalized absolute `FM_HOME` at startup; never persist a home pointer inside itself. Home `data/` and `state/` plus `data/projects.md` establish the onboarding shape. Intake additionally requires the guarded selected-home `bin/fm-inbox.sh` contract, not copied scripts or another home's endpoints.

The existing taxonomy-owner guard forbids state anywhere under selected `FM_HOME`. Thus source nested there currently needs explicit `FM_QUARTERDECK_STATE_PATH` outside the home; preserve that existing owner. This exception and checkout-owned review receipts are not silently migrated or weakened by public-source sanitization. See [private owners](PRIVATE-RUNTIME.md).

## Git identity and history-free transfer

A Git-free archive is **not executable as a served distribution**: requests fail 503 without clean revision proof. The shared bounded Git-identity helper proves the exact source top-level at startup and again during request-time HEAD/clean/startup-commit checks. It discards inherited Git redirection/config/object overrides; a parent or sibling repository cannot supply identity to a nested Git-free export. A later separately authorized fresh repository with one clean initial commit supplies a valid identity; serving does not need `HEAD^`. The narrow disclosure scan creates no repository; the separately authorized [history-free fixture](HISTORY-FREE-EXPORT.md) creates only temporary synthetic repositories to prove real initial-commit behavior.

A new identity invalidates old preview registry, remote checkpoint, completion/delivery and review-version bindings. Regenerate operator-owned bindings deliberately; absent remote objects/evidence stays unknown. Do not import `.git`, old objects, refs, remotes, reflogs or author metadata as a workaround. Source export uses the reviewed tree only, never a raw working-directory copy.

The optional lifecycle lab provisions synthetic root/child/sibling history through the verified tree exporter; it does not assume the product repository has a parent. It now also needs Python 3.10+ and Git 2.29+. Running it creates fixture repositories/processes and needs separate authorization. Mocked resolver tests remain available for no-repository checks; the full history-free fixture instead proves initial-commit/no-Git/dirty behavior against real Git and loopback services without creating a publication repository.

## Headless checks

Optional browser scripts need Node 22+ (global `WebSocket`; some use `import.meta.dirname`), an installed Chromium and local CDP support. Set `CHROMIUM` explicitly or provide `chromium` on PATH; no pinned Playwright cache build is assumed. The package manifest does not install a browser or optional tooling. Use task-local temporary profiles, loopback ephemeral ports and a bounded deadline, never the operator's browser or a shared acceptance service. Prefer `chrome-devtools-axi` when required by the operating contract; no headed window is necessary. The live Captain's Call pass, included in `npm run test:browser`, requires installed `chrome-devtools-axi` and its MCP backend. Set `CHROME_DEVTOOLS_AXI_MCP_PATH` for a preinstalled backend if needed to avoid the CLI's default package lookup; the pass uses a unique session attached to one fixture-owned CDP endpoint. Some legacy scripts use `--no-sandbox` for disposable Linux fixtures, not as a deployment recommendation.

Only select an explicitly authorized home for live-home scripts. For account-free acceptance inject cost/quota/durability readers and synthetic lanes/intake; default adapters may reach accounts even when a page starts on another view. A synthetic browser result never proves real intake or live account parity.

## Optional installed tools/accounts

- `quota-axi`: server PATH, using the [documented quota invocation](../README.md#product-surfaces). No browser credentials, login or prompts. Installed account context may still require external reads; do not invoke it during offline validation.
- `az`: operator-selected authenticated default subscription and authorized cost-reading permissions. `gh-axi`: operator-selected authenticated user with enhanced billing access/Plan: read. No account, tenant or subscription is hardwired. Missing CLI/auth/permissions is unavailable, not zero. Inject bounded synthetic output for tests.
- Delivery evidence: explicitly configured Git remote/repository/deployment destination; remote reads and forge APIs need separate authority. Missing objects never prove containment.
- Tailscale: optional authenticated CLI, `TAILSCALE_BIN` override or `tailscale` / `tailscale.exe` discovery, exact private device DNS and namespace reachability. WSL/Windows bridges must prove their own loopback reachability. No wildcard or Funnel fallback.
- Toolcheck: selected installation bootstrap metadata and verified source clone/tool contracts; restricted Unix PATH and `/usr/bin/git` are intentional safety constraints. Optional latest-release lookup is network access, not an offline check.
- Orca/SSH: optional remote terminal/browser workflow; any ordinary browser works with the loopback server/tunnel.

Publication of source never authorizes hosting private transcripts, preferences, expenses, quota or full review receipts publicly.
