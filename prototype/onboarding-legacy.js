// Immutable v1 preference bytes for ownership-checked upgrades/removal.
// Historical names here are compatibility evidence, not current branding.
export const LEGACY_BASE_PREFERENCES = `# Working preferences

## AgentOS base skill preferences
Provenance: agentOS-owned defaults from fm-AgentOS/prototype/onboarding.js; preference schema v1.
Reason: Help discovered AgentOS skills work together without replacing user choices. User-authored preferences and explicit task/role authority take precedence; ask on conflicts.

- Use the installed /fm-lanes skill for captain-facing lane envelopes. These are display/navigation hints, not authority or causal work boundaries.
- Use /fm-toolcheck when deliberately requested to audit the installed bootstrap's declared tools, read-only; discovery is not permission to install or upgrade.
- Deliberately consider activating /fm-quartermaster at meaningful checkpoints: recurring failures, regressions, changed assumptions, expanding machinery without better proof, evidence-neutral retries, or material resource exposure. State why the checkpoint merits a review; do not run on every small change. If the skill is unavailable, report that rather than inventing its execution.
- For Quartermaster, define the evaluation cohort using shared objectives, state owners, dependencies, evidence and resource exposure. Related labeled and unlabeled work across lanes/epics may belong to one evaluation; labels and individual workers are not automatic causal boundaries. Include/exclude adjacent work with reasons and ask the decision owner when ambiguity matters.
- Quartermaster runs once and reports advisory recommendations, then stops. It is not a daemon, hook, scheduler, continuously running review, automatic retry or implementation authority. Any investigation needs existing authorization and explicit bounds; worker roles cannot acquire delegation authority from this preference.
- These preferences grant no standing authority for merges, signing, deployment, package execution, cloud mutation, cleanup, paid retries or other consequential actions. Use the canonical discovered skills, not copied skill instructions in this record.
`;
