import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFirstmateHome, dashboardData } from "../server.js";
import { emptyAgentState } from "../agent-state.js";
import { parseSecondmates, countSecondmateBacklog, readSecondmates } from "../secondmates.js";
import { createHistoryReader } from "../history-reader.js";
import { endpointIsLive } from "../work-model.js";

const parseMeta = (text) => Object.fromEntries(text.split(/\r?\n/).filter((line) => line.includes("=")).map((line) => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
}));
const options = (probe = async () => null) => ({ reader: createHistoryReader(), parseMeta, probe });

const owner = { read: async () => emptyAgentState() };
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-secondmates-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "# Projects\n- product - Product work\n");
  return home;
}

test("persistent second mates are separate from every work and fleet task projection", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "data/secondmates.md"), `# Second mates\n- navigator - Route planning (home: ${home}; scope: planning; projects: product; added 2026-01-01)\n- parked - Malformed registration\n`);
  await writeFile(path.join(home, "data/backlog.md"), "## In flight\n- [ ] navigator - Persistent planning (repo: product)\n- [ ] helper - Runtime second mate (repo: product)\n- [ ] parked - Persistent registration (repo: product)\n- [ ] slice - Implement second mate display (repo: product)\n");
  for (const id of ["navigator", "helper", "parked", "slice"]) {
    await writeFile(path.join(home, "state", `${id}.meta`), `project=product\n${id === "helper" ? "kind=secondmate\n" : ""}`);
    await writeFile(path.join(home, "state", `${id}.status`), "working [at=1790000000]: progressing\n");
  }
  const data = await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner });
  assert.deepEqual(data.workSplit.items.map((item) => item.id), ["slice"]);
  assert.deepEqual(data.workSplit.tight.inProgress.items.map((item) => item.id), ["slice"]);
  assert.deepEqual(data.lanes.find((lane) => lane.name === "product").items.map((item) => item.title), ["slice"]);
  assert.deepEqual(data.secondmates.items.map((item) => item.id), ["helper", "navigator", "parked"]);
  const dashboard = await dashboardData({ FM_HOME: home }, owner, undefined, async () => ({}));
  assert.deepEqual(dashboard.fleet.secondmates, data.secondmates);
  assert.equal(dashboard.fleet.summary.activeAgents, 0);
  assert.equal(JSON.stringify(data.secondmates).includes(home), false);
});

test("registry parsing preserves exact identities, suffix fields and malformed registrations", () => {
  const entries = parseSecondmates("# Second mates\n- local - Plan (carefully; today) (home: /synthetic/home; scope: code; review; projects: product, tools; added 2026-01-01)\n- remote - Remote planning (host: build-host; root: /synthetic/root; home: /synthetic/remote; scope: review; projects: product; added 2026-01-01)\n- invalid - Bad home (home: relative; scope: code; projects: product; added 2026-01-01)\n- duplicate - First\n- duplicate - Second\n  - nested prose\n");
  assert.deepEqual([...entries.keys()], ["local", "remote", "invalid", "duplicate"]);
  assert.equal(entries.get("local").summary, "Plan (carefully; today)");
  assert.equal(entries.get("local").scope, "code; review");
  assert.equal(entries.get("remote").remote, true);
  assert.match(entries.get("invalid").warning, /malformed/);
  assert.match(entries.get("duplicate").warning, /Duplicate/);
  assert.equal(entries.get("duplicate").home, undefined);
});

test("backlog rollups count open work and explicit captain holds only", () => {
  const text = "## Queued\n- [ ] one - First (hold-kind: captain)\n- [ ] two - Second\n- [ ] mate - Persistent (hold-kind: captain)\n- [x] finished - Complete\n## Done\n- [ ] old - Historic\n## In flight\n- [ ] three - Working\n";
  assert.deepEqual(countSecondmateBacklog(text, new Set(["mate"])), { openWork: 3, captainCalls: 1 });
});

