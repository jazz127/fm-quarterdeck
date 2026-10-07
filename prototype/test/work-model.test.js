import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createAgentStateOwner, emptyAgentState, validateAgentState, fingerprint } from "../agent-state.js";
import { classifyCurrent, projectWork, verifyDurability, endpointIsLive, foldStatusLines } from "../work-model.js";
import { createServer, loadFirstmateHome } from "../server.js";
const lab = path.resolve(import.meta.dirname, "../../.taxonomy-lab");
async function temporary(context) { await mkdir(lab, { recursive: true }); const dir = await mkdtemp(path.join(lab, "test-")); context.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const taxonomy = () => ({ ...emptyAgentState(), repositories: [{ id: "repo", name: "Product", path: "/synthetic/product", lanes: [{ id: "ui", name: "Interface", themes: [{ id: "r1", name: "Review", kind: "iteration" }] }] }] });
const record = (extras = {}) => ({ id: "arbitrary-hyphenated-task", name: "Does not imply a lane", repositoryPath: "/synthetic/product", state: "done", completionIdentity: { line: "done [at=1]: ready", occurrence: 2 }, ...extras });

test("explicit taxonomy validation refuses dangling assignments, duplicates and paths in labels", () => {
  assert.equal(validateAgentState(taxonomy()).repositories.length, 1);
  for (const mutate of [(s) => s.repositories.push(s.repositories[0]), (s) => s.repositories[0].lanes[0].name = "/private/path", (s) => s.repositories[0].lanes[0].themes[0].kind = "epic", (s) => s.assignments[fingerprint("task")] = { repositoryId: "repo", laneId: "missing", themeId: "r1" }, (s) => s.secret = "credential"]) { const state = taxonomy(); mutate(state); assert.throws(() => validateAgentState(state)); }
});

test("current-state classification excludes preserved, completed, dead and unknown workers", () => {
  const input = { inFlight: true, endpointLive: true, state: "working" };
  assert.equal(classifyCurrent(input), "active");
  for (const [extras, expected] of [[{ state: "done" }, "newly-done"], [{ state: "paused" }, "waiting"], [{ state: "blocked" }, "waiting"], [{ state: "needs-decision" }, "captain-action"], [{ retained: true }, "cleanup"], [{ endpointLive: false }, "unknown"], [{ endpointLive: null }, "unknown"], [{ inFlight: false }, "unknown"], [{ queued: true, inFlight: false }, "backlog"]]) assert.equal(classifyCurrent({ ...input, ...extras }), expected);
});

test("taxonomy is three levels with explicit fallback, distinct repositories and no duplicate slices", async () => {
  const state = taxonomy(); const r = record(); const task = fingerprint("task.v1", r.repositoryPath, r.id);
  state.assignments[task] = { repositoryId: "repo", laneId: "ui", themeId: "r1" };
  const model = await projectWork([r, record({ id: "unknown", repositoryPath: null }), record({ id: "legacy", repositoryPath: "/other/product", workGroup: { kind: "theme", name: "Explicit legacy" } })], state);
  assert.equal(model.repositories.length, 3, "same basename is never repository identity");
  assert.equal(model.repositories[0].lanes[0].themes[0].items[0].id, r.id);
  assert.equal(model.items[1].lane.id, "unclassified");
  assert.equal(model.items[1].repositoryId, "unknown");
  assert.equal(model.items[2].lane.id, "unclassified");
  assert.equal(model.items[2].theme.legacy, true);
  assert.equal(new Set(model.items.map((item) => item.taskFingerprint)).size, 3);
  assert.equal(JSON.stringify(model).includes("/synthetic/product"), false);
  const context = { window: {} }; vm.runInNewContext(await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8"), context);
  const tree = context.window.workHierarchy.groupHierarchy(model.items);
  assert.equal(tree[0].lanes.get("ui").themes.get("r1").items.length, 1);
});

test("acknowledgements persist atomically across owners and renew for exact completion or commit", async (context) => {
  const dir = await temporary(context); const file = path.join(dir, "state.json");
  const owner = createAgentStateOwner(file); await owner.update((state) => Object.assign(state, taxonomy()));
  const first = (await projectWork([record()], await owner.read())).items[0];
  const replies = await Promise.all([owner, createAgentStateOwner(file), owner].map((reader) => reader.acknowledge(first.taskFingerprint, first.completionFingerprint)));
  assert.equal(new Set(replies.map((reply) => reply.acknowledgedAt)).size, 1);
  assert.equal(Object.keys((await createAgentStateOwner(file).read()).acknowledgements).length, 1);
  const refreshed = (await projectWork([record()], await owner.read())).items[0];
  assert.equal(refreshed.status, "previously-done"); assert.equal(refreshed.delivery, "Ready for review · deployment unknown");
  assert.equal(refreshed.evidence[0].badge, "acknowledged");
  for (const next of [record({ completionIdentity: { line: "done [at=2]: ready", occurrence: 4 } }), record({ commit: "a".repeat(40) })]) assert.equal((await projectWork([next], await owner.read(), { durability: async () => [] })).items[0].status, "newly-done");
  await writeFile(file, "malformed"); await assert.rejects(owner.acknowledge(first.taskFingerprint, first.completionFingerprint));
  assert.equal(await readFile(file, "utf8"), "malformed", "never overwrite unreadable state");
});

test("remote containment must verify actual advertised head; merge is not live deployment", async () => {
  const commit = "a".repeat(40), head = "b".repeat(40), repo = { path: "/synthetic", github: "owner/product" };
  const calls = [];
  const run = async (command, args) => { calls.push([command, ...args]);
    if (command === "git" && args[0] === "ls-remote") return { stdout: `${head}\t${args.at(-1)}\n` };
    if (command === "git" && args[0] === "merge-base") return { stdout: "" };
    return { stdout: JSON.stringify({ merged: true, merged_at: "2030-01-01T00:00:00Z", merge_commit_sha: commit, base: { repo: { full_name: repo.github }, ref: "main" }, html_url: "https://github.com/owner/product/pull/1" }) };
  };
  const evidence = await verifyDurability(repo, commit, 1, run);
  assert.deepEqual(evidence.map((entry) => entry.badge), ["remote Main", "remote UAT", "merged PR"]);
  assert.ok(calls.some((args) => args.join(" ") === `git merge-base --is-ancestor ${commit} ${head}`));
  assert.ok(!calls.some((args) => args.some((arg) => ["fetch", "push", "checkout"].includes(arg))));
  const model = await projectWork([record({ commit })], taxonomy(), { durability: async () => evidence });
  assert.equal(model.items[0].status, "previously-done"); assert.match(model.items[0].delivery, /deployment unknown/);
  assert.deepEqual(await verifyDurability(repo, commit, null, async () => { throw new Error("stale local head / unavailable actual remote"); }), []);
  assert.deepEqual(await verifyDurability(repo, "uat-ready", 1, run), []);
});

test("live UAT and production require configured destination plus exact successful deployment", async () => {
  const commit = "a".repeat(40); const repo = { path: "/synthetic", github: "owner/product", destinations: [{ environment: "Review UAT", tier: "uat" }, { environment: "Production", tier: "production" }] };
  const run = async (command, args) => {
    if (command === "git") throw new Error("No remote containment");
    if (args[1].includes("/deployments?")) return { stdout: JSON.stringify(args[1].includes("environment=Production") ? [{ id: 2, sha: "b".repeat(40), environment: "Production" }] : [{ id: 1, sha: commit, environment: "Review UAT" }]) };
    return { stdout: JSON.stringify([{ id: 3, state: "success", environment: "Review UAT" }]) };
  };
  const evidence = await verifyDurability(repo, commit, null, run);
  assert.deepEqual(evidence.map((entry) => entry.badge), ["Live UAT"]);
  const model = await projectWork([record({ commit })], taxonomy(), { durability: async () => evidence });
  assert.match(model.items[0].delivery, /Live UAT · ready for review/);
  assert.equal(model.items[0].status, "previously-done");
  assert.deepEqual(await verifyDurability({ ...repo, destinations: [] }, commit, null, run), [], "unconfigured deployments cannot prove live");
});

test("genuine-active review threshold and liveness use exact process incarnation", async () => {
  const proc = await readFile(`/proc/${process.pid}/stat`, "utf8"); const ticks = proc.slice(proc.lastIndexOf(")") + 2).split(" ")[19];
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  assert.equal(await endpointIsLive({ worker_pid: String(process.pid), worker_start_ticks: ticks, worker_boot_id: boot }), true);
  assert.equal(await endpointIsLive({ worker_pid: String(process.pid), worker_start_ticks: "1", worker_boot_id: boot }), false);
  assert.equal(await endpointIsLive({ worker_pid: String(process.pid), worker_start_ticks: ticks, worker_boot_id: "0".repeat(36) }), false);
  assert.equal(await endpointIsLive({ worker_pid: String(process.pid) }), null);
  const rows = Array.from({ length: 9 }, (_, i) => record({ id: `slice-${i}`, state: "working", inFlight: true, endpointLive: true }));
  assert.equal((await projectWork(rows, emptyAgentState())).activeReviewRequired, true);
  assert.equal((await projectWork(rows.map((row) => ({ ...row, state: "done" })), emptyAgentState())).activeReviewRequired, false);
  const shared = await projectWork(rows.map((row) => ({ ...row, executionFingerprint: "same-incarnation" })), emptyAgentState());
  assert.equal(shared.activeWorkerCount, 1);
  assert.equal(shared.activeReviewRequired, false, "one endpoint copied into nine slices is not nine concurrent workers");
});

test("origin-guarded presentation endpoint is idempotent, exact and cannot change Firstmate status", async (context) => {
  const home = await temporary(context); await mkdir(path.join(home, "data")); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- Product - Product work\n");
  await writeFile(path.join(home, "data/backlog.md"), "## In flight\n- [ ] one - Slice (repo: /synthetic/product)\n");
  const status = "done [at=1]: ready for review\n"; await writeFile(path.join(home, "state/one.status"), status);
  const stateFile = `${home}-presentation.json`; const owner = createAgentStateOwner(stateFile);
  context.after(() => rm(stateFile, { force: true }));
  const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: stateFile }, { revisionResolver: { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await (await fetch(`${origin}/api/dashboard`)).json()).fleet.workSplit;
  const item = (await get()).items[0];
  const body = { action: "acknowledge", taskFingerprint: item.taskFingerprint, completionFingerprint: item.completionFingerprint };
  const post = (payload, from = origin) => fetch(`${origin}/api/work-state`, { method: "POST", headers: { origin: from, "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal((await post(body, "https://evil.invalid")).status, 403);
  const ack = await (await post(body)).json(); assert.deepEqual(await (await post(body)).json(), ack);
  assert.equal((await get()).items[0].status, "previously-done");
  assert.equal(await readFile(path.join(home, "state/one.status"), "utf8"), status);
  assert.equal((await post({ action: "create-taxonomy", taskFingerprint: item.taskFingerprint, laneName: "UI", themeName: "Iteration 1", kind: "iteration" })).status, 200);
  assert.equal((await get()).items[0].lane.name, "UI");
  assert.equal((await get()).items[0].theme.name, "Iteration 1");
  await writeFile(path.join(home, "state/one.status"), status + "working [at=2]: rerun\ndone [at=3]: renewed\n");
  assert.equal((await post(body)).status, 409); assert.equal((await get()).items[0].status, "newly-done");
  assert.equal(Object.keys((await owner.read()).acknowledgements).length, 1);
  await writeFile(stateFile, "bad");
  const fallback = await get(); assert.match(fallback.warning, /unavailable/); assert.equal(fallback.items[0].lane.id, "unclassified");
  assert.equal(fallback.items[0].completionAttention, "unknown", "unreadable acknowledgements cannot establish freshness");
  assert.equal(fallback.counts["newly-done"], 0);
  assert.equal((await post(body)).status, 409);
  assert.equal(JSON.stringify(fallback).includes(home), false);
});

test("exact alias mappings are explicit, unambiguous and stable across dispatch", async () => {
  const state = taxonomy(); state.repositories[0].aliases = ["Product"];
  const queued = (await projectWork([record({ repositoryPath: "Product", state: "active", queued: true })], state)).items[0];
  const dispatched = (await projectWork([record()], state)).items[0];
  assert.equal(queued.taskFingerprint, dispatched.taskFingerprint);
  assert.equal(queued.repositoryId, dispatched.repositoryId);
  const unknown = (await projectWork([record({ repositoryPath: "Product-feature" })], state)).items[0];
  assert.equal(unknown.repositoryId, "unknown", "never split names or match substrings");
  state.repositories.push({ id: "other", name: "Other", path: "/other", aliases: ["Product"], lanes: [] });
  assert.throws(() => validateAgentState(state), /aliases/);
});

test("keyed resolution folds current work without implicit closure by done or acknowledgement", async () => {
  const lines = ["working [at=1]: run", "needs-decision [at=2]: [key=choice] choose", "done [at=3]: candidate ready"];
  const unresolved = foldStatusLines(lines);
  assert.equal(unresolved.pendingIssues.length, 1);
  const first = record({ state: unresolved.latest.state, pendingIssues: unresolved.pendingIssues });
  const projected = (await projectWork([first], emptyAgentState())).items[0];
  assert.equal(projected.status, "captain-action");
  assert.equal(projected.completionAttention, "newly-done");
  const state = emptyAgentState(); state.acknowledgements[projected.completionFingerprint] = { taskFingerprint: projected.taskFingerprint, acknowledgedAt: new Date().toISOString() };
  const acknowledged = (await projectWork([first], state)).items[0];
  assert.equal(acknowledged.status, "captain-action");
  assert.equal(acknowledged.completionAttention, "previously-done");
  assert.equal(foldStatusLines([...lines, "resolved [at=4]: [key=wrong] other"]).pendingIssues.length, 1);
  const resolved = foldStatusLines([...lines, "resolved [at=5]: [key=choice] answer recorded"]);
  assert.equal(resolved.pendingIssues.length, 0); assert.equal(resolved.latest.state, "done");
  const resumed = foldStatusLines(["working: run", "paused [key=release]: waiting", "resolved [key=release]: released"]);
  assert.equal(resumed.latest.state, "working");
  const preserved = (await projectWork([record({ retained: true })], emptyAgentState())).items[0];
  assert.equal(preserved.status, "cleanup"); assert.equal(preserved.completionAttention, "newly-done");
});

test("completion evidence is bound to the exact source record, never a stale task-level head", async (context) => {
  const home = await temporary(context); await mkdir(path.join(home, "data")); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- product - Work\n");
  await writeFile(path.join(home, "data/backlog.md"), "## In flight\n- [ ] one - Work (repo: /synthetic/product)\n");
  await writeFile(path.join(home, "state/one.status"), "done [at=1]: first\n");
  await writeFile(path.join(home, "state/one.meta"), `project=/synthetic/product\ncompletion_commit=${"a".repeat(40)}\n`);
  const owner = createAgentStateOwner(path.join(home, "presentation.json")); await owner.update((state) => Object.assign(state, taxonomy()));
  let calls = 0;
  const read = async () => (await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async (repo, commit) => { calls++; return [{ badge: "remote UAT", commit, head: "b".repeat(40), destination: "refs/heads/uat" }]; } })).workSplit;
  const unbound = (await read()).items[0]; assert.equal(unbound.status, "newly-done"); assert.equal(calls, 0); assert.equal(unbound.unboundCommit, true);
  await owner.update((state) => { state.completionRecords = { [unbound.completionSourceFingerprint]: { taskFingerprint: unbound.taskFingerprint, commit: "a".repeat(40) } }; });
  const bound = (await read()).items[0]; assert.equal(bound.status, "previously-done"); assert.equal(calls, 1);
  await writeFile(path.join(home, "state/one.status"), "done [at=1]: first\nworking [at=2]: rerun\ndone [at=3]: second\n");
  const renewed = (await read()).items[0]; assert.equal(renewed.status, "newly-done"); assert.equal(calls, 1, "old bound commit cannot prove the new completion durable");
});

test("latest configured production success is live; older/inactive deployment is not", async () => {
  const commit = "a".repeat(40), repo = { path: "/fixture", github: "owner/product", destinations: [{ environment: "Production", tier: "production" }] };
  const authority = (sha = commit, status = "success") => async (command, args) => {
    if (command === "git") throw new Error("No remote evidence");
    return { stdout: JSON.stringify(args[1].includes("deployments?") ? [{ id: 1, sha, environment: "Production" }] : [{ id: 2, state: status, environment: "Production" }]) };
  };
  const proof = await verifyDurability(repo, commit, null, authority());
  assert.equal(proof[0].badge, "Live production");
  assert.equal((await projectWork([record({ commit })], taxonomy(), { durability: async () => proof })).items[0].delivery, "Live production");
  assert.deepEqual(await verifyDurability(repo, commit, null, authority("b".repeat(40))), []);
  assert.deepEqual(await verifyDurability(repo, commit, null, authority(commit, "inactive")), []);
});

test("work hierarchy statusAbbreviations maps all statusLabels to distinct single-character abbreviations", async () => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8"), context);
  const { statusLabels, statusAbbreviations } = context.window.workHierarchy;
  assert.ok(statusAbbreviations);
  const keys = Object.keys(statusLabels);
  assert.equal(Object.keys(statusAbbreviations).length, keys.length);
  for (const k of keys) {
    const abbr = statusAbbreviations[k];
    assert.equal(typeof abbr, "string");
    assert.equal(abbr.length, 1);
    assert.match(abbr, /^[A-Z]$/);
  }
  assert.equal(new Set(Object.values(statusAbbreviations)).size, keys.length);
  assert.equal(statusAbbreviations.active, "A");
  assert.equal(statusAbbreviations.waiting, "W");
  assert.equal(statusAbbreviations["captain-action"], "C");
  assert.equal(statusAbbreviations.cleanup, "R");
  assert.equal(statusAbbreviations.unknown, "U");
  assert.equal(statusAbbreviations.backlog, "B");
  assert.equal(statusAbbreviations["newly-done"], "N");
  assert.equal(statusAbbreviations["previously-done"], "P");
});

test("work hierarchy statusConciseLabels maps all statusLabels to readable concise labels for buttons", async () => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8"), context);
  const { statusLabels, statusConciseLabels } = context.window.workHierarchy;
  assert.ok(statusConciseLabels);
  const keys = Object.keys(statusLabels);
  assert.equal(Object.keys(statusConciseLabels).length, keys.length);
  for (const k of keys) {
    const concise = statusConciseLabels[k];
    assert.equal(typeof concise, "string");
    assert.ok(concise.length > 0);
  }
  assert.equal(statusConciseLabels.active, "Active");
  assert.equal(statusConciseLabels.waiting, "Waiting");
  assert.equal(statusConciseLabels["captain-action"], "Captain action");
  assert.equal(statusConciseLabels.cleanup, "Cleanup");
  assert.equal(statusConciseLabels.unknown, "Unknown");
  assert.equal(statusConciseLabels.backlog, "Backlog");
  assert.equal(statusConciseLabels["newly-done"], "Newly done");
  assert.equal(statusConciseLabels["previously-done"], "Previously done");
});
