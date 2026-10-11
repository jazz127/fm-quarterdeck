import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHistoryReader, HistoryLimitError, resolveHistoryLimits } from "../history-reader.js";
import { createServer } from "../server.js";
import { createTranscriptTurns } from "../bearings-thread.js";
import { createChatAskScanner } from "../chat-asks.js";

const controls = {
  FM_HISTORY_MAX_FILE_BYTES: "maxFileBytes", FM_HISTORY_MAX_TOTAL_BYTES: "maxTotalBytes",
  FM_HISTORY_MAX_LINE_BYTES: "maxLineBytes", FM_HISTORY_MAX_FILES: "maxFiles",
  FM_HISTORY_MAX_RECORDS: "maxRecords", FM_HISTORY_MAX_MESSAGES: "maxMessages",
};
const MiB = 1024 * 1024;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.jsonl");
  await writeFile(file, "abc\ndef\n");
  return { root, file };
}
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const revision = "a".repeat(40);
const serverOptions = { revisionResolver: { initial: revision, snapshot: async () => revision } };

test("startup history controls resolve supplied decimal safe integers only and freeze the snapshot", () => {
  const defaults = resolveHistoryLimits({ FM_HISTORY_WINDOW_RESERVE_BYTES: "0" });
  assert.deepEqual(defaults, {}, "unset keys leave every consumer's defaults intact; no reserve control");
  assert.ok(Object.isFrozen(defaults));
  const env = {};
  const expected = {};
  let n = 0;
  for (const [variable, key] of Object.entries(controls)) { env[variable] = String(n); expected[key] = n++; }
  const limits = resolveHistoryLimits(env);
  assert.deepEqual(limits, expected);
  assert.ok(Object.isFrozen(limits));
  env.FM_HISTORY_MAX_FILES = "999";
  assert.equal(limits.maxFiles, expected.maxFiles);
  assert.throws(() => { limits.maxFiles = 999; }, TypeError);
  for (const [variable, key] of Object.entries(controls)) {
    assert.equal(resolveHistoryLimits({ [variable]: "0" })[key], 0);
    assert.equal(resolveHistoryLimits({ [variable]: String(Number.MAX_SAFE_INTEGER) })[key], Number.MAX_SAFE_INTEGER);
    for (const value of ["", " ", "abc", "NaN", "Infinity", "-1", "1.5", "9007199254740992", "1e3", "0x10", "+1", " 1 "]) {
      assert.throws(() => createServer({ [variable]: value }), error =>
        error.message.includes(variable) && error.message.includes("non-negative safe integer"), `${variable}=${JSON.stringify(value)}`);
    }
  }
});

