import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("recent windows keep only whole newest records, report omitted bytes and respect the request byte and record budgets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.jsonl");
  const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i},"pad":"${"x".repeat(80)}"}`);
  await writeFile(file, lines.join("\n") + "\n");
  const options = { maxFileBytes: 300, maxLineBytes: 200, windowReserveBytes: 0 };
  const read = async (reader) => {
    const window = await reader.recent(file);
    const records = [];
    for await (const entry of window.lines) if (entry.line) records.push(entry);
    return { window, records };
  };
  const { window, records } = await read(createHistoryReader(options));
  assert.ok(window.omittedBytes > 0 && window.totalBytes === Buffer.byteLength(lines.join("\n") + "\n"));
  assert.deepEqual(records.map(({ line }) => JSON.parse(line).n), [7, 8, 9], "partial leading record is dropped, never parsed");
  const whole = await readFile(file, "utf8");
  for (const { line, offset } of records) assert.equal(whole.slice(offset, offset + line.length), line, "offsets address the source bytes");
  const small = await read(createHistoryReader({ maxFileBytes: 1024 }));
  assert.equal(small.window.omittedBytes, 0);
  assert.equal(small.records.length, 10, "a source within the window is read whole");
  const shared = createHistoryReader({ ...options, maxTotalBytes: 450 });
  await shared.recent(file);
  assert.equal(await shared.recent(file), null, "a window that cannot hold one record is left unread");
  await assert.rejects(shared.text(file), HistoryLimitError, "whole-file reads keep the total bound");
  const counted = createHistoryReader({ maxRecords: 6, windowReserveRecords: 2 });
  const capped = await read(counted);
  assert.deepEqual(capped.records.map(({ line }) => JSON.parse(line).n), [6, 7, 8, 9], "a record budget keeps the newest records");
  assert.equal(capped.window.omittedBytes, capped.records[0].offset, "records left out are reported as omitted bytes");
  assert.equal(await counted.recent(file), null, "a window with no record budget left is left unread");
  const metadata = path.join(root, "metadata.md");
  await writeFile(metadata, "a\nb\n");
  assert.equal(await counted.text(metadata), "a\nb\n", "the reserve stays available to whole-file reads");
  await assert.rejects(counted.text(metadata), HistoryLimitError, "whole-file reads keep the record bound");
});

test("concurrent windows recheck record exhaustion and retain only newest whole records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [path.join(root, "a.status"), path.join(root, "b.status")];
  for (const ending of ["", "\n"]) {
    await Promise.all(files.map(file => writeFile(file, `old\nmiddle\nnewest${ending}`)));
    for (const allowance of [3, 4]) {
      const reader = createHistoryReader({ maxRecords: allowance + 2, windowReserveRecords: 2 });
      const windows = await Promise.all(files.map(file => reader.recent(file)));
      const retained = await Promise.all(windows.map(async window => {
        if (!window) return [];
        const entries = [];
        for await (const entry of window.lines) if (entry.line) entries.push(entry);
        return entries;
      }));
      assert.deepEqual(retained.map(entries => entries.length).sort(), [allowance - 3, 3]);
      if (allowance === 3) assert.equal(windows.filter(window => window === null).length, 1, "a concurrently exhausted source is unloaded");
      for (const entries of retained) {
        if (!entries.length) continue;
        assert.deepEqual(entries.map(entry => entry.line), entries.length === 3 ? ["old", "middle", "newest"] : ["newest"]);
        assert.equal(entries.at(-1).offset, 11, "the newest record keeps its original byte position");
      }
      assert.equal(await reader.recent(files[0]), null);
      const metadata = path.join(root, "metadata.md");
      await writeFile(metadata, "a\nb\n");
      assert.equal(await reader.text(metadata), "a\nb\n", "concurrent windows leave the whole-file reserve intact");
    }
  }
});
