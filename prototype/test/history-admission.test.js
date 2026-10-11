import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer, loadFirstmateHome } from "../server.js";
import { createHistoryReader } from "../history-reader.js";

async function fixture(t, counts = { a: 3200, b: 3200, c: 3200 }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "history-admission-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- example-app - Synthetic history\n");
  let day = 0;
  for (const [id, count] of Object.entries(counts)) {
    await writeFile(path.join(home, "state", `${id}.meta`), "project=example-app\n");
    const file = path.join(home, "state", `${id}.status`);
    await writeFile(file, Array.from({ length: count }, (_, i) => `done: ${id} event ${String(i).padStart(4, "0")}\n`).join(""));
    const clock = new Date(`2026-01-0${++day}T00:00:00Z`);
    await utimes(file, clock, clock);
  }
  return home;
}

async function api(t, home, options) {
  const server = createServer({ FM_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "empty-config") }, options);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (query = "") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lanes${query}`);
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    return { data, lane: data.lanes.find(lane => lane.id === "example-app") };
  };
}

function observedReader(reads, skip = null) {
  const reader = createHistoryReader();
  const recent = reader.recent;
  reader.recent = (file, ...args) => {
    reads.push(path.basename(file));
    return path.basename(file) === skip ? null : recent(file, ...args);
  };
  return reader;
}

for (const query of ["", "?session=c"]) {
  test(`default-limit API keeps newest whole selected events without invisible old reads (${query || "default"})`, async t => {
    const home = await fixture(t);
    const reads = [];
    const read = await api(t, home, { lanesReader: (home, options) => loadFirstmateHome(home, { ...options, reader: observedReader(reads) }) });
    const { lane } = await read(query);
    assert.ok(lane.messages.some(message => message.text === "done: c event 3199"));
    assert.equal(lane.sessions.find(session => session.id === "c").loaded, true);
    assert.equal(lane.sessions.find(session => session.id === "a").loaded, false);
    assert.equal(reads.includes("a.status"), false, "discarded old session must not consume event records");
  });
}

test("unregistered task history cannot consume the visible task event budget", async t => {
  const home = await fixture(t);
  await writeFile(path.join(home, "state/a.meta"), "project=unregistered-app\n");
  await writeFile(path.join(home, "state/a.status"), "working: invisible task\n".repeat(3200));
  const reads = [];
  const read = await api(t, home, { lanesReader: (home, options) => loadFirstmateHome(home, { ...options, reader: observedReader(reads) }) });
  const { lane } = await read("?session=c&session=a");
  assert.ok(lane.messages.some(message => message.text === "done: c event 3199"));
  assert.equal(reads.includes("a.status"), false, "even an explicit ID without a displayed project cannot emit task events");
});

test("omitting only invisible old event reads is the causal budget counterfactual", async t => {
  const home = await fixture(t);
  const reads = [];
  const read = await api(t, home, { lanesReader: (home, options) => loadFirstmateHome(home, { ...options, reader: observedReader(reads, "a.status") }) });
  const { lane } = await read("?session=c");
  assert.ok(lane.messages.some(message => message.text === "done: c event 3199"));
  assert.equal(lane.sessions.find(session => session.id === "c").updatedAt, "2026-01-03T00:00:00.000Z");
});

test("explicit selection admits events before a competing large outcome ledger", async t => {
  const home = await fixture(t, { a: 3200, b: 3200, z: 3200 });
  await writeFile(path.join(home, "state/branch-outcomes.jsonl"), Array.from({ length: 20001 }, (_, i) => JSON.stringify({ epoch: 1700000000 + i, summary: `Outcome ${i}` }) + "\n").join(""));
  const read = await api(t, home);
  const { lane, data } = await read("?session=z");
  assert.ok(lane.messages.some(message => message.text === "done: z event 3199"));
  assert.equal(lane.sessions.find(session => session.id === "z").loaded, true);
  const source = data.transcript.outcomeSources.find(source => source.source === "state/branch-outcomes.jsonl");
  assert.ok(source);
  assert.ok(!source.loaded || source.omittedBytes > 0, "the competing ledger honestly discloses unloaded or trimmed coverage");
  assert.ok(data.transcript.warnings.some(warning => /branch-outcomes.*(?:older outcomes|was not loaded)/.test(warning)));
});

test("genuine retained outcome clocks select recent windows before any discarded event read", async t => {
  const home = await fixture(t, { a: 2, b: 2, c: 2 });
  await writeFile(path.join(home, "state/branch-outcomes.jsonl"), JSON.stringify({ epoch: Date.parse("2026-01-04T00:00:00Z") / 1000, task: "a", summary: "Recent outcome" }) + "\n");
  const reads = [];
  const read = await api(t, home, { lanesReader: (home, options) => loadFirstmateHome(home, { ...options, reader: observedReader(reads) }) });
  const { lane } = await read();
  assert.deepEqual(lane.sessions.filter(session => session.loaded).map(session => session.id), ["a", "c"]);
  assert.equal(lane.sessions[0].updatedAt, "2026-01-04T00:00:00.000Z");
  assert.equal(reads.includes("b.status"), false);
});

test("removing only the retained outcome restores genuine status-clock recent membership", async t => {
  const home = await fixture(t, { a: 2, b: 2, c: 2 });
  const ledger = path.join(home, "state/branch-outcomes.jsonl");
  await writeFile(ledger, JSON.stringify({ epoch: Date.parse("2026-01-04T00:00:00Z") / 1000, task: "a", summary: "Recent outcome" }) + "\n");
  const reads = [];
  const read = await api(t, home, { lanesReader: (home, options) => loadFirstmateHome(home, { ...options, reader: observedReader(reads) }) });
  const before = (await read()).lane;
  assert.equal(before.sessions.find(session => session.id === "a").updatedAt, "2026-01-04T00:00:00.000Z", "the real retained outcome is present before the sole source change");
  await rm(ledger);
  reads.length = 0;
  const { lane } = await read();
  assert.deepEqual(lane.sessions.filter(session => session.loaded).map(session => session.id), ["c", "b"]);
  assert.deepEqual(lane.sessions.map(({ id, updatedAt }) => ({ id, updatedAt })), [
    { id: "c", updatedAt: "2026-01-03T00:00:00.000Z" },
    { id: "b", updatedAt: "2026-01-02T00:00:00.000Z" },
    { id: "a", updatedAt: "2026-01-01T00:00:00.000Z" },
  ], "unchanged status clocks govern recency when only the outcome is removed");
  assert.equal(lane.sessions.find(session => session.id === "a").loaded, false);
  assert.equal(lane.sessions.find(session => session.id === "a").eventCount, 0);
  assert.equal(reads.includes("a.status"), false, "the now-invisible old window is not read");
  assert.equal(lane.messages.filter(message => message.kind === "crew").length, 4);
});

test("registered mate task coverage follows its unread parent status source without losing mtime", async t => {
  const home = await fixture(t, { a: 2 });
  await writeFile(path.join(home, "data/secondmates.md"), "- a - Synthetic mate (home: /synthetic/home-beta; scope: synthetic; projects: example-app; added 2026-01-01)\n");
  const reads = [];
  const read = await api(t, home, { lanesReader: (home, options) => loadFirstmateHome(home, { ...options, reader: observedReader(reads, "a.status") }) });
  const { lane, data } = await read();
  assert.equal(data.transcript.secondmateSources.find(source => source.id === "a").loaded, false);
  const session = lane.sessions.find(session => session.id === "a");
  assert.equal(session.loaded, false);
  assert.equal(session.eventCount, 0);
  assert.equal(session.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(reads.filter(source => source === "a.status").length, 1, "the mate adapter alone attempts the parent source");
  assert.ok(data.transcript.warnings.some(warning => /a: message source not loaded/.test(warning)));
});

test("default-limit API distinguishes unread nonempty from successfully read empty status and retains mtime", async t => {
  const home = await fixture(t, { a: 2 });
  const ledger = path.join(home, "state/branch-outcomes.jsonl");
  await writeFile(ledger, "{}\n".repeat(20001));
  const read = await api(t, home);
  const { lane, data } = await read();
  const session = lane.sessions[0];
  assert.equal(session.loaded, session.eventCount > 0, "this nonempty two-event source is loaded only when its events were actually read");
  assert.equal(session.updatedAt, "2026-01-01T00:00:00.000Z");
  if (session.loaded) {
    assert.ok(lane.messages.some(message => message.text === "done: a event 0001"));
  } else {
    assert.equal(session.eventCount, 0);
    assert.ok(data.transcript.warnings.some(warning => /a.status was not loaded/.test(warning)));
  }
  await rm(ledger);
  const file = path.join(home, "state/a.status");
  await writeFile(file, "");
  await utimes(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  const empty = (await read()).lane.sessions[0];
  assert.equal(empty.loaded, true);
  assert.equal(empty.eventCount, 0);
  assert.equal(empty.updatedAt, session.updatedAt);
});
