import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProjectDirectory } from "../claude-transcript.js";
import { createHistoryReader, HistoryLimitError } from "../history-reader.js";
import { createServer } from "../server.js";

const MiB = 1024 * 1024;
const turn = (text, timestamp = "2026-10-01T00:00:00Z") => JSON.stringify({ type: "assistant", timestamp,
  message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
// Ignored ordinary metadata keeps size independent of message count/content.
const paddingBase = JSON.stringify({ type: "system", padding: "" });
const paddingRecord = paddingBase.slice(0, -2) + "x".repeat(4096 - Buffer.byteLength(paddingBase) - 1) + '"}\n';
function transcript(size) {
  const newest = turn("acme retained reply") + turn("acme newest reply", "2026-10-01T00:01:00Z");
  const old = paddingRecord.repeat(Math.floor((size - Buffer.byteLength(newest)) / 4096));
  const gap = size - Buffer.byteLength(old) - Buffer.byteLength(newest);
  return old + " ".repeat(gap - 1) + "\n" + newest;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-large-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), config = path.join(root, "claude");
  await mkdir(path.join(home, "data"), { recursive: true });
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- acme - example-app\n");
  await writeFile(path.join(home, "state/.lock-session"), "synthetic-main\n");
  const directory = claudeProjectDirectory(config, home);
  await mkdir(directory, { recursive: true });
  return { home, config, file: path.join(directory, "synthetic-main.jsonl") };
}

const entries = async (window) => {
  const result = [];
  for await (const entry of window.lines) if (entry.line.trim()) result.push(entry);
  return result;
};

test("actual 8 MiB reader boundary retains newest whole records within byte and record budgets", async (t) => {
  const { file } = await fixture(t);
  for (const size of [8 * MiB - 1, 8 * MiB, Math.floor(8.6 * MiB)]) {
    const source = transcript(size);
    const sourceBytes = Buffer.from(source);
    await writeFile(file, source);
    for (const budget of [MiB, 8 * MiB]) {
      // The real per-file/line/record bounds, with an observable total-byte budget.
      const reader = createHistoryReader({ maxTotalBytes: 8 * MiB, windowReserveBytes: 0 });
      const window = await reader.recent(file, budget);
      assert.equal(8 * MiB - reader.windowBudget(), Math.min(size, budget), "actual bytes charged are bounded");
      assert.equal(window.totalBytes, size);
      assert.equal(window.omittedBytes > 0, size > budget);
      const retained = await entries(window);
      assert.equal(JSON.parse(retained.at(-1).line).message.content[0].text, "acme newest reply");
      assert.ok(retained.length <= 20000);
      for (const { line, offset } of retained) {
        assert.equal(sourceBytes.subarray(offset, offset + Buffer.byteLength(line)).toString(), line);
        assert.ok(Buffer.byteLength(line) <= MiB);
      }
    }
    if (size > 8 * MiB) await assert.rejects(createHistoryReader().text(file), HistoryLimitError);
    else assert.equal(Buffer.byteLength(await createHistoryReader().text(file)), size);
  }
  await writeFile(file, turn("x".repeat(MiB)));
  await assert.rejects(createHistoryReader().recent(file), HistoryLimitError, "retained oversized single records still fail");
  await writeFile(file, "{}\n".repeat(20001));
  await assert.rejects(createHistoryReader().recent(file), HistoryLimitError, "retained records still obey the request bound");
});

test("actual Claude /api/lanes stays fresh at and above 8 MiB, including append and partial-tail rereads", async (t) => {
  const { home, config, file } = await fixture(t);
  const server = createServer({ FM_HOME: home, CLAUDE_CONFIG_DIR: config });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/lanes`;
  const read = async (query = "") => {
    const response = await fetch(base + query);
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    const messages = data.messages || data.lanes.flatMap(lane => lane.messages);
    return { data, messages: [...new Map(messages.map(message => [message.recordId, message])).values()] };
  };
  let recordId;
  for (const size of [8 * MiB - 1, 8 * MiB, Math.floor(8.6 * MiB)]) {
    await writeFile(file, transcript(size));
    for (const query of ["", "?windowBytes=1048576&format=refs.v1", "?windowBytes=8388608"]) {
      const { data, messages } = await read(query);
      assert.deepEqual(messages.map(message => message.text), ["acme retained reply", "acme newest reply"]);
      const session = data.transcript.sessions[0];
      assert.equal(session.id, "claude-main-session/synthetic-main.jsonl");
      assert.equal(session.loaded, true);
      assert.equal(session.skippedRecords, 0);
      assert.equal(session.omittedBytes > 0, size > (query.includes("1048576") ? MiB : 8 * MiB));
      if (session.omittedBytes) assert.ok(data.transcript.warnings.some(w => /older history in this source is not shown/.test(w)));
      assert.equal(data.transcript.expandable, query.includes("1048576"));
      recordId = messages.at(-1).recordId;
    }
  }
  const appended = turn("acme appended reply", "2026-10-01T00:02:00Z");
  await appendFile(file, appended.slice(0, -10));
  const partial = await read("?windowBytes=1048576&format=refs.v1");
  assert.equal(partial.data.transcript.sessions[0].skippedRecords, 1, "partial JSON is skipped, never reconstructed");
  assert.equal(partial.messages.at(-1).recordId, recordId);
  await appendFile(file, appended.slice(-10));
  const completed = await read("?windowBytes=1048576&format=refs.v1");
  assert.equal(completed.data.transcript.sessions[0].skippedRecords, 0);
  assert.equal(completed.messages.at(-1).text, "acme appended reply");
  assert.equal(completed.messages.find(m => m.text === "acme newest reply").recordId, recordId);
  await writeFile(file, turn("x".repeat(MiB)));
  let response = await fetch(base);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /History exceeds safe read limits/);
  await writeFile(file, "{}\n".repeat(20001));
  response = await fetch(base);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /History exceeds safe read limits/);
});
