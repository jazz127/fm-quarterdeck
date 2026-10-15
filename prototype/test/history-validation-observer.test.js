import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const observer = require("../scripts/history-validation-observer.cjs");
const { PREFIX, WORKER_PREFIX, MAX_EVENTS, MAX_FRAME_BYTES, MAX_SAMPLES, SAMPLE_MS,
  identifyFile, resourceCounts, safeWorkerRecord, observeChild, createEmitter } = observer;
const prototype = fileURLToPath(new URL("..", import.meta.url));

function child() {
  const value = new EventEmitter();
  value.pid = 123;
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  return value;
}
const record = (extra = {}) => ({ event: "resources", file: "test/costs.test.js", pid: 123,
  elapsedMs: 1, resources: [{ kind: "TCPServerWrap", count: 1 }], ...extra });

test("observer allowlists exact source file identities and never exposes arbitrary paths/resource strings", () => {
  assert.equal(identifyFile(fileURLToPath(new URL("./costs.test.js", import.meta.url))), "test/costs.test.js");
  assert.equal(identifyFile("/synthetic-private/test/costs.test.js"), undefined);
  assert.equal(identifyFile("/synthetic-private/record.jsonl"), undefined);
  assert.deepEqual(resourceCounts(["TCPSocketWrap", "TCPSocketWrap", "PRIVATE_INPUT"]),
    [{ kind: "Other", count: 1 }, { kind: "TCPSocketWrap", count: 2 }]);
  assert.equal(resourceCounts(Array(2000).fill("Timeout"))[0].count, 1024);
  assert.deepEqual(safeWorkerRecord(record(), "test/costs.test.js", 123), {
    event: "resources", file: "test/costs.test.js", pid: 123, workerElapsedMs: 1,
    resources: [{ kind: "TCPServerWrap", count: 1 }],
  });
  for (const extra of [{ environment: "PRIVATE_INPUT" }, { body: "PRIVATE_INPUT" }, { argv: ["PRIVATE_INPUT"] },
    { file: "/synthetic-private/test/costs.test.js" }, { pid: 999 }, { event: "PRIVATE_INPUT" },
    { elapsedMs: -1 }, { resources: [{ kind: "PRIVATE_INPUT", count: 1 }] },
    { resources: [{ kind: "Timeout", count: 2000 }] }, { resources: [{ kind: "Timeout", count: 1, path: "PRIVATE_INPUT" }] }]) {
    assert.equal(safeWorkerRecord(record(extra), "test/costs.test.js", 123), null);
  }
});

test("observer preserves separate direct child exit/stdout-end boundaries and sanitizes stderr frames", () => {
  const process = child();
  const events = [];
  observeChild(process, "test/costs.test.js", event => events.push(event));
  process.stderr.emit("data", Buffer.from("PRIVATE_INPUT\n"));
  process.stderr.emit("data", Buffer.from(WORKER_PREFIX + JSON.stringify(record({ environment: "PRIVATE_INPUT" })) + "\n"));
  process.stderr.emit("data", Buffer.from(WORKER_PREFIX + "x".repeat(MAX_FRAME_BYTES * 2)));
  process.stderr.emit("data", Buffer.from("\n" + WORKER_PREFIX + JSON.stringify(record()) + "\n"));
  process.emit("exit", 0, null);
  assert.equal(events.at(-1).event, "child-exit");
  assert.ok(!events.some(event => event.event === "child-stdout-end"));
  process.stdout.emit("end");
  process.emit("close");
  assert.deepEqual(events.map(event => event.event), ["child-start", "resources", "child-exit", "child-stdout-end", "child-close"]);
  assert.deepEqual(events[0].argv, ["node", "test/costs.test.js"], "allowlisted projection, not raw argv");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_INPUT|environment|synthetic-private/);
});

