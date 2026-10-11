# Reviewed tree export and first-commit acceptance

This is a **local source-transfer boundary**, not publication authority. Source remains `FM_HOME/projects/fm-quarterdeck`; private expenses remain `FM_HOME/data/agentos`, selected only by explicit startup `FM_HOME`. Never transfer an installed home, runtime files, Git metadata, old authors, object stores or remotes. Public source does not authorize a public hosted service.

## Prerequisites and trust

- Supported: Linux/WSL with Linux `/proc`, POSIX permissions, Python 3.10+, Git 2.29+ (SHA-1 repositories), **Node 24 LTS** and npm. Major version 24 is enforced by the driver and full suite; the product's historical Node 18 API floor is separate, not a full-suite support promise. Standard libraries only; no install/network step. Optional browser checks separately require Node 22+ and Chromium and are not part of this fixture.
- Work in an authorized isolated checkout. Use a private, non-symlink scratch directory with exclusive access and enough space for three source exports plus synthetic test repositories. Do not run alongside an untrusted local writer. `TMPDIR` confines helper temporary files too.
- Inspect the exact committed tree and changed assets. **Inventory generation is not review.** The frozen external allowlist is the independent authority: exact sorted paths, file modes, lengths and SHA-256 content hashes. Do not accept a new manifest merely because it accompanies a changed archive. Keep the reviewed manifest/digest in the release owner's separately controlled evidence. This avoids a self-hashing source manifest and embeds no old commit identity.
- `--audit /explicit/private/report.md` additionally applies the complete original owner's private blocked-marker/evidence tables, with redacted failure output. Neither that report nor its fingerprints may enter source. Without it, public semantic/hash/type gates still run, but absence of owner-specific markers has **not** been proved.

## Exact commands for a future authorized export

From the reviewed, clean committed repository root (replace placeholders; no remote is contacted):

```bash
umask 077
mkdir -p .sanitization-lab/export .sanitization-lab/tmp
export TMPDIR="$PWD/.sanitization-lab/tmp"
export PYTHONDONTWRITEBYTECODE=1
CLEAN=$(git rev-parse --verify HEAD)
test -z "$(git status --porcelain --untracked-files=all)"
TREE=$(git rev-parse --verify "$CLEAN^{tree}")
OUT="$PWD/.sanitization-lab/export"
AUDIT=/explicit/private/report.md

# Produces a CANDIDATE only. Review all paths/modes/bytes and freeze independently.
python3 scripts/source-export.py inventory --tree "$TREE" --audit "$AUDIT" \
  > "$OUT/allowlist.candidate.json"
# After the independent review, retain the approved copy as allowlist.reviewed.json.
# Do not regenerate/overwrite an approved allowlist to make a verification pass.

python3 scripts/source-export.py export --tree "$TREE" \
  --allowlist "$OUT/allowlist.reviewed.json" --audit "$AUDIT" \
  --archive "$OUT/quarterdeck-source.tar"
python3 scripts/source-export.py verify --archive "$OUT/quarterdeck-source.tar" \
  --allowlist "$OUT/allowlist.reviewed.json" --audit "$AUDIT"
python3 scripts/source-export.py extract --archive "$OUT/quarterdeck-source.tar" \
  --allowlist "$OUT/allowlist.reviewed.json" --audit "$AUDIT" \
  --destination "$OUT/verified-source"
python3 scripts/source-export.py verify-directory --destination "$OUT/verified-source" \
  --allowlist "$OUT/allowlist.reviewed.json" --audit "$AUDIT"
sha256sum "$OUT/quarterdeck-source.tar" "$OUT/allowlist.reviewed.json"
```

The archive/output directory must not exist; nothing is overlaid or overwritten. To reproduce the archive, repeat `export` to a **new** filename using the same tree/approved allowlist, then compare with `cmp`. The tree argument must be a full tree-object ID, not a branch, commit, tag or expression. Source reads use `git ls-tree`/`cat-file`, never working-directory bytes. Dirty local/ignored files cannot enter through a raw copy. A hardlinked working file has no link semantics in a Git blob; output files are newly created regular files with one link.

The project creates deterministic uncompressed **USTAR** (sorted paths, normalized modes, zero UID/GID/mtime, empty owner names). It does not invoke `git archive <commit>`: no global PAX commit comment or old author provenance is emitted. Verification inspects physical headers before extraction, not an iterator that hides extended headers. Only sorted member order and the exact final USTAR record padding emitted by this canonical format are supported; even reordered members or extra all-zero padding are rejected. All PAX/GNU extensions, symlinks, hardlinks, devices, FIFOs, sparse files, duplicate/missing/extra paths, noncanonical/traversing names, case collisions, unsupported modes, trailing payloads, unknown bytes and unexpected directories are refused. Empty Git subtrees, submodules and `.gitattributes` are unsupported, not silently omitted. Tree-owned ignore rules are checked in an empty temporary matcher repository, independent of user/global/local ignore files; ignored paths are rejected even if force-tracked or inserted into a manifest. Known runtime/private paths and public disclosure semantics are also mandatory. Directory verification uses `lstat`, no-follow regular-file reads and single-link checks, including ancestor directories.

## Temporary history-free runtime acceptance

