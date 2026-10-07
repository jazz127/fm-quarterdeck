import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHistoryReader, HistoryLimitError } from "../history-reader.js";

test("history budgets bound bytes, lines, records and file count without changing inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.jsonl");
  await writeFile(file, "abc\ndef\n");
  assert.equal(await createHistoryReader().text(file), "abc\ndef\n");
  for (const options of [{ maxFileBytes: 7 }, { maxTotalBytes: 7 }, { maxLineBytes: 2 }, { maxRecords: 1 }, { maxFiles: 0 }]) {
    await assert.rejects(createHistoryReader(options).text(file), HistoryLimitError);
  }
  const shared = createHistoryReader({ maxTotalBytes: 12 });
  await shared.text(file);
  await assert.rejects(shared.text(file), HistoryLimitError);
  assert.equal(await createHistoryReader().text(file), "abc\ndef\n", "limits never edit source");
});
