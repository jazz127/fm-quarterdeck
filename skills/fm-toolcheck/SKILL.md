---
name: fm-toolcheck
description: Read-only audit of Kunchenguid-owned tools declared by installed Firstmate bootstrap; no upgrades.
user-invocable: true
---

# /fm-toolcheck

This is a Quarterdeck-owned Firstmate integration, not an upstream Firstmate skill. Run `node <Quarterdeck-skill-directory>/audit.mjs --firstmate-root <installed-Firstmate-repository>` and present the entire local report. The skill directory is the canonical or projected Quarterdeck directory containing this file; never invoke a same-named script from the Firstmate repository. Ask for the installed Firstmate root if unknown. Optional `--releases` makes bounded GitHub release metadata requests; identify this as network evidence, separate from local evidence. Do not interpret an unavailable release as current or obsolete.

Only bootstrap-declared tools with explicit Kunchenguid ownership proof qualify. npm name alone is insufficient: an installed manifest must claim the matching GitHub repository (a claim, not integrity proof). General tools, runtime, agent, shell, platform and watched-tool inventories are out of scope. Call out shadowed copies, modified clones, incompatible or unverified compatibility, and unknown integrity. Never call installed wrappers or native binaries for version discovery. Package manifests and static native Go build info claim versions, not verified releases; pseudo-versions are not CLI floor evidence, and features are not executed. A source clone is attributable only at a bounded installed-target ancestor with verified canonical origin; divergence is against cached refs, not network freshness. See `docs/TOOLCHECK.md` in Quarterdeck for the projection, trust boundary and current landing/cleanup status. Never install, update, fetch, change PATH/configuration, switch branches, restart processes, or drive lifecycle behavior. Give a review plan only, not an upgrade command to execute.
