import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentStateOwner, emptyAgentState, fingerprint } from "../agent-state.js";
import { resolveRepositoryIdentity } from "../work-model.js";
import { createServer, loadFirstmateHome } from "../server.js";

async function fixture(context) {
  const lab = path.resolve(import.meta.dirname, "../../.taxonomy-lab");
  await mkdir(lab, { recursive: true });
  const home = await mkdtemp(path.join(lab, "backlog-repositories-"));
  const stateFile = `${home}-state.json`;
  context.after(async () => { await rm(home, { recursive: true, force: true }); await rm(stateFile, { force: true }); });
  await Promise.all(["data", "state", "projects/billblink"].map((directory) => mkdir(path.join(home, directory), { recursive: true })));
  await writeFile(path.join(home, "data/projects.md"), "- billblink - Billing project\n- firstmate - Home project\n- registry-only - No clone\n");
  await writeFile(path.join(home, "data/backlog.md"), [
    "## Queued",
    "- [ ] billing - Billing work (repo: billblink)",
    "- [ ] uppercase - Invoice export (repo: BILLBLINK)",
    "- [ ] home-work - Home work (repo: firstmate)",
    "- [ ] unknown - Unknown project (repo: no-such-project)",
    "- [ ] unspecified - No repo field",
    "- [ ] registry-only - No clone (repo: registry-only)",
    "## In flight",
    "- [ ] runtime - Running billing work (repo: billblink)",
    "",
  ].join("\n"));
  const repositoryPath = path.join(home, "projects/billblink");
  await writeFile(path.join(home, "state/runtime.meta"), `project=${repositoryPath}\n`);
  const owner = createAgentStateOwner(stateFile);
  const read = async () => (await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async () => [] })).workSplit;
  return { home, repositoryPath, stateFile, owner, read };
}

test("bare backlog names resolve to home clones and share runtime identity without losing saved taxonomy", async (context) => {
  const { home, repositoryPath, stateFile, owner, read } = await fixture(context);
  const taskFingerprint = fingerprint("task.v1", repositoryPath, "billing");
  await owner.update((state) => {
    state.repositories.push({ id: "saved-billing", name: "Billing", path: repositoryPath, lanes: [{ id: "ui", name: "Interface", themes: [{ id: "r1", name: "Iteration", kind: "iteration" }] }] });
    state.assignments[taskFingerprint] = { repositoryId: "saved-billing", laneId: "ui", themeId: "r1" };
  });
  const saved = await readFile(stateFile, "utf8");
  const beforeDispatch = await read();
  const byId = new Map(beforeDispatch.items.map((item) => [item.id, item]));
  for (const id of ["billing", "uppercase"]) {
    assert.equal(byId.get(id).repositoryId, byId.get("runtime").repositoryId);
    assert.equal(byId.get(id).taskFingerprint, fingerprint("task.v1", repositoryPath, id));
    assert.equal(byId.get(id).repository, "Billing");
  }
  assert.equal(byId.get("billing").lane.id, "ui");
  assert.equal(byId.get("billing").theme.id, "r1");
  assert.equal(byId.get("home-work").taskFingerprint, fingerprint("task.v1", home, "home-work"));
  for (const id of ["unknown", "unspecified", "registry-only"]) assert.equal(byId.get(id).repositoryId, "unknown");
  assert.equal(beforeDispatch.repositories.length, 3);
  assert.equal(await readFile(stateFile, "utf8"), saved, "projection never rewrites the saved state");
  await writeFile(path.join(home, "state/billing.meta"), `project=${repositoryPath}\n`);
  const dispatched = (await read()).items.find((item) => item.id === "billing");
  assert.equal(dispatched.taskFingerprint, taskFingerprint);
  assert.equal(dispatched.repositoryId, byId.get("billing").repositoryId);
  assert.equal(dispatched.lane.id, "ui");
  assert.equal(await readFile(stateFile, "utf8"), saved);
});

test("repository lookup preserves absolute paths and explicit aliases, and refuses ambiguous or non-bare names", () => {
  const state = emptyAgentState();
  state.repositories.push({ id: "saved", name: "Saved", path: "/synthetic/approved", aliases: ["billblink", "firstmate"], lanes: [] });
  const paths = new Map([["billblink", "/synthetic/fm-home/projects/billblink"], ["Case", "/synthetic/fm-home/projects/Case"], ["case", "/synthetic/fm-home/projects/case"], ["firstmate", "/synthetic/fm-home"]]);
  const resolve = (name) => resolveRepositoryIdentity(name, state, paths).repositoryPath;
  assert.equal(resolve("billblink"), "/synthetic/approved", "explicit aliases retain their identity");
  assert.equal(resolve("firstmate"), "/synthetic/approved", "the home name also respects exact aliases");
  assert.equal(resolve("/synthetic/approved/../approved"), "/synthetic/approved");
  assert.equal(resolve("BILLBLINK"), "/synthetic/fm-home/projects/billblink");
  assert.equal(resolve("FIRSTMATE"), "/synthetic/fm-home");
  assert.equal(resolve("Case"), "/synthetic/fm-home/projects/Case");
  for (const name of ["CASE", "absent", "billblink-feature", "../billblink", "projects/billblink", "billblink\\child", ".", "..", null]) assert.equal(resolve(name), null, String(name));
});