test("observer handles split worker frames, bounds emissions and never changes outcome on output failure", () => {
  const process = child();
  const events = [];
  observeChild(process, "test/costs.test.js", event => events.push(event));
  const frame = WORKER_PREFIX + JSON.stringify(record()) + "\n";
  process.stderr.emit("data", Buffer.from(frame.slice(0, 30)));
  process.stderr.emit("data", Buffer.from(frame.slice(30)));
  assert.equal(events.at(-1).event, "resources");
  const output = [];
  const emit = createEmitter(PREFIX, line => output.push(line));
  for (let i = 0; i < MAX_EVENTS * 2; i++) emit({ event: "resources" });
  assert.equal(output.length, MAX_EVENTS);
  assert.doesNotThrow(() => createEmitter(PREFIX, () => { throw Error("closed output"); })({ event: "resources" }));
  assert.equal(MAX_SAMPLES, 16);
  assert.equal(SAMPLE_MS, 60000);
});

test("hosted observer gate accepts only the original PR synchronize transition on attempt one", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/source-preview.yml", import.meta.url), "utf8");
  const matches = [...workflow.matchAll(/FM_HISTORY_VALIDATION_OBSERVER: \$\{\{ (.+) \}\}/g)];
  assert.equal(matches.length, 1, "only integration receives the opt-in flag");
  const expression = matches[0][1];
  const before = "f3b61268fb58428c3fb7a34ab1aa446e96b01512";
  const original = { event_name: "pull_request", repository: "sthi-1005/fm-quarterdeck", run_attempt: 1,
    event: { action: "synchronize", before, after: "new-validation-commit",
      pull_request: { number: 105, head: { sha: "new-validation-commit", ref: "fm/quarterdeck-configurable-history-limits", repo: { full_name: "sthi-1005/fm-quarterdeck" } } } } };
  const enabled = github => vm.runInNewContext(expression, { github }, { timeout: 100 });
  assert.equal(enabled(original), "1");
  for (const change of [g => { g.event_name = "push"; }, g => { g.event_name = "workflow_dispatch"; },
    g => { g.event.action = "opened"; }, g => { g.event.action = "reopened"; }, g => { g.event.action = "ready_for_review"; },
    g => { g.run_attempt = 2; }, g => { g.event.before = "new-validation-commit"; },
    g => { g.event.pull_request.number = 999; }, g => { g.event.pull_request.head.ref = "another-branch"; },
    g => { g.event.pull_request.head.repo.full_name = "another-owner/repository"; }, g => { g.event.after = "different-sha"; }]) {
    const github = structuredClone(original); change(github);
    assert.equal(enabled(github), "", "dispatch/retry/later update/other sources cannot observe");
  }
  assert.match(workflow, /push:\n    branches: \[main\]/, "one ship-branch push triggers PR only, not a second push workflow");
  assert.match(expression, new RegExp(before));
});

test("opt-in preload observes original Node workers unbuffered; off mode leaves the same neutral assertion intact", () => {
  const preload = fileURLToPath(new URL("../scripts/history-validation-observer.cjs", import.meta.url));
  const fixture = "test/fixtures/history-validation-observer/neutral.cjs";
  for (const enabled of ["", "1"]) {
    const env = { ...process.env, FM_HISTORY_VALIDATION_OBSERVER: enabled };
    // This neutral proof launches a top-level runner, not a nested test worker.
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync(process.execPath, ["--require", preload, "--test", fixture], {
      cwd: prototype, encoding: "utf8", timeout: 10000, env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /neutral observer fixture keeps the original assertion/);
    assert.match(result.stdout, /(?:pass 1|# pass 1)/);
    const events = result.stderr.split("\n").filter(line => line.startsWith(PREFIX)).map(line => JSON.parse(line.slice(PREFIX.length)));
    if (!enabled) { assert.equal(events.length, 0); continue; }
    for (const name of ["child-start", "worker-start", "tests-after", "before-exit", "child-exit", "child-stdout-end", "child-close"]) {
      assert.ok(events.some(event => event.event === name), `${name} reached direct parent output: ${result.stderr}`);
    }
    assert.ok(events.every(event => event.file === "fixture:neutral" && Number.isSafeInteger(event.pid)));
    assert.equal(new Set(events.map(event => event.pid)).size, 1, "same original test worker, no parallel runner");
    assert.doesNotMatch(JSON.stringify(events), /(?:\/home\/|\/tmp\/|environment|PRIVATE_INPUT)/);
  }
});
