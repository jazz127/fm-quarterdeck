# Private /fm-toolcheck (Quarterdeck-owned)

`skills/fm-toolcheck/` is the canonical source of this private Firstmate-specific skill. It is **not** an upstream Kunchenguid Firstmate skill, a prototype UI feature, or the general watched-tools poll. No Firstmate checkout changes are needed. The command reads the installed Firstmate `bin/fm-bootstrap.sh` install arms at invocation, never sources them, and joins npm names only to installed manifests claiming an exact `github.com/kunchenguid/<name>` repository. The two bootstrap Kunchenguid install URLs prove scope for treehouse and no-mistakes. An npm dependency with no matching installed ownership evidence is explicitly excluded, rather than guessed. General tools (Pi, runtimes, shell, OS, package managers, Git/gh, tmux, ShellCheck, actionlint, Tailscale, Orca and watched tools) are outside scope.

## Reviewable activation

Use only the approved [unified integration installer](FIRSTMATE-INTEGRATIONS.md).
It owns home-local skill links, tagging, inventory and uninstall; do not hand-edit
Firstmate or create user-global projections. Historical user-global links require
separate original-owner removal authority; the installer never adopts them.
Source presence does not activate a skill or reload a harness.

Manually run `node /absolute/path/to/fm-quarterdeck/skills/fm-toolcheck/audit.mjs --firstmate-root /absolute/path/to/installed/firstmate` for a local audit. `--releases` optionally queries a bounded GitHub latest-release endpoint; absence is not evidence of currentness. Run `node --test test/fm-toolcheck.test.mjs` for deterministic executable-interface tests.

## Quarterdeck integration section

The audit additionally invokes the reviewed skill source's integration `status`
and `verify` interfaces, without locks, writes, health probes or installed-command
execution. It reports exact pin/projection drift: hook, check/trust, skill links,
owned captain preference block, private config and missing `fm-quarterdeck` tags.
The installed revision is compared with **local main** at
`<Firstmate-root>/projects/fm-quarterdeck`; `--quarterdeck-root /absolute/checkout`
selects another explicit checkout. An installed immutable skill pin is not the
current checkout. Missing main/ownership or dirty/non-main checkout is reported,
not guessed. Main is local evidence only; no fetch or remote freshness claim.

The report prints the exact uninstall-then-install command, including temporary
preservation of private health config. It is **review-only**, never executed by
toolcheck. Execution needs operator approval and a reviewed clean checkout at the
reported main revision. Changed owned artifacts refuse blind removal; unjournaled
legacy artifacts need their original owners, not a force flag. Use `inventory`
for the integration's bounded tagged artifact list, including retained inert pins.

## Evidence and limits

The report includes resolved command, every executable PATH copy and real target, manifest-claimed per-copy version/repository, content hash when bounded, Firstmate's parsed static floor, locally attributable source clone status and cached upstream divergence, conflict assessment, and optional release tag. For native treehouse/no-mistakes binaries **without manifests**, a bounded ELF/Mach-O Go build-info reader can report an exact matching Kunchenguid module version (including a pseudo-version); this is static build metadata, **not** a verified release, integrity attestation, or proof that a wrapper is safe. Pseudo-versions are not compared to CLI compatibility floors. Unrecognized binaries, scripts, ambiguous or absent build info leave the version unknown; deliberately forged metadata cannot be authenticated and must not be mistaken for installation integrity. No wrapper, native executable or installed command is run for discovery.

Source attribution starts at each resolved target, searches at most six containing directories, and requires a Git root at that ancestor plus the exact canonical `kunchenguid/<tool>` origin URL. A nearer unverified Git boundary stops the search; directory names and embedded module claims alone do not establish clone ownership. npm searches stop before the package's parent to avoid treating a runtime manager as its source. Read-only OS Git uses no optional locks, fsmonitor, submodule recursion or inherited Git configuration; there is no fetch. Manifest ownership/version and embedded Go versions are claims, not verified installation receipts; hashes allow later comparison but do not establish a trusted baseline. A clean source status does not attest to an unmodified installation; divergence is **only against cached upstream refs**, not network freshness. Feature probes are not executed; a satisfied floor does not prove feature compatibility. Release tags can differ from compatible npm versions and require separate review. The audit never installs, updates, changes PATH/configuration, fetches into a clone, switches branches, restarts anything, or drives a service lifecycle. Approval and upgrade execution are separate tasks.