test("invalid history configuration rejects the executable before it listens", () => {
  const result = spawnSync(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10000,
    env: { ...process.env, FM_HISTORY_MAX_RECORDS: "-1", PORT: "0" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /FM_HISTORY_MAX_RECORDS must be a non-negative safe integer/);
  assert.doesNotMatch(result.stdout, /http:\/\//);
});

test("unset standard budgets and window reserve remain unchanged", async t => {
  const { file } = await fixture(t);
  const reader = createHistoryReader(resolveHistoryLimits({}));
  assert.equal(reader.windowBudget(), 8 * MiB);
  assert.equal(await reader.text(file), "abc\ndef\n");
  for (let i = 0; i < 20000; i++) reader.takeMessage();
  assert.throws(() => reader.takeMessage(), HistoryLimitError);
  await writeFile(file, "x".repeat(MiB + 1));
  await assert.rejects(createHistoryReader(resolveHistoryLimits({})).text(file), HistoryLimitError);
});

test("every explicit control (including zero) reaches fresh lanes readers and is resolved once at startup", async t => {
  const { file } = await fixture(t);
  for (const variable of Object.keys(controls)) {
    for (const value of ["0", "1"]) {
      let reads = 0;
      const env = { get [variable]() { reads++; return value; } };
      const readers = [];
      const server = createServer(env, { ...serverOptions, lanesReader: async (_home, { reader }) => {
        readers.push(reader);
        if (variable === "FM_HISTORY_MAX_MESSAGES") {
          if (value === "1") reader.takeMessage();
          assert.throws(() => reader.takeMessage(), HistoryLimitError);
        } else if (variable === "FM_HISTORY_MAX_FILES" && value === "1") {
          await reader.text(file);
          await assert.rejects(reader.text(file), HistoryLimitError);
        } else await assert.rejects(reader.text(file), HistoryLimitError);
        return { lanes: [], transcript: {} };
      } });
      // Lifecycle receives its existing env copy too; neither it nor history
      // configuration may consult this getter again during API reads.
      const startupReads = reads;
      const base = await listen(t, server);
      for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/api/lanes`)).status, 200);
      assert.equal(reads, startupReads, `${variable} is not reread per request`);
      assert.notStrictEqual(readers[0], readers[1], "budgets are per request, not per server");
    }
  }
  assert.equal(await readFile(file, "utf8"), "abc\ndef\n");
});

test("real lanes, dashboard and work-state consumers use the same startup snapshot", async t => {
  const { root } = await fixture(t);
  const home = path.join(root, "home");
  await mkdir(path.join(home, "data"), { recursive: true });
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- example-app - Synthetic history\n");
  const env = { FM_HOME: home, FM_QUARTERDECK_STATE_PATH: path.join(root, "state.json"), FM_HISTORY_MAX_FILE_BYTES: "1" };
  const base = await listen(t, createServer(env, serverOptions));
  env.FM_HISTORY_MAX_FILE_BYTES = "9007199254740992";
  for (const route of ["/api/lanes", "/api/dashboard", "/api/work-state"]) {
    const response = await fetch(`${base}${route}`, route === "/api/work-state" ? {
      method: "POST", headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ action: "classify", taskFingerprint: "a".repeat(64) }),
    } : {});
    assert.equal(response.status, 503, route);
    assert.match((await response.json()).error, /History exceeds safe read limits/);
  }
});

test("server-created thread and chat-ask readers inherit startup overrides", async t => {
  const { root } = await fixture(t);
  const home = path.join(root, "home");
  await mkdir(path.join(home, "state"), { recursive: true });
  await mkdir(path.join(home, "bin"));
  await writeFile(path.join(home, "bin/fm-inbox.sh"), '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"schema":"fm-inbox-receipts.v1","pending":[],"handled":[],"replies":[]}\'\n', { mode: 0o700 });
  await writeFile(path.join(home, "state/.main-session"), "state/primary.jsonl\n");
  await writeFile(path.join(home, "state/primary.jsonl"), Array.from({ length: 6 }, (_, i) => JSON.stringify({
    type: "message", timestamp: "2030-01-02T10:00:00Z", message: { role: "assistant", content: `synthetic-task turn ${i}` },
  }) + "\n").join(""));
  for (const limits of [{ FM_HISTORY_MAX_RECORDS: "4" }, { FM_HISTORY_MAX_FILES: "0" }]) {
    const env = { FM_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, "empty-config"),
      FM_QUARTERDECK_STATE_PATH: path.join(root, `${Object.keys(limits)[0]}.json`), ...limits };
    const base = await listen(t, createServer(env, serverOptions));
    const response = await fetch(`${base}/api/bearings/thread?key=decision:synthetic-task`);
    const thread = await response.json();
    assert.equal(response.status, 200, JSON.stringify(thread));
    if (limits.FM_HISTORY_MAX_RECORDS) {
      assert.equal(thread.transcript.state, "ready");
      assert.equal(thread.transcript.windowed, true);
      assert.deepEqual(thread.entries.map(entry => entry.text), ["synthetic-task turn 3", "synthetic-task turn 4", "synthetic-task turn 5"]);
    } else {
      assert.equal(thread.transcript.state, "unavailable");
      const bearings = await (await fetch(`${base}/api/bearings`)).json();
      assert.equal(bearings.chat.state, "unavailable");
      assert.match(bearings.chat.error, /History exceeds safe read limits/);
    }
  }
});

test("thread and chat-ask discovery receive configured readers, including zero", async t => {
  const { file } = await fixture(t);
  const historyLimits = resolveHistoryLimits({ FM_HISTORY_MAX_FILES: "0" });
  let discoveries = 0;
  const discover = async (_home, { reader }) => {
    discoveries++;
    await assert.rejects(reader.text(file), HistoryLimitError);
    return { sources: [], warnings: [] };
  };
  assert.deepEqual(await createTranscriptTurns({ home: "/synthetic/home", discover, historyLimits })(), { turns: [], omitted: false });
  const scanner = createChatAskScanner({ home: "/synthetic/home", discover, historyLimits });
  await scanner.scan();
  assert.equal(scanner.view().state, "ready");
  assert.equal(discoveries, 2);
});

test("specialized thread defaults stay intact; explicit overrides take precedence without making zero unlimited", async t => {
  const { file } = await fixture(t);
  const discover = async () => ({ sources: [{ file, source: "primary", origin: "pi" }] });
  const turns = historyLimits => createTranscriptTurns({ home: "/synthetic/home", discover, historyLimits });
  const text = "x".repeat(MiB + 1);
  const record = JSON.stringify({ type: "message", message: { role: "assistant", content: text } });
  await writeFile(file, record + "\n");
  assert.equal((await turns(resolveHistoryLimits({}))()).turns[0].text, text, "thread retains its 2 MiB line default and zero byte reserve");
  await assert.rejects(turns(resolveHistoryLimits({ FM_HISTORY_MAX_LINE_BYTES: String(MiB) }))(), HistoryLimitError);
  await assert.rejects(turns(resolveHistoryLimits({ FM_HISTORY_MAX_FILES: "0" }))(), HistoryLimitError);
  for (const variable of ["FM_HISTORY_MAX_FILE_BYTES", "FM_HISTORY_MAX_TOTAL_BYTES", "FM_HISTORY_MAX_RECORDS"]) {
    const found = await turns(resolveHistoryLimits({ [variable]: "0" }))();
    assert.deepEqual(found, { turns: [], omitted: true }, `${variable}=0 leaves window unread, not unlimited`);
  }
  await writeFile(file, Array.from({ length: 16000 }, () => JSON.stringify({ type: "message", message: { role: "assistant", content: "synthetic turn" } }) + "\n").join(""));
  const all = await turns(resolveHistoryLimits({}))();
  assert.equal(all.turns.length, 16000, "thread retains its 200000-record default, not standard 20000 less reserve");
  const capped = await turns(resolveHistoryLimits({ FM_HISTORY_MAX_RECORDS: "4" }))();
  assert.equal(capped.turns.length, 3, "existing quarter-record reserve remains derived from the override");
  assert.equal(capped.omitted, true);
});