test("classification writes use the same bare-name identity and reuse saved repositories", async (context) => {
  const { home, repositoryPath, stateFile, owner } = await fixture(context);
  const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: stateFile }, {
    revisionResolver: { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) },
    durabilityVerifier: async () => [],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await (await fetch(`${origin}/api/dashboard`)).json()).fleet.workSplit;
  const post = (body) => fetch(`${origin}/api/work-state`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const item = (await get()).items.find((entry) => entry.id === "billing");
  const create = { action: "create-taxonomy", taskFingerprint: item.taskFingerprint, laneName: "Interface", themeName: "Iteration", kind: "iteration" };
  assert.equal((await post(create)).status, 200);
  assert.equal((await post(create)).status, 200);
  const state = await owner.read();
  assert.equal(state.repositories.length, 1);
  assert.equal(state.repositories[0].path, repositoryPath);
  assert.equal(state.repositories[0].lanes.length, 1);
  assert.equal(state.repositories[0].lanes[0].themes.length, 1);
  assert.equal(Object.keys(state.assignments).length, 1);
  const projected = (await get()).items.find((entry) => entry.id === "billing");
  assert.equal(projected.taskFingerprint, item.taskFingerprint);
  assert.equal(projected.lane.name, "Interface");
  assert.equal((await post({ action: "classify", taskFingerprint: item.taskFingerprint, laneId: projected.lane.id, themeId: projected.theme.id })).status, 200);
  await writeFile(path.join(home, "state/billing.meta"), `project=${repositoryPath}\n`);
  assert.equal((await get()).items.find((entry) => entry.id === "billing").lane.name, "Interface");
  assert.equal((await owner.read()).repositories.length, 1);
});

test("saved firstmate aliases preserve taxonomy, completion bindings and acknowledgements through writes and dispatch", async (context) => {
  const { home, repositoryPath, stateFile, owner, read } = await fixture(context);
  const taskFingerprint = fingerprint("task.v1", repositoryPath, "home-work");
  const status = "done [at=1700000000]: Home work complete";
  const completionIdentity = { source: "status", line: status, occurrence: 0, doneDate: null };
  const completionSourceFingerprint = fingerprint("completion-source.v1", taskFingerprint, completionIdentity);
  const commit = "b".repeat(40);
  const completionFingerprint = fingerprint("completion.v1", taskFingerprint, completionIdentity, commit);
  const acknowledgedAt = "2023-11-15T00:00:00.000Z";
  await owner.update((state) => {
    state.repositories.push({ id: "approved", name: "Approved", path: repositoryPath, aliases: ["firstmate"], lanes: [{ id: "ui", name: "Interface", themes: [{ id: "r1", name: "Iteration", kind: "iteration" }] }] });
    state.assignments[taskFingerprint] = { repositoryId: "approved", laneId: "ui", themeId: "r1" };
    state.completionRecords = { [completionSourceFingerprint]: { taskFingerprint, commit } };
    state.acknowledgements[completionFingerprint] = { taskFingerprint, acknowledgedAt };
  });
  const saved = await readFile(stateFile, "utf8");
  const queued = (await read()).items.find((item) => item.id === "home-work");
  assert.equal(queued.taskFingerprint, taskFingerprint);
  assert.equal(queued.repository, "Approved");
  assert.equal(queued.lane.id, "ui");
  assert.equal(queued.theme.id, "r1");
  assert.equal(await readFile(stateFile, "utf8"), saved);

  await writeFile(path.join(home, "state/home-work.status"), `${status}\n`);
  const probes = [];
  const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: stateFile }, {
    revisionResolver: { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) },
    durabilityVerifier: async (repository, boundCommit) => { probes.push([repository?.path, boundCommit]); return []; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await (await fetch(`${origin}/api/dashboard`)).json()).fleet.workSplit.items.find((item) => item.id === "home-work");
  const post = (body) => fetch(`${origin}/api/work-state`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ...body, taskFingerprint }) });
  for (const dispatched of [false, true]) {
    if (dispatched) await writeFile(path.join(home, "state/home-work.meta"), `project=${repositoryPath}\n`);
    const item = await get();
    assert.equal(item.taskFingerprint, taskFingerprint);
    assert.equal(item.repositoryId, queued.repositoryId);
    assert.equal(item.lane.id, "ui");
    assert.equal(item.theme.id, "r1");
    assert.equal(item.completionSourceFingerprint, completionSourceFingerprint);
    assert.equal(item.completionFingerprint, completionFingerprint);
    assert.equal(item.completionAttention, "previously-done");
    assert.equal(item.evidence[0].acknowledgedAt, acknowledgedAt);
    assert.equal((await post({ action: "classify", laneId: "ui", themeId: "r1" })).status, 200);
    assert.equal((await post({ action: "create-taxonomy", laneName: "Interface", themeName: "Iteration", kind: "iteration" })).status, 200);
    assert.equal((await post({ action: "acknowledge", completionFingerprint })).status, 200);
    assert.equal(await readFile(stateFile, "utf8"), saved, "writes reuse the saved alias identity and exact completion");
  }
  assert.ok(probes.length > 0);
  for (const probe of probes) assert.deepEqual(probe, [repositoryPath, commit]);
});
