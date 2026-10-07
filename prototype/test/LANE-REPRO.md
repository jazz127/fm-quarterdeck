# Synthetic mixed-block lane regression

Register `fm-quarterdeck`, `lavish-axi` and `Example Store` in a temporary home's `data/projects.md`. Write one synthetic assistant turn with two standalone blocks, separated by a blank line: `[fm-lane Quarterdeck]` / `[end Quarterdeck]`, then `[fm-lane Lavish]` / `[end Lavish]`.

Expected: two independent API projections, preserving source/time and distinct derived record IDs, with original-message display context. Neither project block belongs to General. Fleet Chats shows one reply: deselecting either lane collapses its block behind a lane/preview/line-count button while the selected block remains expanded. All expands both blocks. Click or focus the button and press Enter/Space to toggle it; check `aria-expanded` and the controlled content's visibility. Reverse the blocks and use `Quarterdeck` to exercise the other public product alias. Exact registered names, explicit General, malformed closing markers, hostile HTML and mirrored turns have separate cases in `lane-markers.test.js`.

Alias resolution precedes legacy project-text matching. Unknown or incomplete envelopes retain the legacy routing path. Projection never edits the original transcript. These invented records reproduce the routing contract without live session filenames, private bodies or installation evidence.
