# Source-preview validation

Source-preview readiness means a reviewed tracked tree others can validate offline with maintained Node 24 LTS, Git and Linux/WSL, then pair with a separately initialized [Firstmate](https://github.com/kunchenguid/firstmate) installation for real operation inside a trusted private operator environment. It is not production readiness, public hosting approval, an authentication system or a live Firstmate acceptance result. Keep the current repository private and use the reviewed [history-free export](HISTORY-FREE-EXPORT.md) for a later separately authorized public copy.

## Automated gate

`.github/workflows/source-preview.yml` runs once on each pull-request update, on pushes to `main`, and on manual dispatch. Both independent jobs use disposable Ubuntu, read-only repository permissions, no persisted checkout credentials and no account secrets; both install the locked application package.

The required job remains named **`validate`**. It runs `cd prototype && npm run test:ci`, the repository/expense Node and Python suites (including privacy scanner regressions), and source syntax/product-boundary checks. No branch-protection settings change is needed.

The advisory **`browser`** job runs `npm run test:integration` and the complete `npm run test:browser`. The explicit, exhaustive file partition is `prototype/scripts/test-selection.json`; repository checks reject missing or duplicate suites. Real-process suites include indirect Git probes during module import, synthetic Git histories, CLI subprocesses, the preview-lifecycle real-child fixture, browser-harness process cleanup and feed-width Chromium checks. `npm test` remains the complete local suite. Each advisory suite step reports its outcome and the final step fails the advisory job if either fails, while still running both steps. Only `validate` is required for merging.

The advisory job installs pinned `chrome-devtools-axi`, prefers stable Google Chrome, falls back to Chromium on PATH, reports its version and persists `CHROMIUM` through `GITHUB_ENV`. Missing browsers fail the job rather than silently removing coverage. Chromium is a validation prerequisite, not an application dependency.

### Flake quarantine backlog

A flaky test moves to the advisory selection with a tracked backlog fix; never delete or skip it to unblock merging. Keep its assertions and CI execution, record the failure/reproduction and fix acceptance, and return deterministic coverage to `validate` once the fix is verified.

- [ ] **CI-Q1 — preview-lifecycle real-child fixture:** remove the race between child IPC readiness and ownership/liveness assertions; verify repeated runs under shared-runner load. Fixture fixes are separate from this CI split.
- [ ] **CI-Q2 — hardening CDP fixture:** remove timing-sensitive browser/CDP readiness assumptions; verify the full hardening pass repeatedly under shared-runner load. Keep the pass in `test:browser` throughout the fix.

Browser launch readiness has a separate 30-second deadline for a cold Chromium/profile on shared runners. It polls the debugging port without relaunching; early process exits and unexpected profile read errors fail immediately, and startup failures include at most 2000 characters of stderr. CDP command deadlines (10 seconds), page-readiness checks and every layout/delivery assertion remain unchanged.

The browser gate serves a clean exact commit on an ephemeral loopback port, uses synthetic task/transcript and receipt state plus a temporary browser profile, and removes its owned server fixture on exit. Chromium profile cleanup waits for the started browser process to exit and uses bounded removal retries. Exhausted `ENOTEMPTY` or `EBUSY` removal failures log a warning without changing the browser result; other cleanup errors and browser test failures still fail the gate. It exercises more than thirty retained pending and receipt batches across reload, a response lost after durable acceptance followed by a changed browser revision and same-ID recovery, selected task loading at the sixty-retained-ID limit, bounded non-progress retries, and Review geometry at phone/tablet/desktop widths. VM tests cover controls and state transitions; HTTP tests independently cover runtime restart identity, strict provenance rejection and receipt reconciliation across serving revisions. Source-string assertions supplement those behaviors.

The serving process stays pinned to its startup SHA. A dirty source or any moved HEAD returns 503 until restart; imported backend modules cannot acquire a newer advertised identity. Rebind operator-owned preview registry/checkpoint records deliberately. Review POSTs validate the same wire fields in standalone and preview modes. Only the server derives provenance; a standalone unconfigured instance records unknown branch/preview as null rather than claiming Main.

## Durable state and bounded history

Captured review retries are immutable until receipt reconciliation or an explicit target-reviewed conversion following local rejection. A lost response is not proof of failure. Same-ID accepted retries preserve the original receipt/provenance and can repair inbox announcement through the existing idempotent contract. The receipt-store owner must survive a restart; moving to a different checkout without migrating that owner is not proof that an old delivery was absent. Lavish requires operator reconciliation for old-version uncertainty because its contract has no receipt lookup. Session storage is tab-local and finite: save failures warn visibly; closing a tab is never durable delivery. No drafts or receipts are migrated or retired by this source change.

The [source-window contract](../prototype/SESSION-WINDOW.md) owns read budgets, omission disclosures and remaining source-unchanged errors. This protects ordinary single-operator use without pretending to provide large-archive indexing, arbitrary concurrency protection or denial-of-service resistance. Filesystem metadata enumeration remains proportional to inventory size. A cursor/index solution for larger archives is separate work.

## Checks requiring a real private environment

Offline gates do not prove real Firstmate intake/acknowledgement, primary-chat transport, private taxonomy-owner preservation, live quota/billing authorization/freshness, Tailscale ACL/proxy reachability, Lavish receipt recovery or real-device keyboard/touch behavior. Validate these separately against authorized private fixtures or the operator's intended environment. Missing optional integrations remain visibly unavailable, not fabricated success.

Before public transfer, perform the reviewed allowlist/tree export and the private fingerprint disclosure audit described in [public source](PUBLIC-SOURCE.md). Passing synthetic scanner tests and the product-boundary gate does not replace the owner's private audit. Repository access changes, publication, push, merge, deployment, service restart and PWA work are outside this validation gate.

The runtime has no per-user authentication/authorization or tenant isolation; every reachable client is trusted. See [Security](../SECURITY.md). Keep listeners loopback or behind an explicitly controlled private connection. Origin validation is not login protection. Production support, public multi-user isolation, state migration and operational recovery require their own design and acceptance.
