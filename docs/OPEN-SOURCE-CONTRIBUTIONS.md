# Opening and maintaining public contributions

The contribution files prepare the future public source-preview repository. The current repository stays private; no settings, publication or access changes are implied. Source-controlled templates and CI cannot enforce GitHub review rules by themselves. Repository-owner setup below remains pending until the separately authorized public repository exists.

## Before inviting contributions

- Complete the independently reviewed [history-free source release](HISTORY-FREE-EXPORT.md), attribution and disclosure gates. Copy the reviewed tracked files into the separate repository with clean history; do not transfer runtime state or old Git metadata.
- Put CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, the issue forms, PR template and test workflow on the public default branch. Enable Issues and Actions. Exercise both issue forms and a draft fork PR with synthetic data to confirm rendering and CI behavior.
- Enable [GitHub Private Vulnerability Reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository), verify the reporting flow, and update SECURITY.md to identify the actual available channel. Publish a confidential conduct contact and an alternative contact for complaints involving that maintainer in CODE_OF_CONDUCT.md. Do not advertise untested or invented contacts.
- Protect the public default branch with an active [ruleset or branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): require a PR, at least one approval by a maintainer with review authority, resolved conversations and the passing `validate` job from **Source preview checks**. Select the actual check emitted by the first workflow run; do not guess a status context. Require the branch to be up to date, dismiss stale approvals after changes, block force pushes/deletion and avoid routine bypasses. Verify that a failing check and an unapproved PR cannot merge. A sole maintainer's own PR needs another authorized reviewer under this policy.
- Keep Actions permissions read-only and fork contributions unprivileged. The existing workflow uses `pull_request`, does not persist checkout credentials, and needs no repository secrets or deployment credentials. Review workflow/dependency changes carefully; never execute fork code in a privileged `pull_request_target` job. Approve first-time contributor workflow runs only after inspecting the submitted code.
- Record actual maintainer accounts and review areas in GOVERNANCE.md once designated. Add `.github/CODEOWNERS` only with verified accounts/teams that have repository write access, then enable required code-owner review if used. No private-repository identity or invented public owner is embedded in the preparation tree.

These are administrator steps, not settings already applied. Do not open contributions while confidential reporting or required review/check enforcement is missing. Recheck enforcement after changes to workflow names, branch names, maintainer access or repository rules.

## Triage and review

The owner or designated maintainer checks duplicates, asks for synthetic reproduction, identifies scope and indicates whether a proposal is suitable. Optional labels such as `bug`, `enhancement`, `documentation` and `good first issue` can be created by maintainers; the forms do not depend on labels, organization projects or bots. Use `good first issue` only when scope and acceptance criteria are clear.

For each PR, inspect code and test evidence, licensing/provenance and disclosure risk. Preserve interfaces, operator-owned state and graceful optional-integration failure. Request behavioral regressions for confirmed defects and browser evidence for UI changes. State which real Firstmate checks remain unavailable. CI passing does not replace review or the independent source-publication gate.

Resolve conversations, obtain current approval and passing checks, then let an authorized maintainer integrate the change. Explain rejected or deferred proposals courteously. Security reports stay confidential through SECURITY.md. Deployments, service changes, public releases and integration into internal UAT remain separate owner decisions under the [branch contract](branching-and-preview-model.md).

## Current preparation status

The contribution guide, conduct policy, issue forms, PR template and offline Node 24/Python/Chromium workflow are source-controlled. GitHub UI rendering, fork execution, branch enforcement, public maintainer accounts and confidential contacts require the future public repository and have not been verified by these local changes. There is no promised maintainer response time, release schedule or production support window.
