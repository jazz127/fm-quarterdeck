import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSnapshotRunner, normalizeSnapshot } from "../../bearings.js";

export const prefixReason = "Yes/No: archive the sample notes in an isolated sandbox. No production data touched.";

// Exercise the selected-home canonical decoder and supplementation, not a fabricated
// provenance field on a normalizer input. Never reads or answers a real hold.
export async function prefixHold({ reason = prefixReason, row = {}, metadata = "", body = "", board = null, checked = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-prefix-"));
  try {
    for (const dir of ["bin", "data"]) await mkdir(path.join(home, dir));
    const snapshot = { schema: "fm-bearings.v1", generated: "2030-01-02T11:00:00Z",
      decisions_open: [{ id: "sample-call", owner: "(main)", summary: "Yes/No: archive the sample…", ...row }],
      contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] };
    const encoded = Buffer.from(reason).toString("base64");
    const ledger = `# Synthetic backlog\n- [${checked ? "x" : " "}] sample-call - Archive sample notes (hold: fm-hold-v1:${encoded}) (hold-kind: captain) ${metadata}\n  Captain hold set: 2030-01-02T10:00:00Z\n${body}`;
    await writeFile(path.join(home, "data/backlog.md"), ledger);
    await writeFile(path.join(home, "snapshot.json"), JSON.stringify(snapshot));
    await writeFile(path.join(home, "bin/fm-bearings-snapshot.sh"), '#!/bin/sh\ncat "$FM_HOME/snapshot.json"\n');
    await chmod(path.join(home, "bin/fm-bearings-snapshot.sh"), 0o755);
    if (board) {
      await mkdir(path.join(home, ".lavish"));
      await writeFile(path.join(home, ".lavish/bearings-board.html"), `<script id="bearings-data" type="application/json">${JSON.stringify(board).replaceAll("<", "\\u003c")}</script>`);
    }
    const raw = JSON.parse(await createSnapshotRunner(home)());
    assert.equal(await readFile(path.join(home, "data/backlog.md"), "utf8"), ledger, "read-only ledger");
    return { raw, model: { ...normalizeSnapshot(raw), state: "ready" }, ledger };
  } finally { await rm(home, { recursive: true, force: true }); }
}
