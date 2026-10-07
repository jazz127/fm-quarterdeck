---
name: fm-lanes
description: Wrap every captain-facing message in a high-level project, feature, repository, or General lane block for the Quarterdeck UI. Use whenever composing any output for the captain.
---

# fm-lanes: Project Demuxing

When managing projects, tasks, or distinct workspaces, you MUST use lane tags for ALL your output. This ensures the Quarterdeck UI correctly routes every message to the appropriate visual channel.

## What Constitutes a Lane?

Use at most **two semantic levels**: project/repository first, then a coherent feature or capability theme within it (e.g., `Example-Store-UI`); General is for cross-project updates.
One level (project alone) is fine for small work but becomes too broad for distinct themes; three levels turn implementation slices into noisy captain-facing lanes without improving routing.
An implementation slice, worker, branch, task ID, or isolated copy is not a third lane level.

- **Roll-up related work:** Group parallel UI and API slices serving the same feature under one theme lane, not `[fm-lane crewmate-1]` or `[fm-lane UI-task-A]`.
- **Split execution at boundaries:** Keep one implementation slice together only while it shares one user outcome, target, state owner, authority level, validation matrix, and rollback unit; split when any boundary differs, but roll related slices up under their theme lane.
- **Schedule safely:** Parallelize independent slices only when their semantic dependencies and shared mutable external state allow it; sequence dependent slices or coordinate exclusive state even if files differ, and do not serialize solely because files overlap.
- **Separate copies:** One theme lane can report several concurrent workers, but each worker keeps its own editable copy; grouping never authorizes shared edits.
- **Scale review:** Before assigning a ninth simultaneously active worker to one theme lane, review consolidation or serialization of existing work, whether the theme is too broad and should split into sibling themes, and whether completed workers should be closed.
  This is a review trigger, not an automatic split or merge; historical completed workers do not count as active, while retained unresolved slices should be disclosed separately as cleanup pressure.
  Never share an editable copy, delete preserved work, merge unrelated scope, or add a deeper lane level just to reduce the count.

## Lane Tagging Rules

1. **Unconditional Wrapping:** Every single message, update, or question you output MUST be wrapped in a lane block. Do not leave "orphaned" text outside of these blocks.
2. **Exact Syntax:** Start the block with `[fm-lane <LaneName>]` on its own line, and close the block with `[end <LaneName>]` on its own line.
   Keep blocks syntactically flat: nested tags are not supported by the current standalone-block router and can make streaming, routing, and closure ambiguous.
3. **Naming Convention:** `<LaneName>` must be a single continuous descriptive string (use hyphens instead of spaces) representing the project or its theme (e.g., `Example-Store`, `Example-Store-UI`); use a registered lane name for explicit UI routing.
4. **The General Lane:** For fleet-wide status updates, administrative chatter, or responses that apply globally, use `[fm-lane General]`.
5. **Multiple Lanes:** You may report on multiple distinct projects in a single output by using sequential lane blocks.

## Examples

### Correct Usage (Rolling up multiple crewmates)

[fm-lane Example-Store-UI]
Crewmate 1 has finished the React components in the `frontend` tree. Meanwhile, Crewmate 2 is still working on the CSS grid fixes.
I am reviewing Crewmate 1's work now—would you like me to merge it while we wait on the CSS?
[end Example-Store-UI]

### Correct Usage (Multiple Lanes & General)

[fm-lane General]
All crewmates are healthy and operating within token limits.
[end General]

[fm-lane Database-Migration]
The migration script failed on row 452. The error log is in `scratch/err.log`. Should I have the crew retry?
[end Database-Migration]