test("synthetic macOS process flags flow through second mate liveness with exact start identity", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "data/backlog.md"), "## Queued\n- [ ] task - Work (hold-kind: captain)\n- [ ] mate - Persistent\n");
  await writeFile(path.join(home, "data/secondmates.md"), `- mate - Review (home: ${home}; scope: quality; projects: product; added 2026-01-01)\n`);
  await writeFile(path.join(home, "state/mate.meta"), "kind=secondmate\nworker_pid=12345\nworker_start_identity=2026-01-01T00:00:00Z\n");
  await writeFile(path.join(home, "state/mate.status"), "working: reviewing\nupdate: bookkeeping\n");
  for (const [flags, expected] of [["Ss+", "live"], ["R<", "live"], ["SX", "live"], ["ZX+", "unreachable"], ["X", "unreachable"]]) {
    const result = await readSecondmates(home, ["mate.meta", "mate.status"], options((meta) => endpointIsLive(meta, { platform: "darwin", run: async () => ({ stdout: `Thu Jan  1 00:00:00 2026 ${flags}\n` }) })));
    assert.equal(result.view.items[0].state, expected);
    assert.deepEqual(result.view.items[0].backlog, { openWork: 1, captainCalls: 1 });
  }
  await writeFile(path.join(home, "state/mate.status"), "paused: waiting\n");
  const idle = await readSecondmates(home, ["mate.meta", "mate.status"], options(async () => true));
  assert.equal(idle.view.items[0].state, "idle");
  assert.equal(idle.view.items[0].stateEvidence, "Process incarnation matches");
});

test("remote registry and metadata markers prevent local probes or backlog reads", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "data/secondmates.md"), `- registry - Remote (host: build-host; root: /synthetic/root; home: ${home}; scope: review; projects: product; added 2026-01-01)\n- conflict - Local registration (home: ${home}; scope: review; projects: product; added 2026-01-01)\n`);
  await writeFile(path.join(home, "state/conflict.meta"), "remote_host=build-host\n");
  await writeFile(path.join(home, "state/runtime.meta"), `kind=secondmate\nbackend=remote\nhome=${home}\n`);
  const result = await readSecondmates(home, ["conflict.meta", "runtime.meta"], options(async () => { assert.fail("Remote endpoints must not be probed locally"); }));
  assert.equal(result.view.items.length, 3);
  for (const mate of result.view.items) {
    assert.equal(mate.state, "not-read");
    assert.equal(mate.backlog, null);
    assert.equal(mate.warning, null);
  }
});

test("missing or unreadable registry keeps runtime identities and reports unknown evidence honestly", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "state/runtime.meta"), "kind=secondmate\n");
  const absent = await readSecondmates(home, ["runtime.meta"], options());
  assert.equal(absent.view.warning, null);
  assert.equal(absent.view.items[0].registered, false);
  assert.equal(absent.view.items[0].state, "unknown");
  await writeFile(path.join(home, "data/secondmates.md"), "x".repeat(256 * 1024 + 1));
  const unavailable = await readSecondmates(home, ["runtime.meta"], options());
  assert.match(unavailable.view.warning, /registry unavailable/);
  assert.deepEqual([...unavailable.ids], ["runtime"]);
  await rm(path.join(home, "data/secondmates.md"));
  const pane = await readSecondmates(home, ["runtime.meta"], options(async () => true));
  assert.match(pane.view.items[0].stateEvidence, /worker process unverified/);
  assert.equal(pane.view.items[0].state, "unknown", "missing status cannot prove an activity state");
});

test("local backlog reads refuse symlinks and oversized ledgers without losing identity", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "data/secondmates.md"), `- mate - Review (home: ${home}; scope: quality; projects: product; added 2026-01-01)\n`);
  const backlog = path.join(home, "data/backlog.md");
  await symlink(path.join(home, "data/projects.md"), backlog);
  let result = await readSecondmates(home, [], options());
  assert.equal(result.view.items[0].backlog, null);
  assert.equal(result.view.items[0].warning, "Local backlog unavailable");
  await rm(backlog);
  await writeFile(backlog, "x".repeat(256 * 1024 + 1));
  result = await readSecondmates(home, [], options());
  assert.equal(result.view.items[0].warning, "Local backlog unavailable");
  assert.deepEqual([...result.ids], ["mate"]);
});

test("display cap excludes every persistent identity from work even when not displayed", async (t) => {
  const home = await fixture(t);
  const ids = Array.from({ length: 65 }, (_, i) => `mate-${String(i).padStart(2, "0")}`);
  await writeFile(path.join(home, "data/secondmates.md"), ids.map((id) => `- ${id} - Persistent registration`).join("\n"));
  await writeFile(path.join(home, "data/backlog.md"), `## Queued\n${ids.map((id) => `- [ ] ${id} - Persistent (repo: product)`).join("\n")}\n`);
  const result = await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner });
  assert.equal(result.secondmates.items.length, 64);
  assert.match(result.secondmates.warning, /64 entries/);
  assert.equal(result.workSplit.items.length, 0);
  assert.equal(result.workSplit.tight.backlog.count, 0);
});
