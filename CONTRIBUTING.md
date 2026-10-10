# Contributing to fm-quarterdeck

Bug reports, documentation improvements, tests and focused fixes are welcome in the designated public source-preview repository once the owner opens it for contributions. This private development repository remains private. These guidelines prepare that public workflow; they do not authorize publishing this repository or its history. Maintainers must complete the [contribution setup checklist](docs/OPEN-SOURCE-CONTRIBUTIONS.md) before opening the public workflow.

Read [README](README.md) for the product and runtime contracts, [governance](GOVERNANCE.md) for decision ownership, and the [code of conduct](CODE_OF_CONDUCT.md) for participation expectations. Contributions are submitted under the project's [MIT License](LICENSE). Submit only work you have permission to contribute, preserve attribution, and document the source/license of third-party code or assets in [notices](THIRD-PARTY-NOTICES.md). No separate contributor agreement or sign-off requirement is currently imposed.

## Report a problem or propose a change

Search existing issues and pull requests first. Use the bug report form with the affected commit, Node/OS/browser versions, expected and actual behavior, and a minimal synthetic reproduction. Use the feature form to explain the problem and proposed scope. Discuss architecture changes, dependencies, integrations and broad refactors before implementing them; small fixes and documentation corrections can go straight to a pull request.

Security vulnerabilities belong in the confidential reporting route in [SECURITY](SECURITY.md). Never attach private transcripts, account data, receipts, credentials, home paths or screenshots containing personal information to issues or pull requests. Use synthetic fixtures and inspect logs before sharing them.

## Develop locally

Use Git, maintained Node **24 LTS** with npm, Python 3, and Linux or WSL for the full validation baseline. Chromium or a compatible Chrome binary is required for browser checks. A real Firstmate installation is required to operate the product with a live fleet, but offline contributor tests use synthetic homes and do not require it or account tools. Do not call live account APIs during offline validation. [Portability](docs/PORTABILITY.md) lists runtime and integration prerequisites.

Fork the designated public repository, clone your fork, and create a topic branch from its current default branch. Open pull requests against that default branch unless a maintainer requests another target. Internal `uat`/preview/deployment branches are governed separately by the [branch contract](docs/branching-and-preview-model.md).

From the repository root:

```bash
cd prototype
npm ci --ignore-scripts --no-audit --no-fund
npm test
cd ..
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s expenses
node --test test/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
python3 scripts/check-source-syntax.py
python3 scripts/check-product-boundary.py
```

Stage new/deleted source files before the boundary check so it includes them. Full suites create isolated synthetic Git repositories and ephemeral local processes; run them in your own authorized development environment.

For browser behavior, commit the candidate locally, then run:

```bash
cd prototype
CHROMIUM=/absolute/path/to/chromium npm run test:browser
```

The server requires a clean committed checkout and pins its startup revision. Commit candidate changes before runtime/browser verification and restart after any commit or branch change. A 503 from a dirty checkout or changed HEAD is an identity guard, not a reason to disable it. [First run](docs/FIRST-RUN.md) and [README](README.md) explain launch setup; use a disposable synthetic home/state owner for experiments, with listeners kept on loopback.

## Prepare a pull request

- Keep one coherent change per pull request. Explain the problem, resulting behavior and any contract or migration impact using the PR template.
- For behavior fixes, include a regression that fails before the fix and passes after it. Exercise reload, retries, delivery identity and long histories when affected. Source-string assertions alone do not establish browser behavior; run the browser gate for UI changes and include relevant viewport evidence.
- Preserve the application in `prototype/`, file/integration contracts, private state ownership and graceful handling of unavailable integrations. PWA work, framework migrations and public multi-user hosting are outside the current source-preview scope.
- Keep private runtime files, generated profiles, logs, credentials, local Git metadata and task scratch out of the diff. Use `git diff --check` and inspect both staged and unstaged changes.
- List commands actually run and results. Mark unavailable real-environment checks explicitly; never equate synthetic acceptance with live Firstmate integration or production readiness.

The **Source preview checks** workflow runs once per pull-request update and on pushes to `main`. Its required `validate` job runs deterministic application tests plus repository, expense, source-boundary and privacy checks. The separate advisory `browser` job runs real-process suites and Chromium checks. See the [CI split and tracked flake quarantine rule](docs/SOURCE-PREVIEW-VALIDATION.md#flake-quarantine-backlog); every suite remains in CI. Documentation-only changes should still pass the repository checks; state when product tests were not rerun. CI has no deployment or publishing step.

## Review and integration

The repository owner or a designated maintainer triages submissions, may request changes, and decides whether to merge. Wait for CI and maintainer approval; resolve review conversations and update tests/docs with the implementation. New commits may require another review. Passing checks is evidence, not a merge promise or a supported release.

Maintainers review privacy, licensing/attribution, backward compatibility and test evidence as well as code. Publishing source, deploying services and changing real operator state require separate decisions. See the [maintainer setup and review checklist](docs/OPEN-SOURCE-CONTRIBUTIONS.md).
