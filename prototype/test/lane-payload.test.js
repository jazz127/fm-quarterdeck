import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactLanes } from "../lane-payload.js";
import { createServer, loadFirstmateHome } from "../server.js";

const MiB = 1024 * 1024;

test("refs representation preserves duplicate occurrences, lane projections and full bodies exactly", () => {
  const shared = { text: "captain turn", recordId: "one" };
  const mixed = { text: "Alpha block", recordId: "mixed:block:0", mixedLaneMessage: {text: "full reply", blocks: [{text: "Alpha block"}, {text: "Beta block"}]} };
  const lanes = [{id: "alpha", messages: [shared, shared, mixed]}, {id: "beta", messages: [{...shared}, {...mixed, text: "Beta block", recordId: "mixed:block:1"}]}];
  const packed = compactLanes(lanes);
  assert.equal(packed.messages.length, 3);
  assert.deepEqual(packed.lanes.map((lane) => ({...lane, messages: lane.messages.map((index) => packed.messages[index])})), lanes);
  assert.deepEqual(packed.lanes[0].messages, [0, 0, 1]);
});

test("bounded first window widens on demand without changing identities or legacy coverage", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lane-window-"));
  t.after(() => rm(home, {recursive: true, force: true}));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state/main-session"), {recursive: true});
  await writeFile(path.join(home, "data/projects.md"), "- Alpha - Synthetic lane\n");
  const file = path.join(home, "state/main-session/source.jsonl");
  const turns = Array.from({length: 160}, (_, i) => JSON.stringify({type: "message", timestamp: new Date(Date.UTC(2030, 0, 1, 0, i)).toISOString(), message: {role: "assistant", content: `Alpha turn ${i}: ${"x".repeat(10000)}`}}));
  await writeFile(file, turns.join("\n") + "\n");
  const load = (windowBytes) => loadFirstmateHome(home, {windowBytes});
  const small = await load(MiB), wide = await load(2 * MiB), legacy = await load(null);
  assert.equal(small.transcript.expandable, true);
  assert.ok(small.transcript.sessions[0].omittedBytes > 0);
  assert.equal(wide.transcript.expandable, false);
  assert.equal(legacy.transcript.windowBytes, undefined);
  assert.equal(legacy.lanes[0].messages.length, 160);
  assert.ok(small.lanes[0].messages.length > 0 && small.lanes[0].messages.length < 160);
  assert.deepEqual(wide.lanes[0].messages.map((m) => m.text), legacy.lanes[0].messages.map((m) => m.text));
  const last = (data) => data.lanes[0].messages.at(-1).recordId;
  assert.equal(last(small), last(wide), "offset IDs remain stable even when the larger window reads the whole file");
  assert.match(small.transcript.note, /search and filters cover loaded records only/);
  assert.match(small.transcript.warnings.join(" "), /older history in this source is not shown/);
});

test("API window and refs are opt-in and bounded; existing callers keep their schema", async (t) => {
  const optionsSeen = [];
  const lanes = [{id: "alpha", messages: [{text: "shared"}]}, {id: "general", messages: [{text: "shared"}]}];
  const server = createServer({}, {
    revisionResolver: {initial: "a".repeat(40), snapshot: async () => "a".repeat(40)},
    lanesReader: async (_, options) => { optionsSeen.push(options); return {source: "synthetic", lanes, transcript: {sessions: []}}; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/lanes`;
  const legacy = await (await fetch(base)).json();
  assert.deepEqual(legacy.lanes, lanes);
  assert.equal(legacy.messages, undefined);
  assert.equal(optionsSeen.at(-1).windowBytes, null);
  const response = await fetch(base + "?format=refs.v1&windowBytes=1&session=task&disk=source");
  assert.equal(response.headers.get("content-encoding"), "gzip", "existing gzip negotiation is retained");
  const packed = await response.json();
  assert.equal(packed.messages.length, 1);
  assert.deepEqual(packed.lanes.map((l) => l.messages), [[0], [0]]);
  assert.equal(optionsSeen.at(-1).windowBytes, MiB);
  assert.deepEqual(optionsSeen.at(-1).sessionIds, ["task"]);
  assert.deepEqual(optionsSeen.at(-1).diskIds, ["source"]);
  await fetch(base + "?windowBytes=999999999");
  assert.equal(optionsSeen.at(-1).windowBytes, 8 * MiB);
  await fetch(base + "?windowBytes=invalid");
  assert.equal(optionsSeen.at(-1).windowBytes, null);
});