```bash
python3 scripts/accept-history-free.py \
  --archive "$OUT/quarterdeck-source.tar" --allowlist "$OUT/allowlist.reviewed.json" \
  --audit "$AUDIT" --scratch "$OUT" --log "$OUT/acceptance.log"
```

The log must be new and under the explicit scratch directory. It contains only synthetic fixture/tool diagnostics; keep it private and untracked. A failed command returns a redacted category; inspect this log locally for details. `--runtime-only` is a debugging shortcut, **not** complete acceptance.

The driver verifies before extraction, then constructs an entirely temporary selected home with source in `home/projects/fm-quarterdeck`. It deliberately creates an unrelated synthetic parent repository and proves the nested Git-free export still returns **503**, both with ordinary Git discovery and inherited Git redirection (no ceiling masks the regression). It then initializes the source with empty templates, no hooks/signing, an isolated tool HOME/config/PATH and one deterministic synthetic author/committer/commit. It proves one reachable root commit, exactly one local branch, no remotes/alternates/shallow state or unreachable/old objects. Blob identity may naturally match existing source blobs; nothing is copied from an old object database. Startup and request-time checks share the bounded exact-root Git-identity helper; inherited Git/config/object overrides are not authority. Runtime checks use the real revision resolver and real server, not mocked revision evidence:

- clean first-commit HTML/health and exact full review version, including startup under inherited Git redirection;
- explicit synthetic `FM_HOME`, onboarding/idempotence, private overlay permissions and ledger selection, no home discovery or saved pointer;
- outside-home taxonomy owner requirement, dirty-checkout 503 and restored clean health;
- exact origin and registry-ID write checks; wrong checkout/uncaptured development refusal;
- separately exported preview checkouts with **their own** synthetic parent/child history, real process/checkout/health proof, local-ahead identity, proxied health/version, and exact owned-child shutdown.

The primary fixture stays on its **single initial commit** throughout. The lifecycle lab uses the same tree verifier and synthetic-history helper, never the source repository's parent or old objects. No Git/revision/preview guard is disabled to make a first commit start. Account readers are synthetic/unavailable; PATH excludes installed account CLIs. npm is explicitly offline with update notifications, audits and funding disabled. Only owned ephemeral loopback listeners run. Successful exit removes temporary repositories/homes and closes owned services; external allowlist/archive/log remain. An abrupt OS kill can leave task scratch for explicit owner reconciliation, not shared cleanup.

By default the driver also runs the complete `prototype` Node suite, Python expenses suite, root Python export/disclosure regressions, root Node toolcheck fixture suite and syntax/local-link checks **inside the new one-commit repository**. No dependency installation, browser, account refresh or external network request occurs.

For ordinary authorized local regression validation:

```bash
(cd prototype && npm test)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s expenses
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
node --test test/*.test.mjs
python3 scripts/check-source-syntax.py
python3 scripts/check-public-source.py --audit "$AUDIT"
```

Set `NPM_CONFIG_OFFLINE=true NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false`. Clear inherited home/account/preview/Git overrides first; point `HOME`, XDG directories and `TMPDIR` at private task scratch and disable user Git hooks/signing. The acceptance driver does this automatically. Syntax checks cover Python/JavaScript and local Markdown file targets, not TypeScript builds, heading anchors or browser paint.

## Remaining release gates and limits

1. Obtain independent approval of the final exact tree/allowlist and repeat disclosure/semantic review for F01–F13 in [PUBLIC-SOURCE](PUBLIC-SOURCE.md). Hash equality is not a general absence-of-secrets proof. Re-review all new bytes, binaries and metadata after any build/generation.
2. If a secret scanner is **already installed**, inspect its local help, then use fully redacted **directory/no-Git** mode on `verified-source` before any initialization (for modern Gitleaks: `gitleaks dir --redact=100 --no-banner "$OUT/verified-source"`). No install, credentials, verification endpoint, tool update or external service access. Do not use a scanner whose directory mode contacts services; TruffleHog must also disable credential verification/updates. Record unavailable tools honestly. Synthetic false positives need narrow reviewed explanations, not blanket test/JSON/asset exclusions.
3. Unknown secret encodings and a general third-party/dependency/legal audit remain residual risks. The unused legacy JPEG and provider drawings were removed; no artwork rights were inferred from availability. The source preview adopts [MIT](../LICENSE) and [project-specific notices](../THIRD-PARTY-NOTICES.md), not an upstream copyright claim. New artwork/dependencies need their own review. SHA-256 equality and local unsigned evidence establish bytes, not a signature or authenticated distribution channel.
4. Publication repository creation, final release-owner approval of attribution/notices, remote configuration, push and any hosted deployment require separate authority. Enable the private reporting route in [SECURITY](../SECURITY.md) when the repository exists and complete [contribution setup](OPEN-SOURCE-CONTRIBUTIONS.md) before inviting [public contributions](../CONTRIBUTING.md). Regenerate operator-owned preview/review/completion/deployment bindings for the **new** identity; synthetic local acceptance is not real release acceptance or evidence of remote containment.
5. A source repository is not a public service. Quarterdeck reads transcripts/preferences/expenses and operator-authenticated billing/quota. Keep real services loopback/private-tailnet; any public demo must use exclusively synthetic readers/data and a separately reviewed hosting/security design. This fixture does not validate live billing parity, migrate state/receipts/browser drafts/global skills or authorize retiring an existing checkout/UAT service.
